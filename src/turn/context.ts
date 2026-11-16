// One turn's state, shared by the stages of the lifecycle (route -> handler -> answer -> persist).
// The stages are generators that stream AgentEvents; this object is what they read and fill in.

import type { BrandBook } from "../brand.ts";
import type { AnswerInput, Intent, PastTurn, RoutePlan } from "../llm/types.ts";
import type { RecheckOutcome } from "../recheck.ts";
import type { QueryRun, Source } from "../search/rank.ts";
import type { ParsedTime } from "../timeparse.ts";
import type { WatchConfig } from "../watch.ts";
import { Updates } from "./progress.ts";
import type { AgentDeps, AgentEvent, SearchState } from "./types.ts";

type HistoryMessage = AnswerInput["history"][number];

export interface PlannedSearch {
  query: string;
  purpose: string;
  opts: { maxResults: number };
}

export class Turn {
  readonly t0 = performance.now();
  /** Progress from parallel work (searches finishing), yielded by `drain`. */
  readonly updates = new Updates();
  firstStatusMs: number | null = null;
  firstTokenMs: number | null = null;
  firstModelTokenMs: number | null = null;

  // ---- Routing (filled by routeTurn).
  /** What the rules decided before any model call (null = undecided). */
  rules: Omit<RoutePlan, "via"> | null = null;
  plan!: RoutePlan;
  routeMs = 0;
  /** Products named in the message (read by code); one planned search each. */
  subjects: string[] = [];
  /** The question as searched (and as the answer model reads it when the rules found a new question). */
  specQuery = "";
  /** Searches started before routing finished (the question + one per subject). */
  planned: PlannedSearch[] = [];
  spec: Promise<QueryRun[]> | null = null;
  /** The router's queries, when code found no subjects. */
  extra: string[] = [];

  // ---- Evidence (filled by the intent's handler).
  sources: Source[] = [];
  memory: PastTurn[] = [];
  notes: string[] = [];
  /** Code-rendered lines already shown above the reply (date reading, quotes, the re-check table). */
  shown: string[] = [];
  diff: AnswerInput["diff"];
  runs: QueryRun[] = [];
  recheckToSave: RecheckOutcome | null = null;
  /** The code-rendered lines are the whole answer (nothing to ask the model). */
  answeredByCode = false;

  // ---- Answer (filled by the answer stage).
  answer = "";
  flagged: string[] = [];
  warnings: string[] = [];

  constructor(
    readonly deps: AgentDeps,
    readonly brands: BrandBook,
    readonly watch: WatchConfig,
    readonly sessionId: string,
    readonly userId: number,
    readonly text: string,
    readonly now: number,
    readonly nowLabel: string,
    readonly parsed: ParsedTime,
    readonly history: HistoryMessage[],
    readonly signal?: AbortSignal,
  ) {}

  get tz(): string {
    return this.deps.timezone;
  }

  get intent(): Intent {
    return this.plan.intent;
  }

  /** The question as the answer model and claim extraction read it. */
  get question(): string {
    return this.rules?.intent === "search" ? this.specQuery : this.text;
  }

  /** The topic text the products of this turn are read from. */
  get topic(): string {
    return this.rules?.intent === "search" ? this.specQuery : this.parsed.rest;
  }

  status(text: string): AgentEvent {
    if (this.firstStatusMs === null) this.firstStatusMs = performance.now() - this.t0;
    return { type: "status", text };
  }

  /** A search step; it carries the product's site (for its logo): known names at once, the found site when done. */
  step(query: string, state: SearchState, results?: number, domain = this.brands.domainFor(query)): AgentEvent {
    return { type: "search", query, state, ...(results === undefined ? {} : { results }), ...(domain ? { domain } : {}) };
  }

  /** Code-rendered text (how a date was read, the quoted earlier question, the re-check table). */
  show(lines: string[]): AgentEvent | null {
    if (!lines.length) return null;
    this.shown.push(...lines);
    const t = `${lines.join("\n\n")}\n\n`;
    this.answer += t;
    if (this.firstTokenMs === null) this.firstTokenMs = performance.now() - this.t0;
    return { type: "delta", text: t };
  }

  /** Progress callbacks for runQueries: each search's step and status line, as it finishes. */
  readonly onRun = (run: QueryRun, done: number, total: number): void => {
    this.updates.push(this.step(run.query, run.error ? "failed" : "done", run.results.length, this.brands.fromResults(run.query, run.results)));
    this.updates.push(this.status(`${run.error ? "Search failed" : `${run.results.length} result${run.results.length === 1 ? "" : "s"}`} for "${run.query}" (${done} of ${total} searches done)`));
  };

  readonly onStart = (query: string): void => {
    this.updates.push(this.step(query, "running"));
  };
}
