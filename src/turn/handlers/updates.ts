// "Anything new?": re-check the whole watchlist that is due (a short table, changes first).

import type { ClaimRow, Store } from "../../db.ts";
import type { PastTurn } from "../../llm/types.ts";
import { toPastTurn } from "../../memory.ts";
import { dueClaims } from "../../watch.ts";
import type { IntentHandler } from "./index.ts";
import { recheck } from "./verify.ts";

export const updatesHandler: IntentHandler = {
  web: true,
  async *gather(t) {
    const claims = dueClaims(t.deps.store, t.now, t.watch, true);
    if (claims.length) {
      t.memory = turnsForClaims(t.deps.store, claims, t.tz, t.now);
      yield* recheck(t, claims, t.watch.maxSearches);
    } else {
      const ev = t.show(["I'm not tracking any facts yet. Ask me about prices, plans or releases and I'll keep an eye on them."]);
      if (ev) yield ev;
    }
  },
};

/** The questions the tracked facts came from (most recent first, max 3). */
function turnsForClaims(store: Store, claims: ClaimRow[], tz: string, nowMs: number): PastTurn[] {
  const seen = new Set<number>();
  const turns: PastTurn[] = [];
  for (const c of claims) {
    const root = store.rootClaim(c);
    const q = root.message_id !== null ? store.questionFor(root.message_id) : undefined;
    if (!q || seen.has(q.id)) continue;
    seen.add(q.id);
    turns.push(toPastTurn(store, q, tz, nowMs));
    if (turns.length >= 3) break;
  }
  return turns;
}
