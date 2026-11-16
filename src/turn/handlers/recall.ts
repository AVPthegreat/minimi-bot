// "What did I ask you last Tuesday?": the dated memory, quoted by code. No searches.

import { recall } from "../../memory.ts";
import type { Turn } from "../context.ts";
import type { AgentEvent } from "../types.ts";
import type { IntentHandler } from "./index.ts";

/** Find the earlier turns the message points at and show how the date was read and what was asked. */
export function* recallMemory(t: Turn): Generator<AgentEvent> {
  const r = recall(t.deps.store, {
    refs: t.parsed.refs,
    query: t.plan.memoryQuery || t.parsed.rest,
    currentMessageId: t.userId,
    sessionId: t.sessionId,
    tz: t.tz,
    nowMs: t.now,
  });
  t.memory = r.turns;
  const quotes = t.memory.map((m) => `You asked on ${m.when}: "${m.question.replace(/\s+/g, " ")}"`);
  const ev = t.show([...r.notes, ...quotes]);
  if (ev) yield ev;
}

export const recallHandler: IntentHandler = {
  web: false,
  async *gather(t) {
    yield* recallMemory(t);
  },
};
