// Claude via the official SDK. Two models: a small fast one for routing, claim extraction and
// re-checks (structured JSON output, low effort, tight timeouts), and a larger one that writes
// the answer the user reads (streamed).

import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../config.ts";
import { pageAge } from "../search/anthropic.ts";
import type { UsageMeter } from "../usage.ts";
import type { NewClaim } from "../db.ts";
import {
  ANSWER_SYSTEM, EXTRACT_SCHEMA, EXTRACT_SYSTEM, RECHECK_SCHEMA, RECHECK_SYSTEM, ROUTER_SCHEMA, ROUTER_SYSTEM,
  renderAnswerTurn, renderRecheck, renderRouteInput,
} from "./prompts.ts";
import type { AnswerEvent, AnswerInput, LLM, RecheckResult, RouteInput, RoutePlan } from "./types.ts";

export interface AnthropicOptions {
  client: Anthropic;
  meter?: UsageMeter;
  answerModel: string;
  fastModel: string;
  answerEffort: Effort;
  /** Fast output mode on the answer model (higher price, faster tokens). */
  fastSpeed: boolean;
}

export class AnthropicLLM implements LLM {
  readonly name: string;
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicOptions) {
    this.client = opts.client;
    this.name = `anthropic (${opts.answerModel} + ${opts.fastModel})`;
  }

  /** One structured-output call to the small model; returns the parsed JSON. */
  private async json<T>(system: string, user: string, schema: object, timeoutMs: number, maxTokens = 2048, signal?: AbortSignal): Promise<T> {
    this.opts.meter?.check();
    const res = await this.client.messages.create(
      {
        model: this.opts.fastModel,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { effort: "low", format: { type: "json_schema", schema: schema as Record<string, unknown> } },
      },
      { timeout: timeoutMs, maxRetries: 1, signal },
    );
    this.opts.meter?.add(this.opts.fastModel, res.usage);
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") throw new Error(`small model stopped: ${res.stop_reason}`);
    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("small model returned no text");
    return JSON.parse(text.text) as T;
  }

  async route(input: RouteInput): Promise<Omit<RoutePlan, "via">> {
    const r = await this.json<{ intent: RoutePlan["intent"]; search_queries: string[]; since_days: number; memory_query: string; high_stakes: boolean }>(
      ROUTER_SYSTEM, renderRouteInput(input), ROUTER_SCHEMA, 4000, 1024,
    );
    return {
      intent: r.intent,
      searchQueries: r.search_queries,
      sinceDays: Math.max(0, Math.min(365, r.since_days | 0)),
      memoryQuery: r.memory_query,
      highStakes: r.high_stakes,
    };
  }

  /**
   * Streams the answer. When `maxSelfSearches` > 0 (only when the agent's planned searches found
   * nothing) the model also gets Anthropic's server-side web_search tool, capped at that many uses.
   * Otherwise it has no tool and writes only from the gathered sources, so text starts at once. The searches run inside this one streamed request (no extra round
   * trips from us); we surface what it searched, the pages it found and the passages it cited.
   */
  async *streamAnswer(input: AnswerInput): AsyncIterable<AnswerEvent> {
    const history: Anthropic.Beta.BetaMessageParam[] = input.history.map((m) => ({ role: m.role, content: m.content }));
    this.opts.meter?.check();
    const effort: Effort = input.intent === "chat" || input.intent === "recall" ? "low" : this.opts.answerEffort;
    const tools: Anthropic.Beta.BetaToolUnion[] =
      input.maxSelfSearches > 0 ? [{ type: "web_search_20260209", name: "web_search", max_uses: input.maxSelfSearches }] : [];
    const stream = this.client.beta.messages.stream(
      {
        model: this.opts.answerModel,
        max_tokens: 16000,
        system: [{ type: "text", text: ANSWER_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [...history, { role: "user", content: renderAnswerTurn(input) }],
        output_config: { effort },
        ...(tools.length ? { tools } : {}),
        // If the answer model declines, the API re-runs the request on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        ...(this.opts.fastSpeed ? { speed: "fast" as const } : {}),
      },
      { signal: input.signal },
    );
    const toolInputs = new Map<number, string>(); // server_tool_use block index -> partial JSON input
    let pendingCites: Array<{ url: string; title: string | null; citedText: string }> = [];
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "server_tool_use" && block.name === "web_search") toolInputs.set(event.index, "");
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) {
            yield { type: "source", result: { title: r.title, url: r.url, snippet: "", publishedDate: pageAge(r.page_age) } };
          }
        }
      } else if (event.type === "content_block_delta") {
        const d = event.delta;
        if (d.type === "text_delta") yield { type: "text", text: d.text };
        else if (d.type === "input_json_delta" && toolInputs.has(event.index)) toolInputs.set(event.index, toolInputs.get(event.index)! + d.partial_json);
        else if (d.type === "citations_delta" && d.citation.type === "web_search_result_location") {
          pendingCites.push({ url: d.citation.url, title: d.citation.title, citedText: d.citation.cited_text });
        }
      } else if (event.type === "content_block_stop") {
        if (toolInputs.has(event.index)) {
          const query = safeQuery(toolInputs.get(event.index)!);
          toolInputs.delete(event.index);
          if (query) yield { type: "searching", query };
        }
        // Citations arrive with the cited text block; emit them at its end so the [n] follows the claim.
        for (const c of pendingCites) yield { type: "cite", ...c };
        pendingCites = [];
      }
    }
    const final = await stream.finalMessage();
    this.opts.meter?.add(final.model, final.usage);
    if (final.stop_reason === "refusal") yield { type: "text", text: "\n\nI can't help with that one." };
    if (final.stop_reason === "max_tokens") yield { type: "text", text: "\n\n(Answer cut short: it hit the length limit.)" };
    if (final.stop_reason === "pause_turn") yield { type: "text", text: "\n\n(I stopped searching here to keep this fast; ask me to dig further.)" };
  }

  async extractClaims(input: { question: string; answer: string; sources: { n: number; url: string; publishedDate?: string }[] }): Promise<NewClaim[]> {
    const r = await this.json<{ claims: Array<{ subject: string; attribute: string; value: string; unit: string; source_n: number }> }>(
      EXTRACT_SYSTEM,
      `<question>${input.question}</question>\n\n<answer>\n${input.answer}\n</answer>`,
      EXTRACT_SCHEMA, 20000, 4096,
    );
    return r.claims.slice(0, 24).map((c) => {
      const src = input.sources.find((s) => s.n === c.source_n);
      return {
        subject: c.subject, attribute: c.attribute, value: c.value, unit: c.unit || null,
        sourceUrl: src?.url ?? null, sourceDate: src?.publishedDate ?? null,
      };
    });
  }

  async recheck(input: Parameters<LLM["recheck"]>[0]): Promise<Array<RecheckResult | null>> {
    if (input.claims.length === 0) return [];
    if (input.sources.length === 0) return input.claims.map(() => null);
    const r = await this.json<{ results: Array<{ fact: number; found: boolean; value: string; unit: string; source_n: number }> }>(
      RECHECK_SYSTEM, renderRecheck(input.claims, input.sources), RECHECK_SCHEMA, 15000, 4096, input.signal,
    );
    return input.claims.map((_, i) => {
      const hit = r.results.find((x) => x.fact === i + 1);
      if (!hit || !hit.found || !hit.value.trim()) return null;
      if (!input.sources.some((s) => s.n === hit.source_n)) return null; // must point at a real result
      return { value: hit.value.trim(), unit: hit.unit.trim() || null, sourceN: hit.source_n };
    });
  }
}

function safeQuery(json: string): string | null {
  try {
    const q = (JSON.parse(json) as { query?: unknown }).query;
    return typeof q === "string" ? q : null;
  } catch {
    return null;
  }
}

