// What the agent needs from a language model, as four narrow jobs. The real implementation is
// Anthropic Claude (anthropic.ts); the fake (fake.ts) is deterministic for tests and FAKE_MODE.

import type { ClaimRow, NewClaim } from "../db.ts";
import type { DiffRow } from "../claims.ts";
import type { Source } from "../search/rank.ts";

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
  /** One-liners the answer must state (e.g. how an ambiguous date was read). */
  notes: string[];
  highStakes: boolean;
  signal?: AbortSignal;
}

export interface RecheckResult {
  value: string;
  unit: string | null;
  sourceN: number;
}

export interface LLM {
  readonly name: string;
  route(input: RouteInput): Promise<Omit<RoutePlan, "via">>;
  streamAnswer(input: AnswerInput): AsyncIterable<string>;
  extractClaims(input: { question: string; answer: string; sources: Source[] }): Promise<NewClaim[]>;
  /** For each claim, its current value according to `sources` (null = not stated there). */
  recheck(input: { claims: ClaimRow[]; sources: Source[] }): Promise<Array<RecheckResult | null>>;
}
