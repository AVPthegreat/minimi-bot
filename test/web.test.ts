// The web page's pure modules (no DOM): safe markdown, the agent's code-written blocks, stream
// parsing, and the dates used by the sidebar. The page itself is checked with a headless browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, createSSEParser } from "../public/js/api.js";
import { markdown } from "../public/js/markdown.js";
import { daysAgo, groupSessions, localInputValue, nowChip, shortWhen, zonedToUtc } from "../public/js/time.js";

const TZ = "Asia/Kolkata";
const at = (iso: string) => Date.parse(iso);

test("markdown: model text can never inject HTML or script URLs", () => {
  const html = markdown('<img src=x onerror=alert(1)> **hi** [x](javascript:alert(1)) <script>bad()</script> "q"', []);
  assert.doesNotMatch(html, /<img|<script|href="javascript/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<strong>hi<\/strong>/);
  const link = markdown("[docs](https://neon.com/docs?a=1&b=2)", []);
  assert.match(link, /<a href="https:\/\/neon.com\/docs\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">docs<\/a>/);
});

test("markdown: citations link only to the listed http(s) sources", () => {
  const sources = [{ n: 1, url: "https://supabase.com/pricing", title: 'Pricing "Supabase"', domain: "supabase.com" }, { n: 2, url: "javascript:alert(1)", title: "bad", domain: "x" }];
  const html = markdown("Pro is $25 [1], Team is [2], missing [3].", sources);
  assert.match(html, /<a class="cite" href="https:\/\/supabase.com\/pricing"[^>]*title="Pricing &quot;Supabase&quot;">1<\/a>/);
  assert.match(html, /Team is \[2\]/);
  assert.match(html, /missing \[3\]/);
});

test("markdown: the then/now table gets badges, a struck-out old value and row headers", () => {
  const text = [
    "Since Tue 10 Nov: **1 changed**, 1 unchanged.",
    "",
    "| What | Then (Tue 10 Nov) | Now (Wed 18 Nov) | Status |",
    "|---|---|---|---|",
    "| Neon: Launch plan price | $19 per month | $15 per month [1] | **Changed** |",
    "| Supabase: Pro plan price | $25 per month | $25 per month [2] | Unchanged |",
    "| Railway: Hobby plan price | $5 per month | not found | Couldn't verify |",
  ].join("\n");
  const html = markdown(text, [{ n: 1, url: "https://neon.com/pricing", title: "Neon", domain: "neon.com" }]);
  assert.match(html, /class="table-wrap compare"/);
  assert.match(html, /<th scope="col">Then<span class="th-date">Tue 10 Nov<\/span><\/th>/);
  assert.match(html, /<tr class="row-changed"><th scope="row"><span class="subject">Neon<\/span><span class="attr">Launch plan price<\/span><\/th>/);
  assert.match(html, /<span class="badge badge-changed">Changed<\/span>/);
  assert.match(html, /<span class="badge badge-unchanged">Unchanged<\/span>/);
  assert.match(html, /<span class="badge badge-unverified">Couldn't verify<\/span>/);
  assert.match(html, /<td class="muted-cell">not found<\/td>/);
});

test("markdown: date readings, quoted questions and unverified prices get their own blocks", () => {
  const html = markdown([
    '**Last Tuesday = Tue 10 Nov.** "Last Tuesday" could mean Tue 17 Nov or Tue 10 Nov.',
    'You asked on Tue 10 Nov, 10:00: "What does <b>Postgres</b> hosting cost?"',
    "Close is $49 (unverified) per seat.",
  ].join("\n\n"));
  assert.match(html, /class="note note-date"/);
  assert.match(html, /Last Tuesday .*<strong>Tue 10 Nov<\/strong>/);
  assert.match(html, /<figure class="recall"><figcaption>.*You asked on <time>Tue 10 Nov, 10:00<\/time><\/figcaption><blockquote>What does &lt;b&gt;Postgres&lt;\/b&gt; hosting cost\?<\/blockquote>/);
  assert.match(html, /\$49 <span class="chip chip-warn"[^>]*>.*unverified<\/span> per seat/);
});

test("stream parser: events across chunk boundaries, CRLF, and a broken frame skipped", () => {
  const parse = createSSEParser();
  assert.deepEqual(parse('data: {"type":"status","text":"Sea'), []);
  assert.deepEqual(parse('rching"}\n\ndata: {"type":"delta","text":"Hi"}\r\n\r\ndata: {broken\n\n'), [
    { type: "status", text: "Searching" },
    { type: "delta", text: "Hi" },
  ]);
  assert.deepEqual(parse('data: {"type":"search","query":"Neon pricing","state":"done","results":3,"domain":"neon.com"}\n\n'), [
    { type: "search", query: "Neon pricing", state: "done", results: 3, domain: "neon.com" },
  ]);
});

test("errors: retry is offered when it can help, not for a spend cap or a rejected message", () => {
  assert.equal(new ApiError("network", "down").retryable, true);
  assert.equal(new ApiError("cut", "dropped").retryable, true);
  assert.equal(new ApiError("http", "Message too large.", 413).retryable, false);
  assert.equal(new ApiError("http", "oops", 500).retryable, true);
  assert.equal(new ApiError("agent", "Spend cap reached ($5.00 of $5.00).").retryable, false);
  assert.equal(new ApiError("agent", "overloaded").retryable, true);
  assert.equal(new ApiError("http", "Too many messages.", 429, "rate_limited").retryable, true);
  assert.equal(new ApiError("http", "Today's messages are used.", 429, "daily_limit").retryable, false);
  assert.equal(new ApiError("agent", "The demo budget is used up.", 0, "demo_budget").retryable, false);
});

test("dates: sidebar groups and times follow the agent's timezone and clock", () => {
  const now = at("2026-11-18T00:30:00+05:30"); // just after midnight in India, still the 17th in UTC
  assert.equal(daysAgo(at("2026-11-17T23:50:00+05:30"), now, TZ), 1);
  const groups = groupSessions(
    [
      { id: "a", updatedAt: at("2026-11-18T00:10:00+05:30") },
      { id: "b", updatedAt: at("2026-11-17T09:00:00+05:30") },
      { id: "c", updatedAt: at("2026-11-13T09:00:00+05:30") },
      { id: "d", updatedAt: at("2026-11-03T09:00:00+05:30") },
    ],
    now,
    TZ,
  );
  assert.deepEqual(groups.map((g) => [g.label, (g.sessions ?? []).map((s: { id: string }) => s.id)]), [["Today", ["a"]], ["Yesterday", ["b"]], ["This week", ["c"]], ["Earlier", ["d"]]]);
  assert.equal(shortWhen(at("2026-11-18T00:10:00+05:30"), now, TZ), "00:10");
  assert.equal(shortWhen(at("2026-11-13T09:00:00+05:30"), now, TZ), "Fri");
  assert.equal(shortWhen(at("2026-11-03T09:00:00+05:30"), now, TZ), "3 Nov");
  assert.equal(nowChip(at("2026-11-18T09:05:00+05:30"), TZ), "Wed 18 Nov, 09:05");
});

test("dates: the demo clock input round-trips in the agent's timezone", () => {
  const ms = at("2026-11-18T09:00:00+05:30");
  assert.equal(localInputValue(ms, TZ), "2026-11-18T09:00");
  assert.equal(zonedToUtc("2026-11-18T09:00", TZ), ms);
  assert.equal(zonedToUtc("2026-07-01T12:00", "America/New_York"), at("2026-07-01T12:00:00-04:00"));
});
