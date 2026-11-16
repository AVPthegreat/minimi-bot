// The agent core. A turn is a short shared lifecycle (Agent.chat) around one handler per intent:
//   save the message (with its time) -> route (rules, else the router model; the planned searches start
//   meanwhile: turn/route.ts) -> the intent's handler gathers evidence (turn/handlers/: chat, recall,
//   verify, updates, search) -> the answer model writes, with its one tool (web_search) in a bounded loop
//   on web intents, streamed through the grounding guard (turn/answer.ts) -> save -> extract claims in
//   the background.
// Everything the UI, the CLI and the eval use goes through this class.

import { randomUUID } from "node:crypto";
import { BrandBook } from "./brand.ts";
import { sameValue } from "./claims.ts";
import { canonicalSubject, fairCap } from "./planner.ts";
import type { SessionRow, Store } from "./db.ts";
import { saveRecheck } from "./recheck.ts";
import { formatLocal } from "./time.ts";
import { parseTimeRefs } from "./timeparse.ts";
import { answer } from "./turn/answer.ts";
import { Turn } from "./turn/context.ts";
import { HANDLERS } from "./turn/handlers/index.ts";
import { routeTurn } from "./turn/route.ts";
import { type AgentDeps, type AgentEvent, type Timings, publicSource } from "./turn/types.ts";
import { type Nudge, type WatchConfig, checkWatchlist } from "./watch.ts";

export type { AgentDeps, AgentEvent, PublicSource, SearchState, Timings } from "./turn/types.ts";

const HISTORY_TURNS = 8;
const MAX_INPUT = 4000;
/** Facts kept per answer: every product of a 5-item shortlist, up to 3 facts each. */
const MAX_STORED_CLAIMS = 15;
const MAX_CLAIMS_PER_SUBJECT = 3;

