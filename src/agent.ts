// The agent core. One turn:
//   save the message (with its time) -> resolve time phrases -> plan searches in code and start them
//   while routing -> gather evidence (nothing | memory | one search per subject | claim re-checks), with
//   progress lines as each search finishes -> show code-rendered lines (date reading, quote, table) ->
//   stream the answer through the grounding guard -> save -> extract claims in the background.
// Everything the UI, the CLI and the eval use goes through this class.

import { randomUUID } from "node:crypto";
import { BrandBook } from "./brand.ts";
import { type EvidenceDoc, priceChecker, questionMultipliers, renderDiffTable, sameValue, summarizeDiff } from "./claims.ts";
import { GroundingGuard } from "./grounding.ts";
import { NOT_NAMES, canonicalSubject, fairCap, planSubjects, subjectQueries } from "./planner.ts";
import type { ClaimRow, SessionRow, Store } from "./db.ts";
import type { AnswerInput, Intent, LLM, PastTurn, RoutePlan } from "./llm/types.ts";
import { recall, toPastTurn } from "./memory.ts";
import { dedupeClaims, recheckClaims, saveRecheck } from "./recheck.ts";
import { route, rulesRoute } from "./router.ts";
import { type QueryRun, type Source, domainOf, isOfficialFor, rankSources, runQueries } from "./search/rank.ts";
import type { SearchProvider, SearchResult } from "./search/types.ts";
import { type Clock, civilDateOf, daysBetween, formatCivil, formatLocal } from "./time.ts";
import { parseTimeRefs } from "./timeparse.ts";
import { type Nudge, type WatchConfig, checkWatchlist, dueClaims, rowsToShow } from "./watch.ts";

export interface AgentDeps {
  store: Store;
  llm: LLM;
  search: SearchProvider;
  clock: Clock;
  timezone: string;
  watch?: WatchConfig;
  /** Web searches the answer model may run itself when prefetched sources fall short (default 3, 0 = off). */
  maxSelfSearches?: number;
  /** What a failure says to the user (the hosted demo hides provider details); default: the error's message. */
  publicError?: (e: Error) => string;
}

export type AgentEvent =
  | { type: "turn"; sessionId: string; userMessageId: number; at: number; atLabel: string }
  | { type: "status"; text: string }
  /** One web search's progress, for a step list in the UI (the status lines say the same in words). */
  | { type: "search"; query: string; state: SearchState; results?: number; domain?: string }
  | { type: "route"; intent: Intent; via: RoutePlan["via"]; queries: string[] }
  | { type: "sources"; sources: PublicSource[] }
  | { type: "delta"; text: string }
  | { type: "warning"; text: string }
  | { type: "done"; assistantMessageId: number; at: number; atLabel: string; timings: Timings }
  | { type: "error"; message: string };

export type SearchState = "running" | "done" | "failed" | "cancelled";

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
  /** First progress line ("Searching the web for ..."). */
  firstStatusMs: number | null;
  /** First answer text of any kind, including code-rendered lines (date reading, quote, table). */
  firstTokenMs: number | null;
  /** First token written by the answer model. */
  firstModelTokenMs: number | null;
  totalMs: number;
}

