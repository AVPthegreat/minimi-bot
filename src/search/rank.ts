// Runs several searches at once, merges them, and ranks results so the model sees the most
// trustworthy and recent pages first: official pages (pricing, changelog, docs, release notes,
// the vendor's own domain) and fresh dates beat third-party roundups.

import type { SearchProvider, SearchResult, SearchOptions } from "./types.ts";

export interface Source extends SearchResult {
  n: number; // citation number shown to the user: [1], [2], ...
  domain: string;
  official: boolean;
  query: string;
}

export interface QueryRun {
  query: string;
  purpose: string;
  results: SearchResult[];
  error?: string;
  ms: number;
}

export async function runQueries(
  provider: SearchProvider,
  queries: Array<{ query: string; purpose: string; opts?: SearchOptions }>,
  signal?: AbortSignal,
): Promise<QueryRun[]> {
  // All in parallel: latency is the slowest search, not the sum.
  return Promise.all(
    queries.map(async ({ query, purpose, opts }) => {
      const t0 = Date.now();
      try {
        const results = await provider.search(query, { ...opts, signal });
        return { query, purpose, results, ms: Date.now() - t0 };
      } catch (e) {
        return { query, purpose, results: [], error: (e as Error).message, ms: Date.now() - t0 };
      }
    }),
  );
}

const OFFICIAL_PATH = /\/(pricing|plans?|changelog|release-?notes?|releases|docs?|blog|news|company-news|press)(\/|\.|$)/i;

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** True if the page lives on the subject's own site (e.g. "Supabase" -> supabase.com). */
export function isOfficialFor(url: string, subjects: string[]): boolean {
  const host = domainOf(url).replace(/[^a-z0-9.]/g, "");
  return subjects.some((s) => {
    const key = s.toLowerCase().split(/\s+/)[0]!.replace(/[^a-z0-9]/g, "");
    return key.length >= 3 && host.split(".").some((part) => part === key || part.startsWith(key));
  });
}

export function rankSources(runs: QueryRun[], subjects: string[], nowMs: number, limit = 8): Source[] {
  const byUrl = new Map<string, { r: SearchResult; query: string; score: number }>();
  runs.forEach((run) => {
    run.results.forEach((r, i) => {
      const key = r.url.replace(/[#?].*$/, "").replace(/\/$/, "");
      // The vendor's own site is official; a pricing/changelog/docs path on it is the best page there.
      // Elsewhere such a path only earns a small boost (third-party blogs are not official).
      const vendor = isOfficialFor(r.url, subjects);
      const officialPath = OFFICIAL_PATH.test(safePath(r.url));
      let score = (r.score ?? 0.5) + 1 / (i + 2); // provider relevance + position
      if (vendor) score += officialPath ? 0.8 : 0.5;
      else if (officialPath) score += 0.1;
      if (r.publishedDate) {
        const ageDays = (nowMs - Date.parse(r.publishedDate)) / 86400000;
        if (ageDays >= 0) score += Math.max(0, 0.5 - ageDays / 365); // up to +0.5 for this year's pages
      }
      const prev = byUrl.get(key);
      if (!prev || prev.score < score) byUrl.set(key, { r, query: run.query, score: prev ? Math.max(prev.score, score) + 0.2 : score });
    });
  });
  return [...byUrl.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ r, query }, i) => ({
      ...r,
      n: i + 1,
      domain: domainOf(r.url),
      official: isOfficialFor(r.url, subjects),
      query,
    }));
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}
