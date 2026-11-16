// Stage 1 of a turn: decide the intent, starting the planned searches before the router has answered.
//
// The agent owns the search plan. When the rules can't decide, the message is most likely a web
// question, so the searches start right away while the router model decides: the raw question
// (speculative) plus, for a comparison, one search per subject named in the message (read by code).
// If the router says no search is needed, they are cancelled.

import { planSubjects, subjectQueries } from "../planner.ts";
import { route, rulesRoute } from "../router.ts";
import { runQueries } from "../search/rank.ts";
import type { Turn } from "./context.ts";
import type { AgentEvent } from "./types.ts";

/** While a speculative search is already running, wait at most this long for the router model. */
const SPECULATIVE_ROUTER_TIMEOUT_MS = 1500;
const ROUTER_TIMEOUT_MS = 4000;

export async function* routeTurn(t: Turn): AsyncGenerator<AgentEvent> {
  const { text, parsed, history, signal } = t;
  const routeInput = { text, rest: parsed.rest, nowLabel: t.nowLabel, history, timePhrases: parsed.refs.map((r) => r.phrase) };
  const rules = rulesRoute(text, parsed.refs.length > 0, history.length > 0, parsed.rest);
  t.rules = rules;
  // Rules that already know it is a web question (a new question inside a follow-up) plan like an
  // undecided message, but on that question only.
  const undecided = rules === null || rules.intent === "search";
  t.specQuery = rules?.intent === "search" ? rules.searchQueries[0]! : text.slice(0, 300);
  t.subjects = undecided ? planSubjects(t.topic) : [];
  t.planned = undecided
    ? [
        { query: t.specQuery, purpose: "speculative", opts: { maxResults: 5 } },
        ...subjectQueries(t.subjects, parsed.rest).map((q) => ({ query: q, purpose: "answer", opts: { maxResults: 5 } })),
      ]
    : [];
  const specAbort = new AbortController();
  t.spec = t.planned.length
    ? runQueries(t.deps.search, t.planned, signal ? AbortSignal.any([specAbort.signal, signal]) : specAbort.signal, (...a) => {
        if (!specAbort.signal.aborted) t.onRun(...a);
      })
    : null;
  if (t.spec) {
    yield t.status(t.subjects.length
      ? `Searching the web for ${t.subjects.join(", ")} (${t.planned.length} searches in parallel)`
      : `Searching the web: ${t.specQuery.slice(0, 120)}`);
    for (const p of t.planned) yield t.step(p.query, "running");
  }
  const plan = await route(t.deps.llm, routeInput, { timeoutMs: t.spec ? SPECULATIVE_ROUTER_TIMEOUT_MS : ROUTER_TIMEOUT_MS });
  t.plan = plan;
  if (t.spec && plan.intent !== "search") {
    specAbort.abort();
    // Searches that finished meanwhile must not reappear after their "cancelled" step.
    t.updates.drop((e) => e.type === "search");
    for (const p of t.planned) yield t.step(p.query, "cancelled");
  }
  t.routeMs = performance.now() - t.t0;
  t.deps.store.updateMessageMeta(t.userId, { intent: plan.intent });
  // Code found the subjects: that plan is already running. Otherwise the router's queries are added.
  t.extra = plan.intent === "search" && !t.subjects.length ? plan.searchQueries.filter((q) => !(t.spec && sameQuery(q, t.specQuery))) : [];
  const queries = plan.intent === "search" ? [...t.planned.map((p) => p.query), ...t.extra] : plan.searchQueries;
  yield { type: "route", intent: plan.intent, via: plan.via, queries };
}

function sameQuery(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return norm(a) === norm(b);
}
