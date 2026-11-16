// Finding the earlier conversation a message refers to ("last Tuesday I asked about Postgres
// hosting"). Time phrases narrow the window; topic words rank inside it (FTS5/BM25). When a
// phrase is ambiguous we try each reading and keep the one that has a matching conversation,
// then tell the user which reading we used.

import type { MessageRow, Store } from "./db.ts";
import type { PastTurn } from "./llm/types.ts";
import { formatLocal } from "./time.ts";
import type { TimeRef } from "./timeparse.ts";
import { stopwordsTopic } from "./router.ts";

export interface RecallResult {
  turns: PastTurn[];
  /** The window used, if the message named a time. */
  rangeLabel?: string;
  /**
   * Lines shown to the user above the answer, rendered by code: how the date was read ("Last Tuesday =
   * Tue 10 Nov"), or that nothing was found then. The live answer model often skipped these when it was
   * merely asked to state them, so they no longer depend on its wording.
   */
  notes: string[];
}

export function topicTerms(query: string): string[] {
  return [...new Set(stopwordsTopic(query).toLowerCase().split(/\s+/).filter((t) => t.length > 1 && !/^\d+$/.test(t)))].slice(0, 8);
}

function isContentTurn(m: MessageRow): boolean {
  // A question that was itself about memory ("what did I ask...") is a poor match for "what did I ask".
  // Chat turns stay in (a user may simply state their shortlist); a stated fact is still something they said.
  const intent = (JSON.parse(m.meta) as { intent?: string }).intent;
  return intent !== "recall";
}

export function recall(
  store: Store,
  opts: { refs: TimeRef[]; query: string; currentMessageId: number; sessionId: string; tz: string; nowMs: number; limit?: number },
): RecallResult {
  const terms = topicTerms(opts.query);
  const limit = opts.limit ?? 3;
  const notes: string[] = [];
  const toTurns = (rows: MessageRow[]) => rows.slice(0, limit).map((m) => toPastTurn(store, m, opts.tz, opts.nowMs));

  if (opts.refs.length > 0) {
    // "Today, check what I asked last Tuesday": the earlier time is the one being asked about.
    const ref = opts.refs.find((r) => !/today|this (morning|afternoon|evening)|tonight/i.test(r.phrase)) ?? opts.refs[0]!;
    for (const [i, range] of ref.candidates.entries()) {
      const inRange = store.userMessagesBetween(range.start, range.end, opts.currentMessageId).filter(isContentTurn);
      if (inRange.length === 0) continue;
      let pick = inRange;
      if (terms.length) {
        const hits = store.searchUserMessages(terms, { start: range.start, end: range.end, excludeId: opts.currentMessageId, limit: 10 }).filter(isContentTurn);
        if (hits.length === 0 && ref.candidates.length > 1 && i < ref.candidates.length - 1) continue; // try the other reading
        if (hits.length) pick = hits;
        else notes.push(`On ${range.label} you didn't ask about "${terms.join(" ")}"; here is what you did ask then.`);
      }
      const reading = ref.assumption
        ? i === 0 ? ` ${ref.assumption} I used ${range.label}.` : ` ${ref.assumption} You asked about this on ${range.label}, so I used that day.`
        : "";
      notes.unshift(`${dateLine(ref.phrase, range.label)}${reading}`);
      return { turns: toTurns(pick), rangeLabel: range.label, notes };
    }
    // Nothing in the window: say so, and offer the closest match by topic from any date.
    const labels = ref.candidates.map((c) => c.label).join(" or ");
    if (ref.candidates.length === 1) notes.push(dateLine(ref.phrase, labels));
    const near = terms.length ? store.searchUserMessages(terms, { excludeId: opts.currentMessageId, limit: 5 }).filter(isContentTurn) : [];
    if (near.length) {
      notes.push(`I have no conversation about this on ${labels}. The closest match is from ${formatLocal(near[0]!.created_at, opts.tz, opts.nowMs)}, so I used that.`);
      return { turns: toTurns(near), notes };
    }
    notes.push(`I have no record of a conversation on ${labels}.`);
    return { turns: [], notes };
  }

  if (terms.length) {
    const hits = store.searchUserMessages(terms, { excludeId: opts.currentMessageId, limit: 10 }).filter(isContentTurn);
    if (hits.length) return { turns: toTurns(hits), notes };
  }
  // "Is that still correct?" with no time and no topic: the previous question in this session.
  const prev = store.recentMessages(opts.sessionId, opts.currentMessageId, 10).filter((m) => m.role === "user" && isContentTurn(m));
  if (prev.length) return { turns: [toPastTurn(store, prev[prev.length - 1]!, opts.tz, opts.nowMs)], notes };
  return { turns: [], notes: [terms.length ? `I couldn't find an earlier conversation about "${terms.join(" ")}".` : "I couldn't find an earlier conversation to check."] };
}

/** "Last Tuesday = Tue 10 Nov." ("on Monday" is shown as "Monday"). */
function dateLine(phrase: string, label: string): string {
  const said = phrase.replace(/^on\s+/i, "").trim();
  return `**${said.charAt(0).toUpperCase()}${said.slice(1)} = ${label}.**`;
}

export function toPastTurn(store: Store, m: MessageRow, tz: string, nowMs: number): PastTurn {
  const answer = store.answerTo(m.id);
  return {
    userMessageId: m.id,
    when: formatLocal(m.created_at, tz, nowMs),
    question: m.content,
    // Old citation numbers point at old source lists; drop them so they are never re-linked to new sources.
    answer: answer ? answer.content.replace(/\s?\[\d{1,2}\]/g, "") : "(no answer was recorded)",
    claims: answer ? store.claimsFor(answer.id) : [],
  };
}
