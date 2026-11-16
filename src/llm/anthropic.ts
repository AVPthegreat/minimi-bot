// Claude via the official SDK. Two models: a small fast one for routing, claim extraction and
// re-checks (structured JSON output, low effort, tight timeouts), and a larger one that writes
// the answer the user reads (streamed).

import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../config.ts";
import type { UsageMeter } from "../usage.ts";
import type { NewClaim } from "../db.ts";
import {
  ANSWER_SYSTEM, EXTRACT_SCHEMA, EXTRACT_SYSTEM, RECHECK_SCHEMA, RECHECK_SYSTEM, ROUTER_SCHEMA, ROUTER_SYSTEM,
  renderAnswerTurn, renderRecheck, renderRouteInput, renderToolResult,
} from "./prompts.ts";
import type { AnswerEvent, AnswerInput, LLM, RecheckResult, RouteInput, RoutePlan, ToolRound } from "./types.ts";

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
   * One step of the agent loop: streams the answer, or ends with web_search tool calls that the agent
   * runs itself (with its own search provider, so every page joins the turn's sources and the grounding
   * guard). The tool is defined whenever the turn has a search budget or earlier tool rounds; with no
   * budget left it is switched off (tool_choice none), so the model must answer from what it has.
   */
  async *streamAnswer(input: AnswerInput): AsyncIterable<AnswerEvent> {
    const history: Anthropic.Beta.BetaMessageParam[] = input.history.map((m) => ({ role: m.role, content: m.content }));
    this.opts.meter?.check();
    const effort: Effort = input.intent === "chat" || input.intent === "recall" ? "low" : this.opts.answerEffort;
    const withTool = input.maxSelfSearches > 0 || input.rounds.length > 0;
    const stream = this.client.beta.messages.stream(
      {
        model: this.opts.answerModel,
        max_tokens: 16000,
        system: [{ type: "text", text: ANSWER_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [...history, { role: "user", content: renderAnswerTurn(input) }, ...renderRounds(input.rounds)],
        output_config: { effort },
        ...(withTool ? { tools: [WEB_SEARCH_TOOL], tool_choice: input.maxSelfSearches > 0 ? { type: "auto" as const } : { type: "none" as const } } : {}),
        // If the answer model declines, the API re-runs the request on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        ...(this.opts.fastSpeed ? { speed: "fast" as const } : {}),
      },
      { signal: input.signal },
    );
    const toolInputs = new Map<number, { id: string; json: string }>(); // tool_use block index -> id + partial JSON input
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use" && block.name === "web_search") toolInputs.set(event.index, { id: block.id, json: "" });
      } else if (event.type === "content_block_delta") {
        const d = event.delta;
        if (d.type === "text_delta") yield { type: "text", text: d.text };
        else if (d.type === "input_json_delta" && toolInputs.has(event.index)) toolInputs.get(event.index)!.json += d.partial_json;
      } else if (event.type === "content_block_stop") {
        const call = toolInputs.get(event.index);
        if (call) {
          toolInputs.delete(event.index);
          yield { type: "tool_call", id: call.id, query: safeQuery(call.json) ?? "" };
        }
      }
    }
    const final = await stream.finalMessage();
    this.opts.meter?.add(final.model, final.usage);
    // The assistant turn as sent (thinking and text blocks included), replayed in the next round.
    if (final.stop_reason === "tool_use") yield { type: "round_state", state: final.content };
    if (final.stop_reason === "refusal") yield { type: "text", text: "\n\nI can't help with that one." };
    if (final.stop_reason === "max_tokens") yield { type: "text", text: "\n\n(Answer cut short: it hit the length limit.)" };
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

/** The answer model's one tool. The agent runs it (turn/answer.ts), not the API. */
const WEB_SEARCH_TOOL: Anthropic.Beta.BetaTool = {
  name: "web_search",
  description: "Search the web. Returns pages numbered like <sources>, with title, URL, date and a passage. Use it only for gaps the given sources do not cover.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "A specific query: product names, the attribute (pricing, changelog, release notes), the year when freshness matters." } },
    required: ["query"],
  },
};

/** Earlier rounds of the loop: the model's turn (its own blocks when known) and the agent's tool results. */
function renderRounds(rounds: ToolRound[]): Anthropic.Beta.BetaMessageParam[] {
  return rounds.flatMap((r): Anthropic.Beta.BetaMessageParam[] => [
    {
      role: "assistant",
      content: (r.state as Anthropic.Beta.BetaContentBlockParam[] | undefined) ?? [
        ...(r.text.trim() ? [{ type: "text" as const, text: r.text }] : []),
        ...r.calls.map((c) => ({ type: "tool_use" as const, id: c.id, name: "web_search", input: { query: c.query } })),
      ],
    },
    {
      role: "user",
      content: r.results.map((x) => ({ type: "tool_result" as const, tool_use_id: x.id, content: renderToolResult(x), ...(x.error ? { is_error: true } : {}) })),
    },
  ]);
}

function safeQuery(json: string): string | null {
  try {
    const q = (JSON.parse(json) as { query?: unknown }).query;
    return typeof q === "string" ? q : null;
  } catch {
    return null;
  }
}

