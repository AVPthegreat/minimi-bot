// What the agent needs from a language model, as four narrow jobs. The real implementation is
// Anthropic Claude (anthropic.ts); the fake (fake.ts) is deterministic for tests and FAKE_MODE.

import type { ClaimRow, NewClaim } from "../db.ts";
import type { DiffRow } from "../claims.ts";
import type { Source } from "../search/rank.ts";
import type { SearchResult } from "../search/types.ts";

/** "updates" = "anything new?": re-check the whole watchlist (rules-routed only). */
export type Intent = "chat" | "recall" | "verify" | "search" | "updates";

export interface RoutePlan {
  intent: Intent;
  /** Topic words for looking up earlier conversations ("postgres hosting"). */
  memoryQuery: string;
  /** Web queries to run in parallel (0 for chat/recall). */
  searchQueries: string[];
  /** Restrict to news from the last N days (0 = no restriction). */
  sinceDays: number;
  /** Money, health, legal or other numbers where being wrong costs the user: cross-check sources. */
  highStakes: boolean;
  via: "rules" | "model" | "fallback";
}

export interface RouteInput {
  text: string;
  /** The text with time phrases removed ("Last Tuesday I asked about X" -> "I asked about X"). */
  rest: string;
  nowLabel: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  timePhrases: string[];
}

export interface PastTurn {
  userMessageId: number;
  when: string; // "Tue 10 Nov, 14:05"
  question: string;
  answer: string;
  claims: ClaimRow[];
  /** How the earlier question was routed ("chat" = small talk: nothing factual to re-check). */
  intent?: string;
}

export interface AnswerInput {
  intent: Intent;
  question: string;
  nowLabel: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  sources: Source[];
  memory: PastTurn[];
  /** Set for "is it still correct?": the table the user has already been shown. */
  diff?: { rows: DiffRow[]; table: string; thenLabel: string };
  /** Instructions for this turn (e.g. "web search failed for every query; say so"). */
  notes: string[];
  /**
   * What the user already sees above the reply, rendered by code: how a date was read, the quoted
   * earlier question(s), the re-check table. The model must not repeat or contradict it.
   */
  shown: string[];
  highStakes: boolean;
  /**
   * How many web searches the answer model may run itself: only when the agent's own planned searches
   * found nothing (the fallback loop). 0 = write only from the gathered sources (the normal case).
   */
  maxSelfSearches: number;
  signal?: AbortSignal;
}

/** What the answer model streams back: text, plus (when it searches on its own) what it looked up and cited. */
export type AnswerEvent =
  | { type: "text"; text: string }
  | { type: "searching"; query: string }
  | { type: "source"; result: SearchResult }
  | { type: "cite"; url: string; title: string | null; citedText: string };

export interface RecheckResult {
  value: string;
  unit: string | null;
  sourceN: number;
}

export interface LLM {
  readonly name: string;
  route(input: RouteInput): Promise<Omit<RoutePlan, "via">>;
  streamAnswer(input: AnswerInput): AsyncIterable<AnswerEvent>;
  extractClaims(input: { question: string; answer: string; sources: Source[] }): Promise<NewClaim[]>;
  /** For each claim, its current value according to `sources` (null = not stated there). */
  recheck(input: { claims: ClaimRow[]; sources: Source[] }): Promise<Array<RecheckResult | null>>;
}
