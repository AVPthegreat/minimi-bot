// "Is now the right moment to tell them?" A changed fact becomes a nudge only when its score passes a
// threshold. The score is a product of three small, explainable factors, each in 0..1:
//
//   score = importance × magnitude × timeliness
//
//   importance  how much the user cares: asked once (0.3), compared or shortlisted it (+0.25),
//               asked about it in more than one message (+0.25), asked me to watch it (+0.5); capped at 1.
//   magnitude   how big the change is: relative money change / fullChange (a 20% move = 1), capped at 1;
//               a non-numeric change (a plan, feature or unit) = 0.6; gone or unavailable = 1.
//   timeliness  how recent their interest is: 0.5 ^ (days since they last asked / halfLifeDays). A date
//               they mentioned ("we renew on 1 Dec") that is coming up within `dateWindowDays` makes it 1.
//               A fact they asked me to watch never decays below `watchedFloor`.
//
// Everything here is plain code over the store: no model call, testable with a fake clock, and the
// reasons behind a score are kept so the nudge can say WHY now.

import { parseValue, sameUnit } from "./claims.ts";
import type { ClaimRow, MessageRow, Store } from "./db.ts";

export interface RightMomentConfig {
  /** A change is announced only when importance × magnitude × timeliness reaches this. */
  threshold: number;
  base: number;
  compared: number;
  repeated: number;
  watched: number;
  /** Relative change that counts as a full-size change (0.2 = 20%). */
  fullChange: number;
  /** Magnitude of a change that is not a number (a plan, a feature, a unit). */
  textChange: number;
  halfLifeDays: number;
  watchedFloor: number;
  dateWindowDays: number;
}

export const RIGHT_MOMENT_DEFAULTS: RightMomentConfig = {
  threshold: 0.15,
  base: 0.3,
  compared: 0.25,
  repeated: 0.25,
  watched: 0.5,
  fullChange: 0.2,
  textChange: 0.6,
  halfLifeDays: 14,
  watchedFloor: 0.5,
  dateWindowDays: 14,
};

export interface Interest {
  /** The user messages that mention the subject, oldest first (at most 20). */
  questions: MessageRow[];
  watched: boolean;
  /** Other subjects of the same question ("Neon" was compared with Supabase and Railway). */
  comparedWith: string[];
  shortlisted: boolean;
  /** A date the user mentioned that is still ahead ("renew on 1 Dec"), epoch ms. */
  upcoming: number | null;
  lastAskedAt: number;
}

export interface Score {
  score: number;
  importance: number;
  magnitude: number;
  timeliness: number;
  /** Signed relative change (−0.21 = dropped 21%), null when not a comparable number. */
  relative: number | null;
  /** A date the user mentioned is coming up (it set timeliness to 1). */
  dateSoon: boolean;
  interest: Interest;
}

const WATCH = /\b(watch|keep an eye|keep track|track it|let me know|tell me (?:if|when)|notify|alert me|ping me)\b/i;
const SHORTLIST = /\bshort-?list/i;
const GONE = /\b(discontinued|unavailable|sold out|no longer|removed|retired|shut ?down|end of life|deprecated)\b/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** What the store says about the user's interest in a claim's subject, up to `nowMs`. */
export function interestIn(store: Store, root: ClaimRow, question: MessageRow | undefined, nowMs: number): Interest {
  const subject = root.subject.trim();
  const mentions = store
    .searchUserMessages([subject], { end: nowMs + 1, excludeId: -1, limit: 20 })
    .sort((a, b) => a.created_at - b.created_at);
  const questions = question && !mentions.some((m) => m.id === question.id) ? [question, ...mentions] : mentions;
  const siblings = root.message_id !== null ? store.claimsFor(root.message_id) : [];
  const comparedWith = [...new Set(siblings.map((c) => c.subject.trim()).filter((s) => s.toLowerCase() !== subject.toLowerCase()))];
  const lastAskedAt = Math.max(root.checked_at, ...questions.map((q) => q.created_at));
  let upcoming: number | null = null;
  for (const q of questions) {
    const d = mentionedDate(q.content, q.created_at);
    if (d !== null && d >= nowMs && (upcoming === null || d < upcoming)) upcoming = d;
  }
  return {
    questions,
    watched: questions.some((q) => WATCH.test(q.content)),
    comparedWith,
    shortlisted: questions.some((q) => SHORTLIST.test(q.content)),
    upcoming,
    lastAskedAt,
  };
}

