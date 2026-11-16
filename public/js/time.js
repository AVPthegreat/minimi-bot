// Dates as the user sees them, in the agent's timezone and relative to the agent's "now" (which the demo
// clock can move), not the browser's. Pure functions, tested in node.

/** "2026-11-18" for a timestamp in a timezone. */
export function dayKey(ms, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

const dayNumber = (key) => Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) / 86400000;

/** Whole calendar days between two timestamps in a timezone (0 = same day). */
export function daysAgo(ms, nowMs, timeZone) {
  return dayNumber(dayKey(nowMs, timeZone)) - dayNumber(dayKey(ms, timeZone));
}

/** Groups sessions (newest first) under Today / Yesterday / This week / Earlier. */
export function groupSessions(sessions, nowMs, timeZone) {
  const order = ["Today", "Yesterday", "This week", "Earlier"];
  const groups = new Map(order.map((g) => [g, []]));
  for (const s of sessions) {
    const d = daysAgo(s.updatedAt, nowMs, timeZone);
    groups.get(d <= 0 ? "Today" : d === 1 ? "Yesterday" : d < 7 ? "This week" : "Earlier").push(s);
  }
  return order.filter((g) => groups.get(g).length).map((label) => ({ label, sessions: groups.get(label) }));
}

/** Short time for a sidebar row: "14:05" today, "Mon" this week, "3 Nov" before. */
export function shortWhen(ms, nowMs, timeZone) {
  const d = daysAgo(ms, nowMs, timeZone);
  const opts = d <= 0 ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : d < 7 ? { weekday: "short" } : { day: "numeric", month: "short" };
  return new Intl.DateTimeFormat("en-GB", { timeZone, ...opts }).format(ms);
}

/** "Good morning" etc. at the agent's local hour. */
export function greeting(nowMs, timeZone) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(nowMs));
  return hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

/** "Wed 18 Nov, 09:00" in the agent's timezone. */
export function nowChip(nowMs, timeZone) {
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(nowMs)
    .replace(/^(\w+),? /, "$1 ")
    .replace(/ at |, (?=\d\d:)/, ", ");
}

/** The value a datetime-local input wants for "now" in the agent's timezone ("2026-11-18T09:00"). */
export function localInputValue(nowMs, timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(nowMs)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** The reverse: a datetime-local value read as wall-clock time in `timeZone` -> UTC milliseconds. */
export function zonedToUtc(value, timeZone) {
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return NaN;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const shown = localInputValue(guess, timeZone);
  const [d, t] = shown.split("T");
  const asUtc = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), +t.slice(0, 2), +t.slice(3, 5));
  return guess - (asUtc - guess);
}
