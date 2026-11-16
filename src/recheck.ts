// Re-verification: take stored claims, search for exactly those facts (in parallel), let the
// small model read off the current values, and diff old vs new in code. Shared by
// "is it still correct?", "anything new?" and the background watchlist.

import { type DiffRow, diffClaim } from "./claims.ts";
import type { ClaimRow, Store } from "./db.ts";
import type { LLM, RecheckResult } from "./llm/types.ts";
import { type QueryRun, type Source, rankSources, runQueries } from "./search/rank.ts";
import type { SearchProvider } from "./search/types.ts";
import { fairCap } from "./planner.ts";

export interface RecheckDeps {
  store: Store;
  llm: LLM;
  search: SearchProvider;
}

export interface RecheckOutcome {
  claims: ClaimRow[];
  /** What the web says now, per claim (null = not found). */
  found: Array<RecheckResult | null>;
  rows: DiffRow[];
  sources: Source[];
  runs: QueryRun[];
}

export interface PlannedQuery {
  query: string;
  purpose: "recheck" | "news-since";
  opts: { depth: "deep" | "basic"; sinceDays?: number; maxResults: number };
}

/**
 * One targeted search per subject, naming the exact attributes we need ("Neon Launch plan pricing"),
 * plus, when asked, one "news since then" search per subject for launches and announcements.
 */
export function planRecheckQueries(claims: ClaimRow[], opts: { maxQueries: number; newsSinceDays?: number }): PlannedQuery[] {
  const bySubject = new Map<string, ClaimRow[]>();
  for (const c of claims) {
    const key = c.subject.trim();
    bySubject.set(key, [...(bySubject.get(key) ?? []), c]);
  }
  const subjects = [...bySubject.keys()].slice(0, opts.maxQueries);
  const queries: PlannedQuery[] = subjects.map((s) => {
    const cs = bySubject.get(s)!;
    const attrs = [...new Set(cs.map((c) => c.attribute.replace(/\bprice\b/i, "").trim()))].slice(0, 3);
    const pricing = cs.some((c) => /price|cost|fee/i.test(c.attribute)) ? "pricing" : "";
    return { query: `${s} ${attrs.join(" ")} ${pricing}`.replace(/\s+/g, " ").trim(), purpose: "recheck", opts: { depth: "deep", maxResults: 4 } };
  });
  if (opts.newsSinceDays !== undefined) {
    for (const s of subjects.slice(0, 5)) {
      queries.push({ query: `${s} news launch pricing update`, purpose: "news-since", opts: { depth: "basic", maxResults: 3, sinceDays: Math.max(1, opts.newsSinceDays) } });
    }
  }
  return queries;
}

/**
 * Keep one claim per subject + attribute (the first, i.e. the caller's preferred one), at most `max`,
 * taken round-robin across subjects so every product of a shortlist gets re-checked.
 */
export function dedupeClaims(claims: ClaimRow[], max: number): ClaimRow[] {
  const seen = new Set<string>();
  const unique = claims.filter((c) => {
    const k = `${c.subject.toLowerCase()}|${c.attribute.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return fairCap(unique, max);
}

export async function recheckClaims(
  deps: RecheckDeps,
  claims: ClaimRow[],
  opts: { nowMs: number; maxQueries: number; newsSinceDays?: number; signal?: AbortSignal; onRun?: Parameters<typeof runQueries>[3] },
): Promise<RecheckOutcome> {
  const queries = planRecheckQueries(claims, opts);
  const runs = await runQueries(deps.search, queries, opts.signal, opts.onRun);
  const subjects = [...new Set(claims.map((c) => c.subject))];
  const sources = rankSources(runs, subjects, opts.nowMs, 12);
  let found: Awaited<ReturnType<LLM["recheck"]>>;
  try {
    found = await deps.llm.recheck({ claims, sources });
  } catch {
    found = claims.map(() => null); // the model failed: report "couldn't verify", never a guess
  }
  const rows = claims.map((c, i) => {
    const f = found[i] ?? null;
    const src = f ? sources.find((s) => s.n === f.sourceN) : undefined;
    return diffClaim(c, f ? { value: f.value, unit: f.unit, sourceN: f.sourceN, sourceDate: src?.publishedDate ?? null } : null);
  });
  return { claims, found, rows, sources, runs };
}

/** Store the fresh values as new versions of the claims (so the next check compares with them). */
export function saveRecheck(store: Store, outcome: RecheckOutcome, messageId: number | null, sessionId: string, nowMs: number): void {
  const versions = outcome.claims.flatMap((c, i) => {
    const f = outcome.found[i];
    if (!f) return [];
    const src = outcome.sources.find((s) => s.n === f.sourceN);
    return [{
      subject: c.subject, attribute: c.attribute, value: f.value, unit: f.unit ?? c.unit,
      sourceUrl: src?.url ?? null, sourceDate: src?.publishedDate ?? null, supersedesId: c.id,
    }];
  });
  store.addClaims(messageId, sessionId, versions, nowMs);
  store.markRechecked(outcome.claims.map((c) => c.id), nowMs);
}
