// The agent core. One turn:
//   save the message (with its time) -> resolve time phrases -> route -> gather evidence
//   (nothing | memory | parallel web searches | claim re-checks) -> stream the answer
//   -> check prices against evidence -> save -> extract claims in the background.
// Everything the UI, the CLI and the eval use goes through this class.

import { randomUUID } from "node:crypto";
import { renderDiffTable, unsupportedPrices } from "./claims.ts";
import type { ClaimRow, SessionRow, Store } from "./db.ts";
import type { AnswerInput, Intent, LLM, PastTurn, RoutePlan } from "./llm/types.ts";
import { recall, toPastTurn } from "./memory.ts";
import { dedupeClaims, recheckClaims, saveRecheck } from "./recheck.ts";
import { route } from "./router.ts";
import { type QueryRun, type Source, rankSources, runQueries } from "./search/rank.ts";
import type { SearchProvider } from "./search/types.ts";
import { type Clock, civilDateOf, daysBetween, formatCivil, formatLocal } from "./time.ts";
import { parseTimeRefs } from "./timeparse.ts";
import { type Nudge, type WatchConfig, checkWatchlist, dueClaims } from "./watch.ts";

export interface AgentDeps {
  store: Store;
  llm: LLM;
  search: SearchProvider;
  clock: Clock;
  timezone: string;
  watch?: WatchConfig;
}

export type AgentEvent =
  | { type: "turn"; sessionId: string; userMessageId: number; at: number; atLabel: string }
  | { type: "status"; text: string }
  | { type: "route"; intent: Intent; via: RoutePlan["via"]; queries: string[] }
  | { type: "sources"; sources: PublicSource[] }
  | { type: "delta"; text: string }
  | { type: "warning"; text: string }
  | { type: "done"; assistantMessageId: number; at: number; atLabel: string; timings: Timings }
  | { type: "error"; message: string };

export interface PublicSource {
  n: number;
  title: string;
  url: string;
  domain: string;
  date?: string;
  official: boolean;
}

export interface Timings {
  routeMs: number;
  evidenceMs: number;
  firstTokenMs: number | null;
  totalMs: number;
}

const HISTORY_TURNS = 8;
const MAX_INPUT = 4000;

export class Agent {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly watch: WatchConfig;

  constructor(private readonly deps: AgentDeps) {
    this.watch = deps.watch ?? { enabled: true, afterDays: 3, maxSearches: 3 };
  }

  get store(): Store {
    return this.deps.store;
  }

  nowLabel(): string {
    const now = this.deps.clock.now();
    return `${formatLocal(now, this.deps.timezone)} (${this.deps.timezone})`;
  }

  newSession(): SessionRow {
    return this.deps.store.createSession(randomUUID(), this.deps.clock.now());
  }

  /** Wait for background work (claim extraction). Tests and the CLI call this before exiting. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /**
   * The "right moment" check for a fresh session: re-checks a few stale tracked facts and, only if
   * one changed, stores and returns one short nudge as the session's first message.
   */
  async nudge(sessionId: string): Promise<{ messageId: number; nudge: Nudge } | null> {
    const { store, clock, timezone } = this.deps;
    if (!store.getSession(sessionId) || store.sessionMessages(sessionId).length > 0) return null;
    const now = clock.now();
    const nudge = await checkWatchlist({ ...this.deps, tz: timezone }, sessionId, now, this.watch);
    if (!nudge) return null;
    const messageId = store.addMessage(sessionId, "assistant", nudge.text, now, { intent: "nudge", sources: nudge.sources.map(publicSource) });
    store.touchSession(sessionId, now, "Update on something you asked");
    return { messageId, nudge };
  }

