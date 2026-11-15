// Tavily: a search API built for LLM agents. One HTTPS call returns ranked results with clean
// content snippets and (for news) publication dates, so we do not need a separate fetch/scrape step.
// Docs: https://docs.tavily.com/documentation/api-reference/endpoint/search

import type { SearchOptions, SearchProvider, SearchResult } from "./types.ts";

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  published_date?: string;
}

export class TavilySearch implements SearchProvider {
  readonly name = "tavily";
  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs = 8000,
  ) {}

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const body: Record<string, unknown> = {
      query,
      max_results: opts.maxResults ?? 6,
      search_depth: opts.depth === "deep" ? "advanced" : "basic",
      include_answer: false,
      include_raw_content: false,
    };
    if (opts.sinceDays !== undefined) {
      // Date filtering is only reliable on the news index.
      body.topic = "news";
      body.days = Math.max(1, Math.ceil(opts.sinceDays));
    }
    const signals = [AbortSignal.timeout(this.timeoutMs)];
    if (opts.signal) signals.push(opts.signal);
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    if (!res.ok) {
      throw new Error(`Tavily search failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { results?: TavilyResult[] };
    return (data.results ?? [])
      .filter((r) => r.url && r.title)
      .map((r) => ({
        title: r.title!,
        url: r.url!,
        snippet: (r.content ?? "").slice(0, 1200),
        publishedDate: r.published_date ? normaliseDate(r.published_date) : undefined,
        score: r.score,
      }));
  }
}

function normaliseDate(s: string): string | undefined {
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}
