// Stage 3 of a turn: the answer model writes from the gathered evidence (searching more itself, within
// bounds, on web intents), streamed through the grounding guard: every price it writes must be backed by CURRENT evidence (the gathered sources, passages it
// cited, the computed diff table), or it is marked "(unverified)" before the user sees it. Old answers
// are not evidence for today's prices; only a pure recall answer may quote them, as history.

import { type EvidenceDoc, priceChecker, questionMultipliers } from "../claims.ts";
import { GroundingGuard } from "../grounding.ts";
import { NOT_NAMES } from "../planner.ts";
import type { ToolCall, ToolRound } from "../llm/types.ts";
import { type QueryRun, type Source, domainOf, isOfficialFor, rankSources, runQueries } from "../search/rank.ts";
import type { Turn } from "./context.ts";
import { drain } from "./progress.ts";
import { type AgentEvent, publicSource } from "./types.ts";

/** Results kept per follow-up search (the planned round keeps more: it covers every subject). */
const SELF_SEARCH_RESULTS = 5;

/**
 * The answer, as a bounded agent loop. Round 1 of evidence was planned by code (the handler); here the
 * model may call its one tool, web_search, for follow-ups and gaps:
 *   stream the model -> it either answers (done) or asks for searches -> the agent runs them (in
 *   parallel, with progress), numbers the pages as sources, hands them back as tool results -> repeat.
 * Bounds: at most `maxSelfSearches` searches per turn (ANSWER_MAX_SEARCHES, default 3) and so at most
 * that many + 1 model calls; the spend cap is checked before every search round; non-web intents get
 * no tool at all. Every page found joins the turn's sources, so the grounding guard checks prices
 * against it and the UI cites it like any other source.
 */
export async function* answer(t: Turn, web: boolean): AsyncGenerator<AgentEvent> {
  const { deps, intent, signal } = t;
  const max = deps.maxSelfSearches ?? 3;
  const budget = web && Number.isInteger(max) ? Math.max(0, max) : 0;
  /** The planned round's sources: the model's first message stays the same across rounds. */
  const planned = t.sources.slice();
  const rounds: ToolRound[] = [];
  const selfRuns: QueryRun[] = [];
  let used = 0;

  const guard = groundingGuard(t);
  const out = (text: string): AgentEvent | null => {
    const safe = guard.push(text);
    if (!safe) return null;
    if (t.firstTokenMs === null) t.firstTokenMs = performance.now() - t.t0;
    if (t.firstModelTokenMs === null) t.firstModelTokenMs = performance.now() - t.t0;
    t.answer += safe;
    return { type: "delta", text: safe };
  };
  try {
    if (signal?.aborted) throw new Error("stopped");
    while (!t.answeredByCode) {
      const left = budget - used;
      const calls: ToolCall[] = [];
      let text = "";
      let state: unknown;
      for await (const ev of deps.llm.streamAnswer({
        intent: intent === "updates" ? "verify" : intent,
        question: t.question,
        nowLabel: t.nowLabel,
        history: t.history,
        sources: planned,
        memory: t.memory,
        diff: t.diff,
        notes: t.notes,
        shown: t.shown,
        highStakes: t.plan.highStakes,
        maxSelfSearches: left,
        rounds,
        signal,
      })) {
        if (ev.type === "text") {
          text += ev.text;
          const d = out(ev.text);
          if (d) yield d;
        } else if (ev.type === "tool_call") {
          calls.push({ id: ev.id, query: ev.query.trim().slice(0, 300) });
        } else if (ev.type === "round_state") {
          state = ev.state;
        }
      }
      // The model answered, or asked for a search it no longer has: the turn's answer is complete.
      if (!calls.length || left <= 0 || signal?.aborted) break;
      if (!spendLeft(deps.meter)) {
        const d = out("\n\n(I stopped searching here: the spend cap is reached.)");
        if (d) yield d;
        break;
      }
      const run = calls.slice(0, left).filter((c) => c.query);
      for (const c of run) {
        yield t.status(`Searching again: ${c.query}`);
        yield t.step(c.query, "running");
      }
      const runs = yield* drain(
        runQueries(deps.search, run.map((c) => ({ query: c.query, purpose: "self-search", opts: { maxResults: SELF_SEARCH_RESULTS } })), signal, t.onRun),
        t.updates,
      );
      used += Math.max(1, run.length);
      selfRuns.push(...runs);
      const before = t.sources.length;
      const results = calls.map((c) => {
        const i = run.indexOf(c);
        if (i < 0) return { id: c.id, sources: [], error: c.query ? "search budget for this turn is used up" : "empty query" };
        const r = runs[i]!;
        return { id: c.id, sources: r.error ? [] : addSources(t, r), ...(r.error ? { error: r.error } : {}) };
      });
      if (t.sources.length > before) yield { type: "sources", sources: t.sources.map(publicSource) };
      rounds.push({ text, calls, results, ...(state === undefined ? {} : { state }) });
    }
  } catch (e) {
    if (!signal?.aborted) {
      const message = deps.publicError ? deps.publicError(e as Error) : (e as Error).message;
      const d = out(`\n\n(The model failed before finishing: ${message})`);
      if (d) yield d;
      yield { type: "error", message };
    }
  }
  const tail = guard.end();
  if (tail) {
    t.answer += tail;
    yield { type: "delta", text: tail };
  }
  for (const r of selfRuns) deps.store.logSearch(t.userId, r.query, deps.search.name, r.purpose, r.error ? { error: r.error } : r.results, t.now);

  t.flagged = [...new Set(guard.flagged)];
  t.warnings = t.flagged.map((p) => `I couldn't match ${p} to a current source. Treat it as unverified.`);
  for (const w of t.warnings) yield { type: "warning", text: w };
}

