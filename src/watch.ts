// The "right moment" nudge. Every fact the agent stated (a price, a plan, a release) is on a
// watchlist by default. When the user opens a new chat, we quietly re-check a few of the oldest
// tracked facts. If one actually changed, the chat opens with ONE short line about it. If nothing
// changed, we say nothing: an assistant that pings you with "no news" teaches you to ignore it.

import { withUnit } from "./claims.ts";
import type { ClaimRow, Store } from "./db.ts";
import { type RecheckDeps, recheckClaims, saveRecheck } from "./recheck.ts";
import type { Source } from "./search/rank.ts";
import { formatLocal } from "./time.ts";

export interface WatchConfig {
  enabled: boolean;
  /** Re-check a fact only if it is at least this many days old. */
  afterDays: number;
  /** At most this many subjects per check (one search per subject). */
  maxSearches: number;
}

export interface Nudge {
  text: string; // markdown, one or two lines
  sources: Source[];
  changes: number;
}

export interface WatchDeps extends RecheckDeps {
  tz: string;
}

/** Rows "anything new?" shows: changes first, then unverified, then unchanged (all facts are still re-checked). */
export const MAX_ROWS_SHOWN = 6;
/** A guard on model input size, not a display bound: facts of one subject read from its one search. */
const MAX_FACTS_PER_SUBJECT = 8;

/**
 * Facts due for a re-check: newest interest first, one per subject + attribute, bounded in code to
 * `maxSearches` subjects (one search each). EVERY due fact of a chosen subject is included: they share
 * that subject's search, and a fact left out stays due, so the next new chat searched again (live
 * 16 Nov, run 2: the 4th chat ran 2 searches after the 3rd had checked the same subjects).
 */
export function dueClaims(store: Store, nowMs: number, cfg: WatchConfig, force = false): ClaimRow[] {
  const olderThan = force ? nowMs + 1 : nowMs - cfg.afterDays * 86400000;
  const all = store.watchCandidates(olderThan, 60);
  const perSubject = new Map<string, number>();
  return all.filter((c) => {
    const s = c.subject.trim().toLowerCase();
    const n = perSubject.get(s);
    if (n === undefined && perSubject.size >= cfg.maxSearches) return false;
    if ((n ?? 0) >= MAX_FACTS_PER_SUBJECT) return false;
    perSubject.set(s, (n ?? 0) + 1);
    return true;
  });
}

/** The rows worth showing, at most `max`: changed, then couldn't-verify, then unchanged (original order within each). */
export function rowsToShow<T extends { status: string }>(rows: T[], max = MAX_ROWS_SHOWN): T[] {
  const rank = (r: T) => (r.status === "changed" ? 0 : r.status === "unverified" ? 1 : 2);
  const keep = new Set([...rows].sort((a, b) => rank(a) - rank(b)).slice(0, max));
  return rows.filter((r) => keep.has(r));
}

/**
 * Check the watchlist and return at most one nudge, or null when nothing changed (or nothing was
 * due). Writes the fresh values back, so the same change is never announced twice and a fact
 * that was just checked is not searched again for `afterDays`.
 */
export async function checkWatchlist(deps: WatchDeps, sessionId: string, nowMs: number, cfg: WatchConfig): Promise<Nudge | null> {
  if (!cfg.enabled) return null;
  const claims = dueClaims(deps.store, nowMs, cfg);
  if (claims.length === 0) return null;
  const outcome = await recheckClaims(deps, claims, { nowMs, maxQueries: cfg.maxSearches });
  const changed = outcome.rows.map((r, i) => ({ r, c: claims[i]!, i })).filter((x) => x.r.status === "changed");
  // Record what we confirmed: unchanged facts, and the one change we announce. Other changes stay
  // pending, so "anything new?" still reports them.
  const keep = new Set(outcome.rows.map((r, i) => (r.status === "unchanged" ? i : -1)).filter((i) => i >= 0));
  if (changed[0]) keep.add(changed[0].i);
  const pick = <T>(xs: T[]) => xs.filter((_, i) => keep.has(i));
  saveRecheck(deps.store, { ...outcome, claims: pick(outcome.claims), found: pick(outcome.found), rows: pick(outcome.rows) }, null, sessionId, nowMs);
  deps.store.markRechecked(claims.map((c) => c.id), nowMs);
  if (changed.length === 0) return null;

  // The single most useful change: the one from the user's most recent question.
  const { r, c } = changed[0]!;
  const root = deps.store.rootClaim(c);
  const question = root.message_id !== null ? deps.store.questionFor(root.message_id) : undefined;
  const when = question ? formatLocal(question.created_at, deps.tz, nowMs) : formatLocal(root.checked_at, deps.tz, nowMs);
  const src = outcome.sources.find((s) => s.n === r.sourceN);
  const about = question ? `you asked about on ${when.split(",")[0]}` : "I told you about";
  const more = changed.length > 1 ? ` (${changed.length - 1} more change${changed.length > 2 ? "s" : ""}: ask me "anything new?")` : "";
  const text =
    `**Heads-up:** something ${about} has changed. ${r.subject} ${r.attribute}: ${withUnit(c.value, c.unit)} then, ` +
    `**${r.newValue}** now${src ? " [1]" : ""}${src?.publishedDate ? ` (source dated ${src.publishedDate})` : ""}.${more}`;
  return { text, sources: src ? [{ ...src, n: 1 }] : [], changes: changed.length };
}
