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
   * The answer model's one tool, web_search: how many more searches it may run this turn (the agent's
   * bounded loop; 0 = the tool is unavailable, write the answer now). Small talk and recall always get 0.
   */
  maxSelfSearches: number;
  /** Computed in code: for each product the question names, the planned sources that give it a price (empty = a gap). */
  coverage?: Array<{ subject: string; sources: number[] }>;
  /**
   * The tool rounds so far this turn, oldest first: what the model asked for and what the agent found.
   * `sources` above stays the planned round's evidence; sources found by the tool are in these results.
   */
  rounds: ToolRound[];
  signal?: AbortSignal;
}

export interface ToolCall {
  id: string;
  query: string;
}

/** One round of the agent loop: the model's tool calls and the agent's results (same order). */
export interface ToolRound {
  /** What the model wrote before calling the tool (already shown to the user). */
  text: string;
  calls: ToolCall[];
  /** The pages each call found, numbered like the other sources (cite as [n]), or why it did not run. */
  results: Array<{ id: string; sources: Source[]; error?: string }>;
  /** The provider's own record of the assistant turn (e.g. Anthropic content blocks), replayed as is. */
  state?: unknown;
}

/** What the answer model streams back: text, and the tool calls that end a round of the loop. */
export type AnswerEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; query: string }
  /** End of a round that called the tool: the provider's record of it (see ToolRound.state). */
  | { type: "round_state"; state: unknown };

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
  recheck(input: { claims: ClaimRow[]; sources: Source[]; signal?: AbortSignal }): Promise<Array<RecheckResult | null>>;
}
