// The dispatcher: one handler per intent. A handler gathers the turn's evidence (memory, re-checks,
// searches) and may render lines itself; the shared lifecycle in Agent.chat does everything else.

import type { Intent } from "../../llm/types.ts";
import type { Turn } from "../context.ts";
import type { AgentEvent } from "../types.ts";
import { chatHandler } from "./chat.ts";
import { recallHandler } from "./recall.ts";
import { searchHandler } from "./search.ts";
import { updatesHandler } from "./updates.ts";
import { verifyHandler } from "./verify.ts";

export interface IntentHandler {
  /**
   * Web intents: the answer model gets its web_search tool for follow-up searches after the planned
   * round. Small talk and recall never search.
   */
  readonly web: boolean;
  /** Gather evidence into the turn, streaming progress and any code-rendered lines. */
  gather(t: Turn): AsyncGenerator<AgentEvent, void>;
}

export const HANDLERS: Record<Intent, IntentHandler> = {
  chat: chatHandler,
  recall: recallHandler,
  verify: verifyHandler,
  updates: updatesHandler,
  search: searchHandler,
};
