// Claude via the official SDK. Two models: a small fast one for routing, claim extraction and
// re-checks (structured JSON output, low effort, tight timeouts), and a larger one that writes
// the answer the user reads (streamed).

import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../config.ts";
import type { NewClaim } from "../db.ts";
import {
  ANSWER_SYSTEM, EXTRACT_SCHEMA, EXTRACT_SYSTEM, RECHECK_SCHEMA, RECHECK_SYSTEM, ROUTER_SCHEMA, ROUTER_SYSTEM,
  renderAnswerTurn, renderRecheck, renderRouteInput, renderSources,
} from "./prompts.ts";
import type { AnswerInput, LLM, RecheckResult, RouteInput, RoutePlan } from "./types.ts";

export interface AnthropicOptions {
  apiKey: string;
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
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2 });
    this.name = `anthropic (${opts.answerModel} + ${opts.fastModel})`;
  }

  /** One structured-output call to the small model; returns the parsed JSON. */
  private async json<T>(system: string, user: string, schema: object, timeoutMs: number, maxTokens = 2048): Promise<T> {
    const res = await this.client.messages.create(
      {
        model: this.opts.fastModel,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { effort: "low", format: { type: "json_schema", schema: schema as Record<string, unknown> } },
      },
      { timeout: timeoutMs, maxRetries: 1 },
    );
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

  async *streamAnswer(input: AnswerInput): AsyncIterable<string> {
    const history: Anthropic.Beta.BetaMessageParam[] = input.history.map((m) => ({ role: m.role, content: m.content }));
    const effort: Effort = input.intent === "chat" || input.intent === "recall" ? "low" : this.opts.answerEffort;
    const stream = this.client.beta.messages.stream(
      {
        model: this.opts.answerModel,
        max_tokens: 16000,
        system: [{ type: "text", text: ANSWER_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [...history, { role: "user", content: renderAnswerTurn(input) }],
        output_config: { effort },
        // If the answer model declines, the API re-runs the request on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        ...(this.opts.fastSpeed ? { speed: "fast" as const } : {}),
      },
      { signal: input.signal },
    );
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield event.delta.text;
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") yield "\n\nI can't help with that one.";
    if (final.stop_reason === "max_tokens") yield "\n\n(Answer cut short: it hit the length limit.)";
  }

  async extractClaims(input: { question: string; answer: string; sources: { n: number; url: string; publishedDate?: string }[] }): Promise<NewClaim[]> {
    const r = await this.json<{ claims: Array<{ subject: string; attribute: string; value: string; unit: string; source_n: number }> }>(
      EXTRACT_SYSTEM,
      `<question>${input.question}</question>\n\n<answer>\n${input.answer}\n</answer>`,
      EXTRACT_SCHEMA, 20000, 4096,
    );
    return r.claims.slice(0, 12).map((c) => {
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
      RECHECK_SYSTEM, renderRecheck(input.claims, input.sources), RECHECK_SCHEMA, 15000, 4096,
    );
    return input.claims.map((_, i) => {
      const hit = r.results.find((x) => x.fact === i + 1);
      if (!hit || !hit.found || !hit.value.trim()) return null;
      if (!input.sources.some((s) => s.n === hit.source_n)) return null; // must point at a real result
      return { value: hit.value.trim(), unit: hit.unit.trim() || null, sourceN: hit.source_n };
    });
  }
}

// Exported for tests that want to see exactly what the model is sent.
export { renderAnswerTurn, renderSources };
