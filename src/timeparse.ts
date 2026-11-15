// Deterministic resolver for the time phrases people use when they talk about the past:
// "on Monday", "last Tuesday", "on 3 November", "yesterday", "two weeks ago", "last week".
// No model call: it is instant, testable, and never hallucinates a date.
//
// Each phrase resolves to one or more candidate ranges (local calendar days in the user's zone),
// most likely first. Where people disagree on the meaning ("last Tuesday" said on a Wednesday:
// yesterday's Tuesday, or the one the week before?) we return both candidates and an assumption
// line; the memory lookup then picks the candidate that actually has a matching conversation.

import {
  type CivilDate,
  addDays,
  civilDateOf,
  compareCivil,
  formatCivil,
  startOfDay,
  weekdayIndex,
} from "./time.ts";

export interface TimeRange {
  start: number; // epoch ms, inclusive
  end: number; // epoch ms, exclusive
  label: string; // "Tue 10 Nov" or "3 Nov - 9 Nov"
}

export interface TimeRef {
  phrase: string;
  candidates: TimeRange[];
  /** Set when the phrase is ambiguous; says which reading we chose first. */
  assumption?: string;
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
// Full names only: "sat", "wed" and "sun" are ordinary words too often.
const WEEKDAY_RE = "(monday|tuesday|wednesday|thursday|friday|saturday|sunday)";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, couple: 2, few: 3,
};

function dayRange(c: CivilDate, tz: string, today: CivilDate): TimeRange {
  return { start: startOfDay(c, tz), end: startOfDay(addDays(c, 1), tz), label: formatCivil(c, today) };
}

function spanRange(from: CivilDate, toInclusive: CivilDate, tz: string, today: CivilDate): TimeRange {
  return {
    start: startOfDay(from, tz),
    end: startOfDay(addDays(toInclusive, 1), tz),
    label: `${formatCivil(from, today)} - ${formatCivil(toInclusive, today)}`,
  };
}

function weekdayFromToken(tok: string): number {
  const t = tok.toLowerCase().slice(0, 3);
  return WEEKDAYS.findIndex((w) => w.startsWith(t));
}

function monthFromToken(tok: string): number {
  return MONTHS.indexOf(tok.toLowerCase().slice(0, 3)) + 1;
}

function parseCount(tok: string): number {
  const n = Number(tok);
  return Number.isFinite(n) ? n : (NUMBER_WORDS[tok.toLowerCase()] ?? 1);
}

/** Most recent date with that day and month on or before today (so "3 November" said in January means last year). */
function pastDate(day: number, month: number, year: number | null, today: CivilDate): CivilDate | null {
  const y = year ?? today.y;
  const c = { y, m: month, d: day };
  const check = new Date(Date.UTC(c.y, c.m - 1, c.d));
  if (check.getUTCMonth() !== month - 1) return null; // 31 Feb etc.
  if (year === null && compareCivil(c, today) > 0) return { ...c, y: y - 1 };
  return c;
}

interface Rule {
  re: RegExp;
  resolve: (m: RegExpExecArray, today: CivilDate, tz: string) => Omit<TimeRef, "phrase"> | null;
}

