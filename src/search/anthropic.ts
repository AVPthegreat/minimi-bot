// Search through Anthropic's server-side web_search tool: needs only the Anthropic key.
// The tool returns result titles, URLs and page ages; the page text itself is encrypted, so we ask
// a small model to run exactly one search and quote the relevant lines. Its citations carry the
// verbatim `cited_text` for each URL, which becomes our snippet. Slower and less controllable than
// a search API (one model call per query, no date filter), but it works with a single key.

import Anthropic from "@anthropic-ai/sdk";
import type { UsageMeter } from "../usage.ts";
import type { SearchOptions, SearchProvider, SearchResult } from "./types.ts";

const SYSTEM = `You are a search backend, not an assistant. Run exactly one web_search for the user's query, then write 3-8 short bullet points that quote the most relevant lines from the results verbatim: prices, plan names, version numbers, dates, announcements. Every bullet must be a quotation from a result. No commentary, no advice.`;

export class AnthropicWebSearch implements SearchProvider {
  readonly name = "anthropic-web-search";

  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
    private readonly meter?: UsageMeter,
    private readonly timeoutMs = 30000,
  ) {}

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    this.meter?.check();
    const recency = opts.sinceDays ? `\nOnly results published in the last ${opts.sinceDays} days matter.` : "";
    const res = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 2048,
        system: SYSTEM,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
        messages: [{ role: "user", content: `Query: ${query}${recency}` }],
        output_config: { effort: "low" },
      },
      { signal: opts.signal, timeout: this.timeoutMs, maxRetries: 1 },
    );
    this.meter?.add(this.model, res.usage);

    const byUrl = new Map<string, SearchResult>();
    for (const block of res.content) {
      if (block.type !== "web_search_tool_result") continue;
      const content = block.content;
      // Tool errors come back as HTTP 200 with an error object instead of a result list.
      if (!Array.isArray(content)) throw new Error(`web_search failed: ${content.error_code}`);
      for (const r of content) {
        if (!byUrl.has(r.url)) byUrl.set(r.url, { title: r.title, url: r.url, snippet: "", publishedDate: pageAge(r.page_age) });
      }
    }
    for (const block of res.content) {
      if (block.type !== "text" || !block.citations) continue;
      for (const c of block.citations) {
        if (c.type !== "web_search_result_location") continue;
        const r = byUrl.get(c.url) ?? { title: c.title ?? c.url, url: c.url, snippet: "" };
        if (!r.snippet.includes(c.cited_text)) r.snippet = `${r.snippet} ${c.cited_text}`.trim().slice(0, 1500);
        byUrl.set(c.url, r);
      }
    }
    // Quoted results first (they have text the answer model can cite), then title-only ones.
    const all = [...byUrl.values()];
    const ranked = [...all.filter((r) => r.snippet), ...all.filter((r) => !r.snippet).map((r) => ({ ...r, snippet: r.title }))];
    return ranked.slice(0, opts.maxResults ?? 6).map((r, i) => ({ ...r, score: r.snippet === r.title ? 0.3 : 0.9 - i * 0.05 }));
  }
}

function pageAge(s: string | null): string | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}