const HISTORY_TURNS = 8;
/** While a speculative search is already running, wait at most this long for the router model. */
const SPECULATIVE_ROUTER_TIMEOUT_MS = 1500;
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
   */
  async nudge(sessionId: string): Promise<{ messageId: number; nudge: Nudge } | null> {
    const { store, clock, timezone } = this.deps;
    if (!store.getSession(sessionId) || store.sessionMessages(sessionId).length > 0) return null;
    const now = clock.now();
    const nudge = await checkWatchlist({ ...this.deps, tz: timezone }, sessionId, now, this.watch);
    // The check took a while: if the user started talking meanwhile, drop the nudge rather than wedge it
    // between their question and its answer. (node:sqlite is synchronous, so check-then-insert is atomic.)
    if (!nudge || store.sessionMessages(sessionId).length > 0) return null;
    const messageId = store.addMessage(sessionId, "assistant", nudge.text, now, { intent: "nudge", sources: nudge.sources.map(publicSource) });
    store.touchSession(sessionId, now, ""); // untitled (hidden in the sidebar) until the user writes
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

    // Progress from work running in parallel (each search as it finishes) reaches the user at once.
    const updates = new Updates();
    let firstStatusMs: number | null = null;
    const status = (t: string): AgentEvent => {
      if (firstStatusMs === null) firstStatusMs = performance.now() - t0;
      return { type: "status", text: t };
    };
    // Search steps carry the product's site (for its logo): known names at once, the found site when done.
    const step = (query: string, state: SearchState, results?: number, domain = this.brands.domainFor(query)): AgentEvent => ({
      type: "search", query, state, ...(results === undefined ? {} : { results }), ...(domain ? { domain } : {}),
    });
    const onRun = (run: QueryRun, done: number, total: number) => {
      updates.push(step(run.query, run.error ? "failed" : "done", run.results.length, this.brands.fromResults(run.query, run.results)));
      updates.push(status(`${run.error ? "Search failed" : `${run.results.length} result${run.results.length === 1 ? "" : "s"}`} for "${run.query}" (${done} of ${total} searches done)`));
    };
    const onStart = (query: string) => updates.push(step(query, "running"));

    // The agent owns the search plan. When the rules can't decide, the message is most likely a web
    // question, so the searches start right away while the router model decides: the raw question
    // (speculative) plus, for a comparison, one search per subject named in the message (read by code).
    // If the router says no search is needed, they are cancelled.
    const routeInput = { text, rest: parsed.rest, nowLabel, history, timePhrases: parsed.refs.map((r) => r.phrase) };
    const rules = rulesRoute(text, parsed.refs.length > 0, history.length > 0, parsed.rest);
    // Rules that already know it is a web question (a new question inside a follow-up) plan like an
    // undecided message, but on that question only.
    const undecided = rules === null || rules.intent === "search";
    const specQuery = rules?.intent === "search" ? rules.searchQueries[0]! : text.slice(0, 300);
    const subjects = undecided ? planSubjects(rules?.intent === "search" ? specQuery : parsed.rest) : [];
    const planned = undecided
      ? [
          { query: specQuery, purpose: "speculative", opts: { maxResults: 5 } },
          ...subjectQueries(subjects, parsed.rest).map((q) => ({ query: q, purpose: "answer", opts: { maxResults: 5 } })),
        ]
      : [];
    const specAbort = new AbortController();
    const spec = planned.length
      ? runQueries(this.deps.search, planned, signal ? AbortSignal.any([specAbort.signal, signal]) : specAbort.signal, (...a) => {
          if (!specAbort.signal.aborted) onRun(...a);
        })
      : null;
    if (spec) {
      yield status(subjects.length
        ? `Searching the web for ${subjects.join(", ")} (${planned.length} searches in parallel)`
        : `Searching the web: ${specQuery.slice(0, 120)}`);
      for (const p of planned) yield step(p.query, "running");
    }
    const plan = await route(llm, routeInput, { timeoutMs: spec ? SPECULATIVE_ROUTER_TIMEOUT_MS : 4000 });
    if (spec && plan.intent !== "search") {
      specAbort.abort();
      // Searches that finished meanwhile must not reappear after their "cancelled" step.
      updates.drop((e) => e.type === "search");
      for (const p of planned) yield step(p.query, "cancelled");
    }
    const routeMs = performance.now() - t0;
    store.updateMessageMeta(userId, { intent: plan.intent });
    // Code found the subjects: that plan is already running. Otherwise the router's queries are added.
    const extra = plan.intent === "search" && !subjects.length ? plan.searchQueries.filter((q) => !(spec && sameQuery(q, specQuery))) : [];
    const queries = plan.intent === "search" ? [...planned.map((p) => p.query), ...extra] : plan.searchQueries;
    yield { type: "route", intent: plan.intent, via: plan.via, queries };

    let sources: Source[] = [];
    let memory: PastTurn[] = [];
    const notes: string[] = [];
    const shown: string[] = [];
    let answer = "";
    let firstTokenMs: number | null = null;
    let firstModelTokenMs: number | null = null;
    // Code-rendered text (how a date was read, the quoted earlier question, the re-check table).
    const show = (lines: string[]): AgentEvent | null => {
      if (!lines.length) return null;
      shown.push(...lines);
      const t = `${lines.join("\n\n")}\n\n`;
      answer += t;
      if (firstTokenMs === null) firstTokenMs = performance.now() - t0;
      return { type: "delta", text: t };
    };
    let diff: AnswerInput["diff"];
    const runs: QueryRun[] = [];
    let recheckToSave: Parameters<typeof saveRecheck>[1] | null = null;
    /** The code-rendered lines are the whole answer (nothing to ask the model). */
    let answeredByCode = false;
    const intent: Intent = plan.intent;

    try {
      if (plan.intent === "recall" || plan.intent === "verify") {
        const r = recall(store, { refs: parsed.refs, query: plan.memoryQuery || parsed.rest, currentMessageId: userId, sessionId, tz, nowMs: now });
        memory = r.turns;
        const quotes = memory.map((t) => `You asked on ${t.when}: "${t.question.replace(/\s+/g, " ")}"`);
        const ev = show([...r.notes, ...quotes]);
        if (ev) yield ev;
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
          const nSubjects = new Set(claims.map((c) => c.subject.toLowerCase())).size;
          yield status(`Re-checking ${claims.length} fact${claims.length > 1 ? "s" : ""} about ${nSubjects} subject${nSubjects > 1 ? "s" : ""} from ${thenLabel}`);
          const maxQueries = plan.intent === "updates" ? this.watch.maxSearches : 5;
          const outcome = yield* drain(recheckClaims(this.deps, claims, { nowMs: now, maxQueries, newsSinceDays: sinceDays, signal, onRun, onStart }), updates);
          runs.push(...outcome.runs);
          sources = outcome.sources;
          // "Anything new?" shows a short table (changes first); every fact was still re-checked and saved.
          const rows = plan.intent === "updates" ? rowsToShow(outcome.rows) : outcome.rows;
          const hidden = outcome.rows.length - rows.length;
          const table = renderDiffTable(rows, thenLabel, formatCivil(civilDateOf(now, tz), civilDateOf(now, tz)));
          diff = { rows, table, thenLabel };
          recheckToSave = outcome;
          const more = hidden ? [`(${hidden} more fact${hidden > 1 ? "s" : ""} checked: ${countBy(outcome.rows.filter((r) => !rows.includes(r)))}.)`] : [];
          const ev = show([summarizeDiff(outcome.rows, thenLabel), table, ...more]);
          if (ev) yield ev;
        } else if (plan.intent === "verify" && memory.length && memory.every((t) => t.intent === "chat")) {
          // Small talk ("hi", "who made you") states no checkable fact: searching it again finds noise.
          const ev = show([`That was small talk ("${memory[0]!.question.replace(/\s+/g, " ").slice(0, 80)}"), so there's nothing factual in my answer to re-check. Ask me a question about prices, plans or releases and I can check it against current sources.`]);
          if (ev) yield ev;
          answeredByCode = true;
        } else if (plan.intent === "verify" && memory.length) {
          // The earlier answer had no stored facts: search the earlier question again and let the
          // model compare old answer and fresh sources.
          const q = memory[0]!.question.slice(0, 300);
          yield status(`Searching again: ${q}`);
          yield step(q, "running");
          runs.push(...(yield* drain(runQueries(this.deps.search, [{ query: q, purpose: "verify-freeform" }], signal, onRun), updates)));
          sources = rankSources(runs, [], now);
        } else if (plan.intent === "updates") {
          const ev = show(["I'm not tracking any facts yet. Ask me about prices, plans or releases and I'll keep an eye on them."]);
          if (ev) yield ev;
        }
      }

      if (plan.intent === "search") {
        if (extra.length) yield status(`Searching the web: ${extra.join(" | ")}`);
        for (const q of extra) yield step(q, "running");
        const extraRuns = extra.length
          ? runQueries(
              this.deps.search,
              extra.map((q) => ({
                query: q,
                purpose: "answer",
                opts: { maxResults: plan.highStakes ? 6 : 5, ...(plan.sinceDays ? { sinceDays: plan.sinceDays } : {}) },
              })),
              signal,
              onRun,
            )
          : Promise.resolve([]);
        const [specRuns, planRuns] = yield* drain(Promise.all([spec ?? Promise.resolve([]), extraRuns]), updates);
        runs.push(...specRuns, ...planRuns);
        // Every subject keeps at least its best page, so no product of a comparison goes unsourced.
        sources = rankSources(runs, subjects.length ? subjects : plan.searchQueries, now, Math.max(8, subjects.length * 2 + 2), { coverEachQuery: subjects.length > 0 });
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

    // ---- Answer. The model writes from the gathered sources only; it gets its own web_search (the
    // fallback loop) only when the planned searches found nothing at all.
    const selfSearches: string[] = [];
    const addSource = (r: SearchResult): { source: Source; added: boolean } => {
      const existing = sources.find((x) => x.url === r.url);
      if (existing) return { source: existing, added: false };
      const source: Source = { ...r, n: sources.length + 1, domain: domainOf(r.url), official: isOfficialFor(r.url, plan.searchQueries), query: "(answer model)" };
      sources.push(source);
      return { source, added: true };
    };
    const webIntent = intent === "search" || intent === "verify" || intent === "updates";
    const maxSelfSearches = webIntent && sources.length === 0 ? (this.deps.maxSelfSearches ?? 3) : 0;

    // ---- Grounding, enforced while streaming: every price the model writes must be backed by CURRENT
    // evidence (the gathered sources, passages it cited, the computed diff table), or it is marked
    // "(unverified)" before the user sees it. Old answers are not evidence for today's prices; only a
    // pure recall answer may quote them, as history.
    const evidence = (): EvidenceDoc[] => [
      ...sources.map((x) => ({ n: x.n, text: `${x.title}\n${x.snippet}`, about: `${siteName(x.url)} ${x.query === specQuery ? x.title : `${x.title} ${x.query}`}` })),
      { text: diff?.table ?? "" },
      // What was said before (the earlier answer, earlier in this chat) backs a price only as history:
      // fully in a recall answer, and elsewhere only where the sentence says it was the price then.
      ...memory.map((t) => ({ text: t.answer, pastOnly: intent !== "recall" })),
      ...history.filter((m) => m.role === "assistant").map((m) => ({ text: m.content, pastOnly: intent !== "recall" })),
    ];
    const multipliers = questionMultipliers(text);
    // The products this turn is about: what decides which product a price belongs to.
    const names = (): string[] => [
      ...subjects,
      ...productWords(rules?.intent === "search" ? specQuery : parsed.rest),
      ...memory.flatMap((t) => [...t.claims.map((c) => c.subject), ...productWords(t.question)]),
      ...(diff?.rows.map((r) => r.subject) ?? []),
      ...sources.map((x) => siteName(x.url)),
    ];
    const guard = new GroundingGuard((line, before) => priceChecker(evidence(), { multipliers, names: names() })(line, `${shown.join("\n")}\n${before}`));
    const out = (t: string): AgentEvent | null => {
      const safe = guard.push(t);
      if (!safe) return null;
      if (firstTokenMs === null) firstTokenMs = performance.now() - t0;
      if (firstModelTokenMs === null) firstModelTokenMs = performance.now() - t0;
      answer += safe;
      return { type: "delta", text: safe };
    };
    try {
      if (signal?.aborted) throw new Error("stopped");
      if (!answeredByCode) for await (const ev of llm.streamAnswer({
        intent: intent === "updates" ? "verify" : intent,
        question: rules?.intent === "search" ? specQuery : text,
        nowLabel,
        history,
        sources,
        memory,
        diff,
        notes,
        shown,
        highStakes: plan.highStakes,
        maxSelfSearches,
        signal,
      })) {
        if (ev.type === "text") {
          const d = out(ev.text);
          if (d) yield d;
        } else if (ev.type === "searching") {
          selfSearches.push(ev.query);
          yield status(`Searching the web: ${ev.query}`);
          yield step(ev.query, "running"); // the model's own search: no per-search end, the UI closes it on "done"
        } else if (ev.type === "source") {
          if (addSource(ev.result).added) yield { type: "sources", sources: sources.map(publicSource) };
        } else if (ev.type === "cite") {
          const { source, added } = addSource({ title: ev.title ?? ev.url, url: ev.url, snippet: "" });
          if (!source.snippet.includes(ev.citedText)) source.snippet = `${source.snippet} ${ev.citedText}`.trim().slice(0, 2000);
          if (added) yield { type: "sources", sources: sources.map(publicSource) };
          const tag = ` [${source.n}]`;
          if (!answer.endsWith(tag)) {
            const d = out(tag);
            if (d) yield d;
          }
        }
      }
    } catch (e) {
      if (!signal?.aborted) {
        const message = this.deps.publicError ? this.deps.publicError(e as Error) : (e as Error).message;
        const d = out(`\n\n(The model failed before finishing: ${message})`);
        if (d) yield d;
        yield { type: "error", message };
      }
    }
    const tail = guard.end();
    if (tail) {
      answer += tail;
      yield { type: "delta", text: tail };
    }
    for (const q of selfSearches) {
      store.logSearch(userId, q, "answer-model web_search", "self-search", sources.filter((x) => x.query === "(answer model)"), now);
    }

    const flagged = [...new Set(guard.flagged)];
    const warnings = flagged.map((p) => `I couldn't match ${p} to a current source. Treat it as unverified.`);
    for (const w of warnings) yield { type: "warning", text: w };

    const stopped = signal?.aborted ?? false;
    const doneAt = clock.now();
    const timings: Timings = {
      routeMs: Math.round(routeMs),
      evidenceMs: Math.round(evidenceMs),
      firstStatusMs: firstStatusMs === null ? null : Math.round(firstStatusMs),
      firstTokenMs: firstTokenMs === null ? null : Math.round(firstTokenMs),
      firstModelTokenMs: firstModelTokenMs === null ? null : Math.round(firstModelTokenMs),
      totalMs: Math.round(performance.now() - t0),
    };
    const assistantId = store.addMessage(sessionId, "assistant", answer || (stopped ? "(stopped)" : "(no answer)"), doneAt, {
      intent,
      via: plan.via,
      replyTo: userId,
      sources: sources.map(publicSource),
      warnings,
      notes: [...shown.filter((l) => !l.startsWith("|")), ...notes],
      timings,
      aborted: stopped,
    });
    store.touchSession(sessionId, doneAt, text.slice(0, 80));
    // A stopped turn keeps its partial text but teaches memory nothing (no re-check versions, no claims).
    if (recheckToSave && !stopped) saveRecheck(store, recheckToSave, assistantId, sessionId, doneAt);

    // ---- Remember the checkable facts of new answers, off the critical path: under the subjects the
    // agent searched for, every product of a shortlist covered, and never a price marked unverified.
    if (!stopped && (intent === "search" || (intent === "verify" && !recheckToSave)) && sources.length && answer) {
      this.background(
        llm.extractClaims({ question: rules?.intent === "search" ? specQuery : text, answer, sources }).then((claims) => {
          const known = fairCap(
            claims
              .filter((c) => c.subject && c.attribute && c.value)
              // A price no source backed is still worth re-checking, but it is stored as unverified, so
              // a later table says "then: $14 (unverified)" instead of presenting it as a sourced fact.
              .map((c) => (flagged.some((f) => sameValue(f, c.value)) && !/unverified/i.test(c.value) ? { ...c, value: `${c.value} (unverified)`, sourceUrl: null, sourceDate: null } : c))
              .map((c) => canonicalSubject(c, subjects)),
            MAX_STORED_CLAIMS,
            MAX_CLAIMS_PER_SUBJECT,
          );
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

/** The site's own name: "docs.railway.com" -> "railway", "neon.com" -> "neon". */
function siteName(url: string): string {
  const parts = domainOf(url).split(".");
  return parts.length >= 2 ? parts[parts.length - 2]! : parts[0]!;
}

/** Capitalised words of a question that are not sentence openers or dates ("Cloudflare", "Workers"). */
function productWords(text: string): string[] {
  return [...text.matchAll(/(?<![.!?]\s|^)\b[A-Z][\w.+&-]{2,}/g)].map((m) => m[0]).filter((w) => !NOT_NAMES.has(w));
}

function sameQuery(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return norm(a) === norm(b);
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

/** Events produced by parallel work (searches finishing), queued until the turn's generator yields them. */
class Updates {
  private items: AgentEvent[] = [];
  private wake: (() => void) | null = null;
  push(e: AgentEvent): void {
    this.items.push(e);
    this.wake?.();
  }
  take(): AgentEvent[] {
    return this.items.splice(0);
  }
  drop(match: (e: AgentEvent) => boolean): void {
    this.items = this.items.filter((e) => !match(e));
  }
  next(): Promise<void> {
    return new Promise((r) => (this.wake = r));
  }
}

/** Await `p`, yielding progress events as they arrive; returns p's value (use with `yield*`). */
async function* drain<T>(p: Promise<T>, updates: Updates): AsyncGenerator<AgentEvent, T> {
  let settled = false;
  const done = p.finally(() => {
    settled = true;
  });
  done.catch(() => {});
  while (!settled) {
    for (const e of updates.take()) yield e;
    if (settled) break;
    await Promise.race([done.then(() => undefined, () => undefined), updates.next()]);
  }
  for (const e of updates.take()) yield e;
  return await p;
}

/** "2 unchanged, 1 couldn't verify" for rows left out of a short table. */
function countBy(rows: Array<{ status: string }>): string {
  const n = (st: string) => rows.filter((r) => r.status === st).length;
  return [n("unchanged") ? `${n("unchanged")} unchanged` : "", n("unverified") ? `${n("unverified")} couldn't verify` : "", n("changed") ? `${n("changed")} more changed` : ""]
    .filter(Boolean)
    .join(", ");
}
