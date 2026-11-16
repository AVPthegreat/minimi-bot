// Routing: decide how much work a message needs before doing any of it.
// 1) Rules catch the obvious cases for free (greetings, "what did I ask...", "still correct?").
// 2) Everything else goes to the small model, with a short timeout.
// 3) If the small model is slow or fails, a rules fallback still answers (search with the text).

import type { LLM, RouteInput, RoutePlan } from "./llm/types.ts";

const CHITCHAT =
  /^\s*(hi|hello|hey|yo|hiya|thanks|thank you|thx|ok|okay|cool|great|nice|good (morning|afternoon|evening|night)|bye|see you|who are you|what are you|who (made|built|created|trained) you|what can you do)\b[\s!.?,a-z]{0,20}$/i;

const RECALL =
  /\b(what (did|have) (i|we) (ask|asked|say|said|talk|talked|discuss|discussed)|what (i|we) (asked|said|talked about|discussed)|did i (ask|mention|say)|when did i (ask|mention)|what (was|were) (my|our) (question|questions)|what did you (say|tell|answer|recommend)|remind me what|what have we (talked|discussed))\b/i;

const VERIFY =
  /\b(still (correct|true|accurate|valid|right|the case|current)|(has|have|did) (anything|any of (them|these|those)|it|they|(the |any |their |its )?(price|pricing|prices|plan|plans))[\w\s]{0,30}\b(chang|updat|ship|launch|releas)|chang\w* since|(any|anything) (new|changes?|updates?)\b[\w\s]{0,20}\bsince|since then|up to date|out of date|outdated|re-?check|double[- ]check|verify (that|this|it|your))/i;

const UPDATES = /^\s*(any|anything|what'?s|whats|what is)\s+(new|updates?|changed?)\b[\s\w]{0,25}\??\s*$/i;

const PAST_POINTER =
  /\b(i asked|you (said|told|answered|recommended)|we (shortlisted|discussed|talked|picked|chose|compared)|your (answer|reply)|that answer|earlier|before|last time|previously)\b/i;

export function stopwordsTopic(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}\s+-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !TOPIC_STOP.has(w.toLowerCase()))
    .join(" ")
    .trim();
}

const TOPIC_STOP = new Set(
  (
    "a an the of for to in on at and or is are was were be been what which who whom how much many does do did done any anything has have had " +
    "since then still correct true accurate valid right current currently today now i me my we our us you your it its that this these those there " +
    "their them they ask asked say said tell told answer answered about question questions changed change changes update updates updated shipped " +
    "ship launched launch released release big something new anymore again please can could would should will just also earlier before last time " +
    "previously recheck check verify up date out remind talk talked discuss discussed shortlisted shortlist picked compared mention mentioned"
  ).split(" "),
);

/** Rules-only routing. Returns null when the rules are not sure (the model decides then). */
export function rulesRoute(text: string, hasTimeRef: boolean, hasHistory: boolean, rest = text): Omit<RoutePlan, "via"> | null {
  const topic = stopwordsTopic(rest);
  if (CHITCHAT.test(text)) {
    return { intent: "chat", memoryQuery: "", searchQueries: [], sinceDays: 0, highStakes: false };
  }
  if (UPDATES.test(text) && !/\b(in|about|with|for)\s+[a-z]/i.test(text)) {
    return { intent: "updates", memoryQuery: "", searchQueries: [], sinceDays: 0, highStakes: false };
  }
  const verify = VERIFY.test(text);
  // A message that carries its own new question next to the follow-up phrase ("What does X cost?" then
  // "Is that still correct?") is that new question, not a re-check of the previous answer (live bug).
  const own = verify ? ownQuestion(text) : null;
  if (own) {
    return { intent: "search", memoryQuery: stopwordsTopic(own), searchQueries: [own.slice(0, 300)], sinceDays: 0, highStakes: /pric|cost|\$|fee|plan/i.test(own) };
  }
  const pointsBack = hasTimeRef || PAST_POINTER.test(text) || (hasHistory && /\b(that|it|this|those|them)\b/i.test(text));
  if (verify && pointsBack) {
    return { intent: "verify", memoryQuery: topic, searchQueries: [], sinceDays: 0, highStakes: /pric|cost|\$|plan/i.test(text) };
  }
  if (RECALL.test(text)) {
    return { intent: "recall", memoryQuery: topic, searchQueries: [], sinceDays: 0, highStakes: false };
  }
  return null;
}

/**
 * The new question inside a message that also says "is that still correct?", or null when the message
 * is essentially the follow-up itself. A part counts as a new question when it is phrased as one (ends
 * with "?" or starts "compare"), names a topic of its own, and is neither a follow-up nor about memory
 * ("What did I ask on 3 Nov? Is it still correct?" stays a re-check).
 */
export function ownQuestion(text: string): string | null {
  const parts = text
    .split(/["“”]|(?<=[?!.])\s+/)
    .map((p) => p.trim().replace(/^(then|and|also|so|plus|after that)\b[\s,:]*/i, "").trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  for (const p of parts) {
    if (VERIFY.test(p) || RECALL.test(p) || UPDATES.test(p) || PAST_POINTER.test(p)) continue;
    if (!/\?\s*$/.test(p) && !/^compare\b/i.test(p)) continue;
    if (stopwordsTopic(p).split(/\s+/).filter(Boolean).length < 2) continue;
    return p;
  }
  return null;
}

/** Used only when the model router fails: treat it as a web question. */
export function fallbackRoute(text: string): Omit<RoutePlan, "via"> {
  const looksLikeChat = text.trim().split(/\s+/).length <= 3 && !/\?/.test(text);
  return {
    intent: looksLikeChat ? "chat" : "search",
    memoryQuery: stopwordsTopic(text),
    searchQueries: looksLikeChat ? [] : [text.slice(0, 300)],
    sinceDays: 0,
    highStakes: /pric|cost|\$|fee|salary|dose|tax|legal/i.test(text),
  };
}

/** One query per product in a comparison; five covers a typical shortlist. */
export const MAX_QUERIES = 5;

export async function route(
  llm: LLM,
  input: RouteInput,
  opts: { timeoutMs?: number } = {},
): Promise<RoutePlan> {
  const rules = rulesRoute(input.text, input.timePhrases.length > 0, input.history.length > 0, input.rest);
  if (rules) return { ...rules, via: "rules" };
  try {
    const plan = await withTimeout(llm.route(input), opts.timeoutMs ?? 4000);
    const queries = [...new Set(plan.searchQueries.map((q) => q.trim()).filter(Boolean))].slice(0, MAX_QUERIES);
    if (plan.intent === "search" && queries.length === 0) queries.push(input.text.slice(0, 300));
    return { ...plan, searchQueries: queries, via: "model" };
  } catch {
    return { ...fallbackRoute(input.text), via: "fallback" };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("router timeout")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