  async *chat(sessionId: string, rawText: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const { store, llm, clock, timezone: tz } = this.deps;
    const text = rawText.trim().slice(0, MAX_INPUT);
    if (!text) {
      yield { type: "error", message: "Empty message." };
      return;
    }
    const t0 = performance.now();
    const now = clock.now();
    if (!store.getSession(sessionId)) store.createSession(sessionId, now);
    const userId = store.addMessage(sessionId, "user", text, now);
    store.touchSession(sessionId, now, text.slice(0, 80));
    yield { type: "turn", sessionId, userMessageId: userId, at: now, atLabel: formatLocal(now, tz, now) };

    const nowLabel = this.nowLabel();
    const parsed = parseTimeRefs(text, now, tz);
    const history = store
      .recentMessages(sessionId, userId, HISTORY_TURNS)
      .map((m) => ({ role: m.role, content: m.content }));
    // A conversation must start with a user turn.
    while (history.length && history[0]!.role !== "user") history.shift();

    const plan = await route(llm, { text, nowLabel, history, timePhrases: parsed.refs.map((r) => r.phrase) });
    const routeMs = performance.now() - t0;
    store.updateMessageMeta(userId, { intent: plan.intent });
    yield { type: "route", intent: plan.intent, via: plan.via, queries: plan.searchQueries };

    let sources: Source[] = [];
    let memory: PastTurn[] = [];
    const notes: string[] = [];
    let prefix = "";
    let diff: AnswerInput["diff"];
    const runs: QueryRun[] = [];
    let recheckToSave: Parameters<typeof saveRecheck>[1] | null = null;
    const intent: Intent = plan.intent;

    try {
      if (plan.intent === "recall" || plan.intent === "verify") {
        const r = recall(store, { refs: parsed.refs, query: plan.memoryQuery || parsed.rest, currentMessageId: userId, sessionId, tz, nowMs: now });
        memory = r.turns;
        notes.push(...r.notes);
        if (memory.length) yield { type: "status", text: `Found ${memory.length === 1 ? "your question" : `${memory.length} questions`} from ${memory[0]!.when.split(",")[0]}` };
      }

      if (plan.intent === "verify" || plan.intent === "updates") {
        const claims =
          plan.intent === "updates"
            ? dueClaims(store, now, this.watch, true)
            : dedupeClaims(memory.flatMap((t) => t.claims), 12);
        if (plan.intent === "updates" && claims.length) memory = turnsForClaims(store, claims, tz, now);
        if (claims.length) {
          const thenMs = Math.min(...claims.map((c) => c.checked_at));
          const thenLabel = formatCivil(civilDateOf(thenMs, tz), civilDateOf(now, tz));
          const sinceDays = Math.max(1, daysBetween(civilDateOf(thenMs, tz), civilDateOf(now, tz)));
          yield { type: "status", text: `Re-checking ${claims.length} fact${claims.length > 1 ? "s" : ""} from ${thenLabel}` };
          const outcome = await recheckClaims(this.deps, claims, { nowMs: now, maxQueries: 5, newsSinceDays: sinceDays, signal });
          runs.push(...outcome.runs);
          sources = outcome.sources;
          const table = renderDiffTable(outcome.rows, thenLabel, formatCivil(civilDateOf(now, tz)));
          diff = { rows: outcome.rows, table, thenLabel };
          recheckToSave = outcome;
          const changed = outcome.rows.filter((r) => r.status === "changed").length;
          prefix = `${changed ? `**${changed} of ${outcome.rows.length} changed** since ${thenLabel}.` : `Nothing I checked has changed since ${thenLabel}.`}\n\n${table}\n\n`;
        } else if (plan.intent === "verify" && memory.length) {
          // The earlier answer had no stored facts: search the earlier question again and let the
          // model compare old answer and fresh sources.
          const q = memory[0]!.question.slice(0, 300);
          yield { type: "status", text: `Searching again: ${q}` };
          runs.push(...(await runQueries(this.deps.search, [{ query: q, purpose: "verify-freeform" }], signal)));
          sources = rankSources(runs, [], now);
        } else if (plan.intent === "updates") {
          notes.push("I'm not tracking any facts yet. Ask me about prices, plans or releases and I'll keep an eye on them.");
        }
      }

      if (plan.intent === "search") {
        yield { type: "status", text: `Searching: ${plan.searchQueries.join(" | ")}` };
        runs.push(
          ...(await runQueries(
            this.deps.search,
            plan.searchQueries.map((q) => ({
              query: q,
              purpose: "answer",
              opts: { maxResults: plan.highStakes ? 6 : 5, ...(plan.sinceDays ? { sinceDays: plan.sinceDays } : {}) },
            })),
            signal,
          )),
        );
        sources = rankSources(runs, plan.searchQueries, now, 8);
      }
    } catch (e) {
      if (signal?.aborted) return;
      notes.push(`Something failed while gathering evidence (${(e as Error).message}); say what could not be checked.`);
    }

    const failed = runs.filter((r) => r.error);
    if (failed.length && failed.length === runs.length) {
      yield { type: "warning", text: `Web search failed (${failed[0]!.error}). This answer is not backed by fresh sources.` };
      if (intent === "search") notes.push("Web search failed for every query; say so and do not state current facts.");
    }
    for (const r of runs) store.logSearch(userId, r.query, this.deps.search.name, r.purpose, r.error ? { error: r.error } : r.results, now);
    const evidenceMs = performance.now() - t0 - routeMs;
    if (sources.length) yield { type: "sources", sources: sources.map(publicSource) };

    // ---- Answer: code-rendered prefix (the diff table) first, then the model's words.
    let answer = "";
    let firstTokenMs: number | null = null;
    if (prefix) {
      answer += prefix;
      firstTokenMs = performance.now() - t0;
      yield { type: "delta", text: prefix };
    }
    try {
      for await (const chunk of llm.streamAnswer({
        intent: intent === "updates" ? "verify" : intent,
        question: text,
        nowLabel,
        history,
        sources,
        memory,
        diff,
        notes,
        highStakes: plan.highStakes,
        signal,
      })) {
        if (firstTokenMs === null) firstTokenMs = performance.now() - t0;
        answer += chunk;
        yield { type: "delta", text: chunk };
      }
    } catch (e) {
      if (!signal?.aborted) {
        const msg = `\n\n(The model failed before finishing: ${(e as Error).message})`;
        answer += msg;
        yield { type: "error", message: (e as Error).message };
      }
    }

    // ---- Correctness guard: every price in the answer must appear in the evidence.
    const evidence = [
      ...sources.map((s) => `${s.title} ${s.snippet}`),
      ...memory.map((t) => t.answer),
      diff?.table ?? "",
      text,
    ].join("\n");
    const warnings = unsupportedPrices(answer, evidence).map(
      (p) => `I couldn't match ${p} to any source I was given. Treat it as unverified.`,
    );
    for (const w of warnings) yield { type: "warning", text: w };

    const doneAt = clock.now();
    const timings: Timings = {
      routeMs: Math.round(routeMs),
      evidenceMs: Math.round(evidenceMs),
      firstTokenMs: firstTokenMs === null ? null : Math.round(firstTokenMs),
      totalMs: Math.round(performance.now() - t0),
    };
    const assistantId = store.addMessage(sessionId, "assistant", answer || "(no answer)", doneAt, {
      intent,
      via: plan.via,
      replyTo: userId,
      sources: sources.map(publicSource),
      warnings,
      notes,
      timings,
      aborted: signal?.aborted ?? false,
    });
    store.touchSession(sessionId, doneAt, text.slice(0, 80));
    if (recheckToSave) saveRecheck(store, recheckToSave, assistantId, sessionId, doneAt);

    // ---- Remember the checkable facts of new answers, off the critical path.
    if ((intent === "search" || (intent === "verify" && !recheckToSave)) && sources.length && answer) {
      this.background(
        llm.extractClaims({ question: text, answer, sources }).then((claims) => {
          const known = claims.filter((c) => c.subject && c.attribute && c.value);
          if (known.length) store.addClaims(assistantId, sessionId, known, doneAt);
        }),
      );
    }

    yield { type: "done", assistantMessageId: assistantId, at: doneAt, atLabel: formatLocal(doneAt, tz, doneAt), timings };
  }

  private background(p: Promise<unknown>): void {
    const tracked = p.catch((e: Error) => console.error(`[background] ${e.message}`)).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }
}

function publicSource(s: Source): PublicSource {
  return { n: s.n, title: s.title, url: s.url, domain: s.domain, date: s.publishedDate, official: s.official };
}

/** For "anything new?": the questions the tracked facts came from (most recent first, max 3). */
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
