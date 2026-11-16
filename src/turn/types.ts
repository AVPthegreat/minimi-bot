// The types a turn produces and depends on: the events streamed to the UI, the CLI and the eval, and
// the parts the agent is built from.

import type { Store } from "../db.ts";
import type { Intent, LLM, RoutePlan } from "../llm/types.ts";
import type { Source } from "../search/rank.ts";
import type { SearchProvider } from "../search/types.ts";
import type { Clock } from "../time.ts";
import type { WatchConfig } from "../watch.ts";

export interface AgentDeps {
  store: Store;
  llm: LLM;
  search: SearchProvider;
  clock: Clock;
  timezone: string;
  watch?: WatchConfig;
  /** Follow-up web searches the answer model may run itself per turn, after the planned round (default 3, 0 = off). */
  maxSelfSearches?: number;
  /** The spend cap: checked before each follow-up search round; when it is reached the loop stops searching. */
  meter?: { check(): void };
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
  /** A short line from the page, for the source card. */
  quote?: string;
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

export function publicSource(s: Source): PublicSource {
  const quote = s.snippet?.trim() === s.title.trim() ? "" : quoteOf(s.snippet);
  return { n: s.n, title: s.title, url: s.url, domain: s.domain, date: s.publishedDate, official: s.official, ...(quote ? { quote } : {}) };
}

/** A short line from the page for the source card (shown as plain text, never as instructions or HTML). */
function quoteOf(snippet: string | undefined): string {
  const flat = (snippet ?? "").replace(/^[\s>*•-]+/gm, " ").replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157).replace(/\s+\S*$/, "")}…` : flat;
}
