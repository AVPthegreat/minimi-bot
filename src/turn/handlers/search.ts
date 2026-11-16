// A web question: the first search round is planned by code (started during routing: the question and
// one search per product named), plus the router's own queries when code found no products. All run in
// parallel; the answer model can follow up with its own searches afterwards (turn/answer.ts).

import { rankSources, runQueries } from "../../search/rank.ts";
import { drain } from "../progress.ts";
import type { IntentHandler } from "./index.ts";

export const searchHandler: IntentHandler = {
  web: true,
  async *gather(t) {
    const { extra, plan } = t;
    if (extra.length) yield t.status(`Searching the web: ${extra.join(" | ")}`);
    for (const q of extra) yield t.step(q, "running");
    const extraRuns = extra.length
      ? runQueries(
          t.deps.search,
          extra.map((q) => ({
            query: q,
            purpose: "answer",
            opts: { maxResults: plan.highStakes ? 6 : 5, ...(plan.sinceDays ? { sinceDays: plan.sinceDays } : {}) },
          })),
          t.signal,
          t.onRun,
        )
      : Promise.resolve([]);
    const [specRuns, planRuns] = yield* drain(Promise.all([t.spec ?? Promise.resolve([]), extraRuns]), t.updates);
    t.runs.push(...specRuns, ...planRuns);
    // Every subject keeps at least its best page, so no product of a comparison goes unsourced.
    const { subjects } = t;
    t.sources = rankSources(t.runs, subjects.length ? subjects : plan.searchQueries, t.now, Math.max(8, subjects.length * 2 + 2), { coverEachQuery: subjects.length > 0 });
  },
};
