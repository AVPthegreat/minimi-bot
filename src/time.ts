// Clock and calendar helpers. Everything that needs "now" takes a Clock, so tests and demos
// can set the date. Days are calendar days in the user's timezone, not UTC days.

export interface Clock {
  now(): number; // epoch ms
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** A clock you can set and move. Used by tests, the eval, MINIMI_NOW and the demo clock. */
export class FakeClock implements Clock {
  private fixed: number | null;
  constructor(at?: string | number) {
    this.fixed = at === undefined ? null : typeof at === "number" ? at : parseInstant(at);
  }
  now(): number {
    return this.fixed !== null ? this.fixed : Date.now();
  }
  set(at: string | number): void {
    this.fixed = typeof at === "number" ? at : parseInstant(at);
  }
  /** Back to the real time. */
  reset(): void {
    this.fixed = null;
  }
}

export function parseInstant(s: string): number {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`Not a valid date/time: "${s}" (use ISO 8601, e.g. 2026-11-18T10:00:00+05:30)`);
  return t;
}

/** A calendar date with no time and no zone. Month is 1-12. */
export interface CivilDate {
  y: number;
  m: number;
  d: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    partsCache.set(tz, f);
  }
  return f;
}

function zonedParts(ms: number, tz: string) {
  const p: Record<string, number> = {};
  for (const part of fmt(tz).formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Minutes the zone is ahead of UTC at that instant. */
function offsetMinutes(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

export function civilDateOf(ms: number, tz: string): CivilDate {
  const p = zonedParts(ms, tz);
  return { y: p.year, m: p.month, d: p.day };
}

/** The instant a local calendar day starts in the zone (DST-safe: offset re-checked once). */
export function startOfDay(c: CivilDate, tz: string): number {
  const guess = Date.UTC(c.y, c.m - 1, c.d);
  let t = guess - offsetMinutes(guess, tz) * 60000;
  t = guess - offsetMinutes(t, tz) * 60000;
  return t;
}

export function addDays(c: CivilDate, n: number): CivilDate {
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** 0 = Monday ... 6 = Sunday (weeks start on Monday). */
export function weekdayIndex(c: CivilDate): number {
  return (new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay() + 6) % 7;
}

export function compareCivil(a: CivilDate, b: CivilDate): number {
  return Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d);
}

export function daysBetween(a: CivilDate, b: CivilDate): number {
  return Math.round(compareCivil(b, a) / 86400000);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Tue 10 Nov" (adds the year when it differs from `ref`). */
export function formatCivil(c: CivilDate, ref?: CivilDate): string {
  const year = ref && ref.y === c.y ? "" : ` ${c.y}`;
  return `${DAYS[weekdayIndex(c)]} ${c.d} ${MONTHS[c.m - 1]}${year}`;
}

/** "Tue 10 Nov, 14:05" in the user's zone. */
export function formatLocal(ms: number, tz: string, ref?: number): string {
  const p = zonedParts(ms, tz);
  const c = { y: p.year, m: p.month, d: p.day };
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return `${formatCivil(c, ref === undefined ? undefined : civilDateOf(ref, tz))}, ${hh}:${mm}`;
}

/** ISO date "2026-11-10" in the user's zone. */
export function isoDate(ms: number, tz: string): string {
  const c = civilDateOf(ms, tz);
  return `${c.y}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;
}