const RULES: Rule[] = [
  {
    // ISO date: 2026-11-03
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/gi,
    resolve: (m, today, tz) => {
      const c = pastDate(Number(m[3]), Number(m[2]), Number(m[1]), today);
      return c ? { candidates: [dayRange(c, tz, today)] } : null;
    },
  },
  {
    // "3 November", "3rd Nov 2026", "on the 3rd of November"
    re: new RegExp(`\\b(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH_RE}\\b(?:,?\\s+(\\d{4}))?`, "gi"),
    resolve: (m, today, tz) => {
      if (m[2] === "may") return null; // lowercase "may" is the verb ("I may 2 more")
      const c = pastDate(Number(m[1]), monthFromToken(m[2]!), m[3] ? Number(m[3]) : null, today);
      return c ? { candidates: [dayRange(c, tz, today)] } : null;
    },
  },
  {
    // "November 3", "Nov 3rd, 2026"
    re: new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "gi"),
    resolve: (m, today, tz) => {
      if (m[1] === "may") return null;
      const c = pastDate(Number(m[2]), monthFromToken(m[1]!), m[3] ? Number(m[3]) : null, today);
      return c ? { candidates: [dayRange(c, tz, today)] } : null;
    },
  },
  {
    re: /\b(?:the\s+)?day\s+before\s+yesterday\b/gi,
    resolve: (_m, today, tz) => ({ candidates: [dayRange(addDays(today, -2), tz, today)] }),
  },
  {
    re: /\byesterday\b/gi,
    resolve: (_m, today, tz) => ({ candidates: [dayRange(addDays(today, -1), tz, today)] }),
  },
  {
    re: /\b(?:today|earlier today|this morning|this afternoon|this evening|tonight)\b/gi,
    resolve: (_m, today, tz) => ({ candidates: [dayRange(today, tz, today)] }),
  },
  {
    // "two weeks ago", "3 days ago", "a month ago", "a couple of days ago"
    re: /\b(\d{1,2}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|few)\s+(?:of\s+)?(day|week|month)s?\s+ago\b/gi,
    resolve: (m, today, tz) => {
      const n = parseCount(m[1]!);
      const unit = m[2]!.toLowerCase();
      if (unit === "day") return { candidates: [dayRange(addDays(today, -n), tz, today)] };
      // Weeks and months are fuzzy in speech: search a window around the point, not a single day.
      const days = unit === "week" ? 7 * n : 30 * n;
      const slack = unit === "week" ? 3 : 7;
      const center = addDays(today, -days);
      return { candidates: [spanRange(addDays(center, -slack), addDays(center, slack), tz, today)] };
    },
  },
  {
    re: /\blast\s+week(?:end)?\b/gi,
    resolve: (m, today, tz) => {
      const monday = addDays(today, -weekdayIndex(today) - 7);
      if (/weekend/i.test(m[0])) return { candidates: [spanRange(addDays(monday, 5), addDays(monday, 6), tz, today)] };
      return { candidates: [spanRange(monday, addDays(monday, 6), tz, today)] };
    },
  },
  {
    re: /\b(?:this|earlier this)\s+week\b/gi,
    resolve: (_m, today, tz) => ({
      candidates: [spanRange(addDays(today, -weekdayIndex(today)), today, tz, today)],
    }),
  },
  {
    re: /\blast\s+month\b/gi,
    resolve: (_m, today, tz) => {
      const first = { y: today.m === 1 ? today.y - 1 : today.y, m: today.m === 1 ? 12 : today.m - 1, d: 1 };
      const last = addDays({ y: today.y, m: today.m, d: 1 }, -1);
      return { candidates: [spanRange(first, last, tz, today)] };
    },
  },
  {
    re: /\b(?:this|earlier this)\s+month\b/gi,
    resolve: (_m, today, tz) => ({ candidates: [spanRange({ ...today, d: 1 }, today, tz, today)] }),
  },
  {
    // "last Tuesday", "on Monday", "this Monday", "Monday", "past Friday"
    // `(?!\\.\\w)`: "Monday.com" is a product, not a day.
    re: new RegExp(`\\b(?:(last|past|this|on|previous)\\s+)?${WEEKDAY_RE}\\b(?!\\.\\w)`, "gi"),
    resolve: (m, today, tz) => {
      const qualifier = (m[1] ?? "").toLowerCase();
      const target = weekdayFromToken(m[2]!);
      if (target < 0) return null;
      const todayIdx = weekdayIndex(today);
      let back = (todayIdx - target + 7) % 7;
      if (qualifier === "this") {
        // "this Monday" when talking about the past = the Monday of the current week.
        back = todayIdx - target;
        if (back < 0) back += 7;
        return { candidates: [dayRange(addDays(today, -back), tz, today)] };
      }
      if (back === 0) {
        // Said on that same weekday: almost always means a week ago, but could mean today.
        const prev = addDays(today, -7);
        return {
          candidates: [dayRange(prev, tz, today), dayRange(today, tz, today)],
          assumption: `"${m[0].trim()}" is today's weekday; I read it as ${formatCivil(prev, today)}, a week ago.`,
        };
      }
      const recent = addDays(today, -back);
      const inThisWeek = back <= todayIdx; // recent is on or after this week's Monday
      if (qualifier === "last" || qualifier === "past" || qualifier === "previous") {
        if (inThisWeek) {
          // "last Tuesday" on a Wednesday: yesterday, or Tuesday of last week? Keep both.
          const older = addDays(recent, -7);
          return {
            candidates: [dayRange(recent, tz, today), dayRange(older, tz, today)],
            assumption: `"${m[0].trim()}" could mean ${formatCivil(recent, today)} or ${formatCivil(older, today)}.`,
          };
        }
      }
      return { candidates: [dayRange(recent, tz, today)] };
    },
  },
];

export interface ParsedTime {
  refs: TimeRef[];
  /** The text with the time phrases removed (useful as a topic query). */
  rest: string;
}

export function parseTimeRefs(text: string, nowMs: number, tz: string): ParsedTime {
  const today = civilDateOf(nowMs, tz);
  const taken: Array<[number, number]> = [];
  const found: Array<{ index: number; ref: TimeRef }> = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      const s = m.index;
      const e = s + m[0].length;
      if (taken.some(([a, b]) => s < b && e > a)) continue; // a more specific rule already matched here
      const r = rule.resolve(m, today, tz);
      if (!r) continue;
      taken.push([s, e]);
      found.push({ index: s, ref: { phrase: m[0].trim(), ...r } });
    }
  }
  found.sort((a, b) => a.index - b.index);
  let rest = text;
  for (const [s, e] of [...taken].sort((a, b) => b[0] - a[0])) rest = rest.slice(0, s) + " " + rest.slice(e);
  return { refs: found.map((f) => f.ref), rest: rest.replace(/\s+/g, " ").trim() };
}
