// Search through Anthropic's server-side web_search tool: needs only the Anthropic key.
// The tool returns titles, URLs and page ages; the page text itself is encrypted, so a small model runs
// the searches and quotes the relevant lines, and its citations give us the verbatim `cited_text` per URL
// (our snippets). All planned queries go into ONE call (max_uses = number of queries), so a 5-product
// comparison costs one model round trip, not five.

import type Anthropic from "@anthropic-ai/sdk";
import type { UsageMeter } from "../usage.ts";
import type { SearchOptions, SearchProvider, SearchResult } from "./types.ts";

const SYSTEM = `You are a search backend, not an assistant. Run one web_search for each numbered query, using the query text as given, in order. Then write short bullet points that quote the most relevant lines from the results verbatim: prices, plan names, version numbers, dates, announcements. Every bullet must be a quotation from a result. No commentary, no advice.`;

type BatchItem = { query: string; opts?: SearchOptions };

export class AnthropicWebSearch implements SearchProvider {
  readonly name = "anthropic-web-search";

  constructor(
    private readonly client: Pick<Anthropic, "messages">,
    private readonly model: string,
    private readonly meter?: UsageMeter,
    private readonly timeoutMs = 45000,
  ) {}

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    return (await this.searchBatch([{ query, opts }], opts.signal))[0]!;
  }

  /** Runs several queries in one model call; returns one result list per query, in order. */
  async searchBatch(items: BatchItem[], signal?: AbortSignal): Promise<SearchResult[][]> {
    this.meter?.check();
    const list = items
      .map((it, i) => `${i + 1}. ${it.query}${it.opts?.sinceDays ? ` (only results from the last ${it.opts.sinceDays} days)` : ""}`)
      .join("\n");
    const res = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 4096,
        system: SYSTEM,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: items.length }],
        messages: [{ role: "user", content: `Queries:\n${list}` }],
        output_config: { effort: "low" },
      },
      { signal, timeout: this.timeoutMs, maxRetries: 1 },
    );
    this.meter?.add(this.model, res.usage);

    // Which planned query did each tool call answer? Exact text first, else the order of the calls.
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const callToItem = new Map<string, number>();
    let order = 0;
    for (const block of res.content) {
      if (block.type !== "server_tool_use" || block.name !== "web_search") continue;
      const q = String((block.input as { query?: unknown }).query ?? "");
      const taken = new Set(callToItem.values());
      const exact = items.findIndex((it, i) => norm(it.query) === norm(q) && !taken.has(i));
      callToItem.set(block.id, exact >= 0 ? exact : Math.min(order, items.length - 1));
      order++;
    }

    const perItem: Array<Map<string, SearchResult>> = items.map(() => new Map());
    const byUrl = new Map<string, SearchResult>();
    let errors = 0;
    for (const block of res.content) {
      if (block.type !== "web_search_tool_result") continue;
      // Tool errors come back as HTTP 200 with an error object instead of a result list.
      if (!Array.isArray(block.content)) {
        errors++;
        continue;
      }
      const idx = callToItem.get(block.tool_use_id) ?? 0;
      for (const r of block.content) {
        const result = byUrl.get(r.url) ?? { title: r.title, url: r.url, snippet: "", publishedDate: pageAge(r.page_age) };
        byUrl.set(r.url, result);
        perItem[idx]!.set(r.url, result);
      }
    }
    if (errors && byUrl.size === 0) throw new Error("web_search failed for every query");
    for (const block of res.content) {
      if (block.type !== "text" || !block.citations) continue;
      for (const c of block.citations) {
        if (c.type !== "web_search_result_location") continue;
        const r = byUrl.get(c.url);
        if (r && !r.snippet.includes(c.cited_text)) r.snippet = `${r.snippet} ${c.cited_text}`.trim().slice(0, 1500);
      }
    }
    return perItem.map((m, i) => {
      // Quoted results first (they have text the answer model can cite), then title-only ones.
      const all = [...m.values()];
      const ranked = [...all.filter((r) => r.snippet), ...all.filter((r) => !r.snippet).map((r) => ({ ...r, snippet: r.title }))];
      return ranked.slice(0, items[i]!.opts?.maxResults ?? 6).map((r, j) => ({ ...r, score: r.snippet === r.title ? 0.3 : 0.9 - j * 0.05 }));
    });
  }
}

/** Anthropic's `page_age` ("April 30, 2026") as an ISO date, when it parses. */
export function pageAge(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}
