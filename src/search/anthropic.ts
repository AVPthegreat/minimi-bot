// Search through Anthropic's server-side web_search tool: needs only the Anthropic key.
// The tool returns titles, URLs and page ages; the page text itself is encrypted, so a small model runs
// the search and quotes the relevant lines, and its citations give us the verbatim `cited_text` per URL
// (our snippets). ONE query = ONE small call with exactly one web_search, so the agent's plan (one
// search per product) is what actually runs, the calls run in parallel, and every snippet the answer
// model later sees came from a search the agent asked for. (An earlier version batched all queries
// into one call; the model then ran its own choice of searches, one after another.)

import type Anthropic from "@anthropic-ai/sdk";
import type { UsageMeter } from "../usage.ts";
import type { SearchOptions, SearchProvider, SearchResult } from "./types.ts";

const SYSTEM = `You are a search backend, not an assistant. Run exactly one web_search with the query text as given. Then write short bullet points that quote the most relevant lines from the results verbatim: prices with their plan names and units, version numbers, dates, announcements. Every bullet must be a quotation from a result. No commentary, no advice.`;

export class AnthropicWebSearch implements SearchProvider {
  readonly name = "anthropic-web-search";

  constructor(
    private readonly client: Pick<Anthropic, "messages">,
    private readonly model: string,
    private readonly meter?: UsageMeter,
    private readonly timeoutMs = 30000,
  ) {}

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    this.meter?.check();
    const since = opts.sinceDays ? ` (only results from the last ${opts.sinceDays} days)` : "";
    const res = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 2048,
        system: SYSTEM,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
        messages: [{ role: "user", content: `Query: ${query}${since}` }],
        output_config: { effort: "low" },
      },
      { signal: opts.signal, timeout: this.timeoutMs, maxRetries: 1 },
    );
    this.meter?.add(this.model, res.usage);

    const byUrl = new Map<string, SearchResult>();
    let errors = 0;
    for (const block of res.content) {
      if (block.type !== "web_search_tool_result") continue;
      // Tool errors come back as HTTP 200 with an error object instead of a result list.
      if (!Array.isArray(block.content)) {
        errors++;
        continue;
      }
      for (const r of block.content) {
        if (!byUrl.has(r.url)) byUrl.set(r.url, { title: r.title, url: r.url, snippet: "", publishedDate: pageAge(r.page_age) });
      }
    }
    if (errors && byUrl.size === 0) throw new Error("web_search failed");
    for (const block of res.content) {
      if (block.type !== "text" || !block.citations) continue;
      for (const c of block.citations) {
        if (c.type !== "web_search_result_location") continue;
        const r = byUrl.get(c.url);
        if (r && !r.snippet.includes(c.cited_text)) r.snippet = `${r.snippet} ${c.cited_text}`.trim().slice(0, 1500);
      }
    }
    // Quoted results first (they have text the answer model can cite), then title-only ones.
    const all = [...byUrl.values()];
    const ranked = [...all.filter((r) => r.snippet), ...all.filter((r) => !r.snippet).map((r) => ({ ...r, snippet: r.title }))];
    return ranked.slice(0, opts.maxResults ?? 6).map((r, j) => ({ ...r, score: r.snippet === r.title ? 0.3 : 0.9 - j * 0.05 }));
  }
}

/** Anthropic's `page_age` ("April 30, 2026") as an ISO date, when it parses. */
export function pageAge(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}