/** A calendar date written in a message ("1 Dec", "Dec 1st"), as the first such day at or after it was written. */
export function mentionedDate(text: string, writtenAt: number): number | null {
  const m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i) ??
    text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (!m) return null;
  const [day, mon] = /\d/.test(m[1]!) ? [Number(m[1]), m[2]!] : [Number(m[2]), m[1]!];
  const month = MONTHS.indexOf(mon.slice(0, 3).toLowerCase());
  if (month < 0 || day < 1 || day > 31) return null;
  const from = new Date(writtenAt);
  let at = Date.UTC(from.getUTCFullYear(), month, day, 12); // midday UTC: the same calendar day in every zone from -11 to +11
  if (at < writtenAt - 86400000) at = Date.UTC(from.getUTCFullYear() + 1, month, day, 12);
  return at;
}

/** Signed relative change between two values, or null when they are not comparable amounts. */
export function relativeChange(oldValue: string, newValue: string): number | null {
  const a = parseValue(oldValue);
  const b = parseValue(newValue);
  if (a.amount === null || b.amount === null) return null;
  if (a.currency && b.currency && a.currency !== b.currency) return null;
  if (a.amount === 0) return b.amount === 0 ? 0 : 1;
  return (b.amount - a.amount) / Math.abs(a.amount);
}

export function scoreChange(
  change: { oldValue: string; newValue: string; oldUnit?: string | null; newUnit?: string | null },
  interest: Interest,
  nowMs: number,
  cfg: RightMomentConfig = RIGHT_MOMENT_DEFAULTS,
): Score {
  const repeated = interest.questions.length > 1;
  const compared = interest.shortlisted || interest.comparedWith.length > 0;
  const importance = Math.min(1, cfg.base + (compared ? cfg.compared : 0) + (repeated ? cfg.repeated : 0) + (interest.watched ? cfg.watched : 0));

  const unitChanged = !!(change.oldUnit && change.newUnit && !sameUnit(change.oldUnit, change.newUnit));
  const relative = unitChanged ? null : relativeChange(change.oldValue, change.newValue);
  const magnitude = GONE.test(change.newValue)
    ? 1
    : relative === null
      ? cfg.textChange
      : Math.min(1, Math.abs(relative) / cfg.fullChange);

  const days = Math.max(0, (nowMs - interest.lastAskedAt) / 86400000);
  let timeliness = Math.pow(0.5, days / cfg.halfLifeDays);
  if (interest.watched) timeliness = Math.max(timeliness, cfg.watchedFloor);
  const dateSoon = interest.upcoming !== null && interest.upcoming - nowMs <= cfg.dateWindowDays * 86400000;
  if (dateSoon) timeliness = 1;

  return { score: importance * magnitude * timeliness, importance, magnitude, timeliness, relative, dateSoon, interest };
}

/** "dropped 21%", "rose 5%", or "changed" when it is not a comparable number. */
export function changeWords(relative: number | null): string {
  if (relative === null || relative === 0) return "changed";
  const pct = Math.round(Math.abs(relative) * 100);
  return `${relative < 0 ? "dropped" : "rose"} ${pct < 1 ? "<1" : pct}%`;
}

/** Why the user should hear about it now, from the strongest interest signal. */
export function whyNow(subject: string, s: Score, day: (ms: number) => string): string {
  const i = s.interest;
  const first = i.questions[0];
  const on = day(first ? first.created_at : i.lastAskedAt);
  const last = day(i.lastAskedAt);
  const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  let why: string;
  if (i.watched) why = `You asked me to watch ${subject} on ${on}`;
  else if (i.shortlisted) why = `You shortlisted ${subject} on ${on}`;
  else if (i.comparedWith.length) why = `You compared ${subject} with ${list(i.comparedWith.slice(0, 3))} on ${on}`;
  else if (i.questions.length > 1) why = `You asked about ${subject} ${i.questions.length} times, last on ${last}`;
  else why = `You asked about ${subject} on ${on}`;
  if (s.dateSoon && i.upcoming !== null) why += `, and ${day(i.upcoming)} (the date you mentioned) is close`;
  return why;
}