export class Agent {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly watch: WatchConfig;
  private readonly brands = new BrandBook();

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
   *
   * A change is committed (saved as the fact's new value) only together with the nudge that shows it. If
   * the user starts talking first, the nudge is dropped and the change stays pending for the next new chat
   * and for "anything new?". If `signal` aborts (the server's time limit, the tab closed, the user's own
   * message in the demo), the searches and model call are cancelled and nothing is written.
   */
  async nudge(sessionId: string, signal?: AbortSignal): Promise<{ messageId: number; nudge: Nudge } | null> {
    const { store, clock, timezone } = this.deps;
    if (signal?.aborted || !store.getSession(sessionId) || store.sessionMessages(sessionId).length > 0) return null;
    const now = clock.now();
    const check = await checkWatchlist({ ...this.deps, tz: timezone }, sessionId, now, this.watch, signal);
    if (!check || signal?.aborted) return null;
    // The check took a while: if the user started talking meanwhile, drop the nudge rather than wedge it
    // between their question and its answer. node:sqlite is synchronous, so from here to the insert
    // nothing else runs: the check, the commit and the stored message happen together.
    const shown = check.nudge !== null && store.sessionMessages(sessionId).length === 0;
    check.commit(shown);
    if (!shown || !check.nudge) return null;
    const messageId = store.addMessage(sessionId, "assistant", check.nudge.text, now, { intent: "nudge", sources: check.nudge.sources.map(publicSource) });
    store.touchSession(sessionId, now, ""); // untitled (hidden in the sidebar) until the user writes
    return { messageId, nudge: check.nudge };
  }

  /**
   * One turn. The shared lifecycle lives here; what differs per intent lives in a handler
   * (turn/handlers/*), picked by the dispatcher table HANDLERS:
   *   store the message -> route (planned searches start meanwhile) -> handler gathers evidence ->
   *   answer (the model, with its bounded web_search loop on web intents, through the grounding guard)
   *   -> persist -> extract claims in the background.
   */
  async *chat(sessionId: string, rawText: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const { store, clock, timezone: tz } = this.deps;
    const text = rawText.trim().slice(0, MAX_INPUT);
    if (!text) {
      yield { type: "error", message: "Empty message." };
      return;
    }
    const now = clock.now();
    if (!store.getSession(sessionId)) store.createSession(sessionId, now);
    const userId = store.addMessage(sessionId, "user", text, now);
    store.touchSession(sessionId, now, text.slice(0, 80));
    const history = store
      .recentMessages(sessionId, userId, HISTORY_TURNS)
      .map((m) => ({ role: m.role, content: m.content }));
    // A conversation must start with a user turn.
    while (history.length && history[0]!.role !== "user") history.shift();
    const t = new Turn(this.deps, this.brands, this.watch, sessionId, userId, text, now, this.nowLabel(), parseTimeRefs(text, now, tz), history, signal);
    yield { type: "turn", sessionId, userMessageId: userId, at: now, atLabel: formatLocal(now, tz, now) };

    yield* routeTurn(t);
    const handler = HANDLERS[t.intent];
    try {
      yield* handler.gather(t);
    } catch (e) {
      if (signal?.aborted) return;
      t.notes.push(`Something failed while gathering evidence (${(e as Error).message}); say what could not be checked.`);
    }

    const failed = t.runs.filter((r) => r.error);
    if (failed.length && failed.length === t.runs.length) {
      yield { type: "warning", text: `Web search failed (${failed[0]!.error}). This answer is not backed by fresh sources.` };
      if (t.intent === "search") t.notes.push("Web search failed for every query; say so and do not state current facts.");
    }
    for (const r of t.runs) store.logSearch(userId, r.query, this.deps.search.name, r.purpose, r.error ? { error: r.error } : r.results, now);
    const evidenceMs = performance.now() - t.t0 - t.routeMs;
    if (t.sources.length) yield { type: "sources", sources: t.sources.map(publicSource) };

    yield* answer(t, handler.web);

    const stopped = signal?.aborted ?? false;
    const doneAt = clock.now();
    const timings: Timings = {
      routeMs: Math.round(t.routeMs),
      evidenceMs: Math.round(evidenceMs),
      firstStatusMs: t.firstStatusMs === null ? null : Math.round(t.firstStatusMs),
      firstTokenMs: t.firstTokenMs === null ? null : Math.round(t.firstTokenMs),
      firstModelTokenMs: t.firstModelTokenMs === null ? null : Math.round(t.firstModelTokenMs),
      totalMs: Math.round(performance.now() - t.t0),
    };
    const assistantId = store.addMessage(sessionId, "assistant", t.answer || (stopped ? "(stopped)" : "(no answer)"), doneAt, {
      intent: t.intent,
      via: t.plan.via,
      replyTo: userId,
      sources: t.sources.map(publicSource),
      warnings: t.warnings,
      notes: [...t.shown.filter((l) => !l.startsWith("|")), ...t.notes],
      timings,
      aborted: stopped,
    });
    store.touchSession(sessionId, doneAt, text.slice(0, 80));
    // A stopped turn keeps its partial text but teaches memory nothing (no re-check versions, no claims).
    if (t.recheckToSave && !stopped) saveRecheck(store, t.recheckToSave, assistantId, sessionId, doneAt);
    if (!stopped) this.remember(t, assistantId, doneAt);

    yield { type: "done", assistantMessageId: assistantId, at: doneAt, atLabel: formatLocal(doneAt, tz, doneAt), timings, loop: t.loop };
  }

  /**
   * Remember the checkable facts of new answers, off the critical path: under the subjects the agent
   * searched for, every product of a shortlist covered, and never a price marked unverified.
   */
  private remember(t: Turn, assistantId: number, doneAt: number): void {
    const { intent, sources, flagged } = t;
    if (!((intent === "search" || (intent === "verify" && !t.recheckToSave)) && sources.length && t.answer)) return;
    this.background(
      this.deps.llm.extractClaims({ question: t.question, answer: t.answer, sources }).then((claims) => {
        const known = fairCap(
          claims
            .filter((c) => c.subject && c.attribute && c.value)
            // A price no source backed is still worth re-checking, but it is stored as unverified, so
            // a later table says "then: $14 (unverified)" instead of presenting it as a sourced fact.
            .map((c) => (flagged.some((f) => sameValue(f, c.value)) && !/unverified/i.test(c.value) ? { ...c, value: `${c.value} (unverified)`, sourceUrl: null, sourceDate: null } : c))
            .map((c) => canonicalSubject(c, t.subjects)),
          MAX_STORED_CLAIMS,
          MAX_CLAIMS_PER_SUBJECT,
        );
        if (known.length) this.deps.store.addClaims(assistantId, t.sessionId, known, doneAt);
      }),
    );
  }

  private background(p: Promise<unknown>): void {
    const tracked = p.catch((e: Error) => console.error(`[background] ${e.message}`)).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }
}

