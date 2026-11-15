// Counts what the Anthropic calls cost, per process, and enforces an optional spend cap
// (MAX_SPEND_USD). Prices are USD per million tokens (Anthropic list prices, Nov 2026).

const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const WEB_SEARCH_USD = 10 / 1000; // per search

export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

export class BudgetExceededError extends Error {}

export class UsageMeter {
  costUsd = 0;
  calls = 0;
  webSearches = 0;
  readonly byModel = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();

  constructor(readonly limitUsd: number | null = null) {}

  add(model: string, u: UsageLike | null | undefined): void {
    if (!u) return;
    this.calls++;
    const price = PRICES[model] ?? { input: 5, output: 25 }; // unknown model: assume Opus-tier, never under-count
    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const searches = u.server_tool_use?.web_search_requests ?? 0;
    this.webSearches += searches;
    this.costUsd +=
      (input * price.input + output * price.output + cacheWrite * price.input * 1.25 + cacheRead * price.input * 0.1) / 1e6 +
      searches * WEB_SEARCH_USD;
    const m = this.byModel.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    m.input += input;
    m.output += output;
    m.cacheRead += cacheRead;
    m.cacheWrite += cacheWrite;
    this.byModel.set(model, m);
  }

  /** Called before every paid request. */
  check(): void {
    if (this.limitUsd !== null && this.costUsd >= this.limitUsd) {
      throw new BudgetExceededError(`Spend cap reached ($${this.costUsd.toFixed(2)} of $${this.limitUsd.toFixed(2)}).`);
    }
  }

  summary(): string {
    const models = [...this.byModel.entries()].map(([m, u]) => `${m}: ${u.input} in / ${u.output} out / ${u.cacheRead} cache-read`).join("; ");
    return `$${this.costUsd.toFixed(4)} over ${this.calls} calls, ${this.webSearches} web searches (${models})`;
  }
}
