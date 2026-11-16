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

/**
 * The ONE place that picks Anthropic's web_search tool version for the search calls here (the answer
 * model's own follow-up searches also come through this provider: the agent runs them, turn/answer.ts). The newer version (dynamic filtering) is used on
 * every model that supports it: Fable, Mythos, and Opus/Sonnet 4.6 and later. Other models (the default
 * SEARCH_MODEL, Haiku, among them) are not documented for it, so they keep the basic version rather than
 * risk every search failing on a 400.
 */
export const WEB_SEARCH_TOOL = "web_search_20260209" as const;
export const WEB_SEARCH_TOOL_BASIC = "web_search_20250305" as const;
const DYNAMIC_FILTERING = /^claude-(?:fable|mythos)-|^claude-(?:opus|sonnet)-(?:4-[6-9]|[5-9])(?:-|$)/;

export function webSearchTool(model: string): typeof WEB_SEARCH_TOOL | typeof WEB_SEARCH_TOOL_BASIC {
  return DYNAMIC_FILTERING.test(model) ? WEB_SEARCH_TOOL : WEB_SEARCH_TOOL_BASIC;
}

const SYSTEM = `You are a search backend, not an assistant. Run exactly one web_search with the query text as given. Then write one bullet per relevant fact, quoting the result verbatim, with the product, plan name, price and unit together in the same bullet, and end the bullet with the result's URL in angle brackets:
- "Neon Launch plan: $19/month" <https://neon.com/pricing>
Cover prices, plan names, version numbers, dates and announcements. Every bullet must be a quotation from a result. No commentary, no advice.`;

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
        tools: [{ type: webSearchTool(this.model), name: "web_search", max_uses: 1 }],
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
    // Snippets: the verbatim `cited_text` of each citation, plus the search model's quoted bullets for a
    // URL it found (a citation's text is often a fragment without the price; the bullet keeps product,
    // plan, price and unit together). A bullet naming a URL the search did not return is ignored.
    const add = (r: SearchResult | undefined, t: string) => {
      const clean = t.replace(/<https?:\/\/[^>]*>|https?:\/\/\S+/g, "").replace(/^\s*[-*]\s*/, "").trim();
      if (r && clean && !r.snippet.includes(clean)) r.snippet = `${r.snippet} ${clean}`.trim().slice(0, 1500);
    };
    const findUrl = (t: string) => {
      for (const m of t.matchAll(/https?:\/\/[^\s>)"]+/g)) {
        const u = m[0].replace(/[.,;]+$/, "");
        const hit = byUrl.get(u) ?? [...byUrl.values()].find((r) => r.url.replace(/\/$/, "") === u.replace(/\/$/, ""));
        if (hit) return hit;
      }
      return undefined;
    };
    for (const block of res.content) {
      if (block.type !== "text") continue;
      for (const c of block.citations ?? []) {
        if (c.type !== "web_search_result_location") continue;
        add(byUrl.get(c.url), c.cited_text);
        if (/[$€£₹]\s?\d|\d\s?(?:USD|EUR|GBP|INR)\b/.test(block.text)) add(byUrl.get(c.url), block.text);
      }
      for (const line of block.text.split("\n")) add(findUrl(line), line);
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