/** Rank one follow-up search's pages and add them to the turn's sources (a page already there keeps its number). */
function addSources(t: Turn, run: QueryRun): Source[] {
  return rankSources([run], [run.query], t.now, SELF_SEARCH_RESULTS).map((r) => {
    const existing = t.sources.find((x) => x.url === r.url);
    if (existing) return existing;
    const source: Source = { ...r, n: t.sources.length + 1, official: isOfficialFor(r.url, [...t.plan.searchQueries, run.query]) };
    t.sources.push(source);
    return source;
  });
}

function spendLeft(meter: { check(): void } | undefined): boolean {
  try {
    meter?.check();
    return true;
  } catch {
    return false;
  }
}

/** The guard over this turn's evidence; it reads the sources live, so sources found mid-answer count. */
function groundingGuard(t: Turn): GroundingGuard {
  const { intent } = t;
  const evidence = (): EvidenceDoc[] => [
    ...t.sources.map((x) => ({ n: x.n, text: `${x.title}\n${x.snippet}`, about: `${siteName(x.url)} ${x.query === t.specQuery ? x.title : `${x.title} ${x.query}`}` })),
    { text: t.diff?.table ?? "" },
    // What was said before (the earlier answer, earlier in this chat) backs a price only as history:
    // fully in a recall answer, and elsewhere only where the sentence says it was the price then.
    ...t.memory.map((m) => ({ text: m.answer, pastOnly: intent !== "recall" })),
    ...t.history.filter((m) => m.role === "assistant").map((m) => ({ text: m.content, pastOnly: intent !== "recall" })),
  ];
  const multipliers = questionMultipliers(t.text);
  // The products this turn is about: what decides which product a price belongs to.
  const names = (): string[] => [
    ...t.subjects,
    ...productWords(t.topic),
    ...t.memory.flatMap((m) => [...m.claims.map((c) => c.subject), ...productWords(m.question)]),
    ...(t.diff?.rows.map((r) => r.subject) ?? []),
    ...t.sources.map((x) => siteName(x.url)),
  ];
  return new GroundingGuard((line, before) => priceChecker(evidence(), { multipliers, names: names() })(line, `${t.shown.join("\n")}\n${before}`));
}

/** The site's own name: "docs.railway.com" -> "railway", "neon.com" -> "neon". */
function siteName(url: string): string {
  const parts = domainOf(url).split(".");
  return parts.length >= 2 ? parts[parts.length - 2]! : parts[0]!;
}

/** Capitalised words of a question that are not sentence openers or dates ("Cloudflare", "Workers"). */
function productWords(text: string): string[] {
  return [...text.matchAll(/(?<![.!?]\s|^)\b[A-Z][\w.+&-]{2,}/g)].map((m) => m[0]).filter((w) => !NOT_NAMES.has(w));
}
