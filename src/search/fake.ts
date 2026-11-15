// Deterministic search over fixtures/world.json, aware of the injected clock: a page is only
// "on the web" between its `from` and `to` dates. That lets the eval replay a week in which a
// price changes, offline.

import { readFileSync } from "node:fs";
import type { Clock } from "../time.ts";
import type { SearchOptions, SearchProvider, SearchResult } from "./types.ts";

interface Page {
  url: string;
  title: string;
  text: string;
  published: string;
  from: string;
  to?: string;
}

const STOP = new Set(
  "a an the of for to in on and or is are was what which who how much does do did any has have since vs with my our we i you it its that this there their latest new current today".split(" "),
);

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9$]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export class FakeSearch implements SearchProvider {
  readonly name = "fake";
  private readonly pages: Page[];
  /** Every query this provider has answered (the eval asserts on these). */
  readonly log: string[] = [];

  constructor(
    private readonly clock: Clock,
    worldPath = new URL("../../fixtures/world.json", import.meta.url),
  ) {
    this.pages = (JSON.parse(readFileSync(worldPath, "utf8")) as { pages: Page[] }).pages;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    this.log.push(query);
    const now = this.clock.now();
    const q = tokens(query);
    const since = opts.sinceDays !== undefined ? now - opts.sinceDays * 86400000 : -Infinity;
    const scored = this.pages
      .filter((p) => Date.parse(p.from) <= now && (!p.to || Date.parse(p.to) > now))
      .filter((p) => Date.parse(p.published) >= since)
      .map((p) => {
        const hay = new Set(tokens(`${p.title} ${p.text} ${p.url}`));
        const hits = q.filter((t) => hay.has(t)).length;
        return { p, score: q.length ? hits / q.length : 0 };
      })
      .filter((x) => x.score >= 0.6) // most query words must appear on the page
      .sort((a, b) => b.score - a.score || b.p.published.localeCompare(a.p.published));
    return scored.slice(0, opts.maxResults ?? 6).map(({ p, score }) => ({
      title: p.title,
      url: p.url,
      snippet: p.text,
      publishedDate: p.published,
      score: Math.round(score * 100) / 100,
    }));
  }
}
