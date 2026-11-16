// "Is that still correct?": recall the earlier answer, then re-check its stored facts against fresh
// searches (a code-rendered table), or search the earlier question again when it stored no facts.

import { renderDiffTable, summarizeDiff } from "../../claims.ts";
import type { ClaimRow } from "../../db.ts";
import { dedupeClaims, recheckClaims } from "../../recheck.ts";
import { rankSources, runQueries } from "../../search/rank.ts";
import { civilDateOf, daysBetween, formatCivil } from "../../time.ts";
import { rowsToShow } from "../../watch.ts";
import type { Turn } from "../context.ts";
import { drain } from "../progress.ts";
import type { AgentEvent } from "../types.ts";
import type { IntentHandler } from "./index.ts";
import { recallMemory } from "./recall.ts";

/** Facts re-checked for one "is it still correct?" (deduplicated across the recalled turns). */
const MAX_VERIFY_CLAIMS = 12;
const MAX_VERIFY_SEARCHES = 5;

export const verifyHandler: IntentHandler = {
  web: true,
  async *gather(t) {
    yield* recallMemory(t);
    const claims = dedupeClaims(t.memory.flatMap((m) => m.claims), MAX_VERIFY_CLAIMS);
    if (claims.length) {
      yield* recheck(t, claims, MAX_VERIFY_SEARCHES);
    } else if (t.memory.length && t.memory.every((m) => m.intent === "chat")) {
      // Small talk ("hi", "who made you") states no checkable fact: searching it again finds noise.
      const ev = t.show([`That was small talk ("${t.memory[0]!.question.replace(/\s+/g, " ").slice(0, 80)}"), so there's nothing factual in my answer to re-check. Ask me a question about prices, plans or releases and I can check it against current sources.`]);
      if (ev) yield ev;
      t.answeredByCode = true;
    } else if (t.memory.length) {
      // The earlier answer had no stored facts: search the earlier question again and let the
      // model compare old answer and fresh sources.
      const q = t.memory[0]!.question.slice(0, 300);
      yield t.status(`Searching again: ${q}`);
      yield t.step(q, "running");
      t.runs.push(...(yield* drain(runQueries(t.deps.search, [{ query: q, purpose: "verify-freeform" }], t.signal, t.onRun), t.updates)));
      t.sources = rankSources(t.runs, [], t.now);
    }
  },
};

/** Re-check facts against fresh searches and show the then/now table (shared with "anything new?"). */
export async function* recheck(t: Turn, claims: ClaimRow[], maxQueries: number): AsyncGenerator<AgentEvent> {
  const { tz, now } = t;
  const thenMs = Math.min(...claims.map((c) => c.checked_at));
  const thenLabel = formatCivil(civilDateOf(thenMs, tz), civilDateOf(now, tz));
  const sinceDays = Math.max(1, daysBetween(civilDateOf(thenMs, tz), civilDateOf(now, tz)));
  const nSubjects = new Set(claims.map((c) => c.subject.toLowerCase())).size;
  yield t.status(`Re-checking ${claims.length} fact${claims.length > 1 ? "s" : ""} about ${nSubjects} subject${nSubjects > 1 ? "s" : ""} from ${thenLabel}`);
  const outcome = yield* drain(
    recheckClaims(t.deps, claims, { nowMs: now, maxQueries, newsSinceDays: sinceDays, signal: t.signal, onRun: t.onRun, onStart: t.onStart }),
    t.updates,
  );
  t.runs.push(...outcome.runs);
  t.sources = outcome.sources;
  // "Anything new?" shows a short table (changes first); every fact was still re-checked and saved.
  const rows = t.intent === "updates" ? rowsToShow(outcome.rows) : outcome.rows;
  const hidden = outcome.rows.length - rows.length;
  const table = renderDiffTable(rows, thenLabel, formatCivil(civilDateOf(now, tz), civilDateOf(now, tz)));
  t.diff = { rows, table, thenLabel };
  t.recheckToSave = outcome;
  const more = hidden ? [`(${hidden} more fact${hidden > 1 ? "s" : ""} checked: ${countBy(outcome.rows.filter((r) => !rows.includes(r)))}.)`] : [];
  const ev = t.show([summarizeDiff(outcome.rows, thenLabel), table, ...more]);
  if (ev) yield ev;
}

/** "2 unchanged, 1 couldn't verify" for rows left out of a short table. */
function countBy(rows: Array<{ status: string }>): string {
  const n = (st: string) => rows.filter((r) => r.status === st).length;
  return [n("unchanged") ? `${n("unchanged")} unchanged` : "", n("unverified") ? `${n("unverified")} couldn't verify` : "", n("changed") ? `${n("changed")} more changed` : ""]
    .filter(Boolean)
    .join(", ");
}
