import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTimeRefs } from "../src/timeparse.ts";
import { isoDate } from "../src/time.ts";

const TZ = "Asia/Kolkata";
// Wednesday 18 Nov 2026, 09:00 in Kolkata.
const WED = Date.parse("2026-11-18T09:00:00+05:30");

function days(text: string, now = WED, tz = TZ): string[][] {
  return parseTimeRefs(text, now, tz).refs.map((r) => r.candidates.map((c) => `${isoDate(c.start, tz)}..${isoDate(c.end - 1, tz)}`));
}

test("yesterday, today, day before yesterday", () => {
  assert.deepEqual(days("what did I ask yesterday"), [["2026-11-17..2026-11-17"]]);
  assert.deepEqual(days("earlier today"), [["2026-11-18..2026-11-18"]]);
  assert.deepEqual(days("the day before yesterday"), [["2026-11-16..2026-11-16"]]);
});

test("'on Monday' is the most recent Monday", () => {
  assert.deepEqual(days("On Monday we shortlisted 5 CRM tools"), [["2026-11-16..2026-11-16"]]);
});

test("'last Tuesday' said on Wednesday is ambiguous: yesterday first, then a week earlier", () => {
  const r = parseTimeRefs("Last Tuesday I asked you about Postgres hosting", WED, TZ).refs[0]!;
  assert.deepEqual(r.candidates.map((c) => isoDate(c.start, TZ)), ["2026-11-17", "2026-11-10"]);
  assert.match(r.assumption!, /could mean Tue 17 Nov or Tue 10 Nov/);
});

test("'last Friday' said on Wednesday is the previous week's Friday, unambiguous", () => {
  const r = parseTimeRefs("last Friday", WED, TZ).refs[0]!;
  assert.deepEqual(r.candidates.map((c) => isoDate(c.start, TZ)), ["2026-11-13"]);
  assert.equal(r.assumption, undefined);
});

test("a weekday said on that same weekday means a week ago (with a note)", () => {
  const r = parseTimeRefs("on Wednesday", WED, TZ).refs[0]!;
  assert.equal(isoDate(r.candidates[0]!.start, TZ), "2026-11-11");
  assert.ok(r.assumption);
});

test("explicit dates, both orders, with and without year", () => {
  assert.deepEqual(days("What did I ask you on 3 November?"), [["2026-11-03..2026-11-03"]]);
  assert.deepEqual(days("on the 3rd of Nov"), [["2026-11-03..2026-11-03"]]);
  assert.deepEqual(days("November 3rd, 2025"), [["2025-11-03..2025-11-03"]]);
  assert.deepEqual(days("2026-11-03"), [["2026-11-03..2026-11-03"]]);
});

test("a date later this year means last year", () => {
  assert.deepEqual(days("on 20 December"), [["2025-12-20..2025-12-20"]]);
});

test("invalid dates are ignored", () => {
  assert.deepEqual(days("on 31 February"), []);
});

test("relative spans: N days/weeks ago, last week, this week, last month", () => {
  assert.deepEqual(days("3 days ago"), [["2026-11-15..2026-11-15"]]);
  assert.deepEqual(days("two weeks ago"), [["2026-11-01..2026-11-07"]]);
  assert.deepEqual(days("last week"), [["2026-11-09..2026-11-15"]]);
  assert.deepEqual(days("this week"), [["2026-11-16..2026-11-18"]]);
  assert.deepEqual(days("last month"), [["2026-10-01..2026-10-31"]]);
});

test("ranges follow the user's timezone, not UTC", () => {
  // 18 Nov 02:00 in Kolkata is still 17 Nov in UTC; "today" must be 18 Nov local.
  const early = Date.parse("2026-11-18T02:00:00+05:30");
  const [r] = parseTimeRefs("today", early, TZ).refs;
  assert.equal(r!.candidates[0]!.start, Date.parse("2026-11-18T00:00:00+05:30"));
  const [ny] = parseTimeRefs("today", early, "America/New_York").refs;
  assert.equal(isoDate(ny!.candidates[0]!.start, "America/New_York"), "2026-11-17");
});

test("ordinary words are not dates ('sat', 'may', 'sun')", () => {
  assert.deepEqual(days("I sat in the sun and you may help"), []);
});

test("rest removes the time phrases", () => {
  assert.equal(parseTimeRefs("Last Tuesday I asked about Postgres hosting", WED, TZ).rest, "I asked about Postgres hosting");
});

test("product names and verbs are not dates: Monday.com, 'I may 2 more'", () => {
  assert.deepEqual(days("Compare HubSpot and Monday.com pricing"), []);
  assert.deepEqual(days("I may 2 more seats"), []);
  assert.deepEqual(days("on May 2"), [["2026-05-02..2026-05-02"]]);
});
