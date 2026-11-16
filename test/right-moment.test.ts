// The right-moment score: a change becomes a nudge only when importance × magnitude × timeliness passes
// the threshold, the highest score goes first, interest decays with time, and the line says why now.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Store } from "../src/db.ts";
import { FakeLLM } from "../src/llm/fake.ts";
import { type Interest, RIGHT_MOMENT_DEFAULTS as D, changeWords, mentionedDate, scoreChange } from "../src/rightmoment.ts";
import { FakeSearch } from "../src/search/fake.ts";
import { FakeClock, parseInstant } from "../src/time.ts";
import { checkWatchlist } from "../src/watch.ts";

const DAY = 86400000;
const NOW = parseInstant("2026-11-16T09:00:00+05:30");
const interest = (over: Partial<Interest> = {}): Interest => ({
  questions: [{ id: 1, session_id: "s", role: "user", content: "q", created_at: NOW - 6 * DAY, meta: "{}" }],
  watched: false, comparedWith: [], shortlisted: false, upcoming: null, lastAskedAt: NOW - 6 * DAY, ...over,
});

test("a big change on a watched fact passes the threshold", () => {
  const s = scoreChange({ oldValue: "$19", newValue: "$15" }, interest({ watched: true }), NOW);
  assert.equal(s.magnitude, 1, "a 21% move is a full-size change");
  assert.equal(s.importance, D.base + D.watched);
  assert.ok(s.score >= D.threshold, `score ${s.score}`);
  assert.equal(changeWords(s.relative), "dropped 21%");
});

test("a tiny change on a one-off question stays quiet", () => {
  const s = scoreChange({ oldValue: "$100", newValue: "$99" }, interest(), NOW);
  assert.equal(s.importance, D.base);
  assert.ok(s.score < D.threshold, `score ${s.score}`);
});

test("interest decays with time; a watched fact keeps a floor; a date the user mentioned makes it urgent", () => {
  const change = { oldValue: "$19", newValue: "$15" };
  const recent = scoreChange(change, interest(), NOW);
  const old = scoreChange(change, interest({ lastAskedAt: NOW - 60 * DAY }), NOW);
  assert.ok(recent.timeliness > old.timeliness && old.timeliness < 0.06, "60 days is about four half-lives");
  assert.ok(recent.score >= D.threshold && old.score < D.threshold, "the same change is worth a nudge at 6 days, not at 60");
  const watched = scoreChange(change, interest({ watched: true, lastAskedAt: NOW - 60 * DAY }), NOW);
  assert.equal(watched.timeliness, D.watchedFloor);
  const renewal = scoreChange(change, interest({ lastAskedAt: NOW - 60 * DAY, upcoming: NOW + 5 * DAY }), NOW);
  assert.ok(renewal.dateSoon && renewal.timeliness === 1);
});

test("non-numeric and unit changes count as a plan change; gone counts as full size", () => {
  assert.equal(scoreChange({ oldValue: "Branching included", newValue: "Branching on Scale only" }, interest(), NOW).magnitude, D.textChange);
  assert.equal(scoreChange({ oldValue: "$20", newValue: "$20", oldUnit: "per month", newUnit: "per year" }, interest(), NOW).magnitude, D.textChange);
  assert.equal(scoreChange({ oldValue: "$20", newValue: "discontinued" }, interest(), NOW).magnitude, 1);
});

test("a date in a message resolves to the next such day", () => {
  const written = parseInstant("2026-11-10T10:00:00+05:30");
  assert.equal(new Date(mentionedDate("we renew on 1 Dec", written)!).toISOString().slice(0, 10), "2026-12-01");
  assert.equal(new Date(mentionedDate("renewal is Jan 3rd", written)!).toISOString().slice(0, 10), "2027-01-03");
  assert.equal(mentionedDate("how much is it?", written), null);
});

// ---- end to end over the store and a small fake web
function world(pages: Array<{ subject: string; plan: string; then: string; now: string }>) {
  const dir = mkdtempSync(join(tmpdir(), "rm-world-"));
  const file = join(dir, "world.json");
  writeFileSync(file, JSON.stringify({
    pages: pages.flatMap((p) => [
      { url: `https://${p.subject.toLowerCase()}.example/pricing`, title: `${p.subject} pricing`, published: "2026-10-01", from: "2026-01-01", to: "2026-11-13", text: `${p.subject}: the ${p.plan} plan costs ${p.then} per month.` },
      { url: `https://${p.subject.toLowerCase()}.example/pricing`, title: `${p.subject} pricing`, published: "2026-11-13", from: "2026-11-13", text: `${p.subject}: the ${p.plan} plan costs ${p.now} per month.` },
    ]),
  }));
  return pathToFileURL(file);
}

function setup(pages: Parameters<typeof world>[0]) {
  const clock = new FakeClock("2026-11-10T10:00:00+05:30");
  const search = new FakeSearch(clock, world(pages));
  const store = new Store(":memory:");
  const deps = { store, search, llm: new FakeLLM(new FakeSearch(clock, world(pages))), tz: "Asia/Kolkata" };
  const ask = (question: string, facts: Array<{ subject: string; plan: string; value: string }>) => {
    const sid = `s${Math.random()}`;
    store.createSession(sid, clock.now());
    store.addMessage(sid, "user", question, clock.now());
    const a = store.addMessage(sid, "assistant", "(answer)", clock.now());
    store.addClaims(a, sid, facts.map((f) => ({ subject: f.subject, attribute: `${f.plan} plan price`, value: f.value, unit: "per month" })), clock.now());
  };
  return { clock, store, deps, ask };
}

const cfg = { enabled: true, afterDays: 3, maxSearches: 3 };
const latest = (store: Store, subject: string) =>
  (store.db.prepare("SELECT value FROM claims WHERE subject = ? ORDER BY id DESC LIMIT 1").get(subject) as { value: string }).value;

test("end to end: highest score first, the reason is named, a tiny change is not announced and not re-searched", async () => {
  const { clock, store, deps, ask } = setup([
    { subject: "Acme", plan: "Pro", then: "$100", now: "$70" },
    { subject: "Beta", plan: "Team", then: "$40", now: "$30" },
    { subject: "Gamma", plan: "Basic", then: "$10", now: "$9.90" },
  ]);
  ask("How much is the Acme Pro plan?", [{ subject: "Acme", plan: "Pro", value: "$100" }]);
  ask("How much is the Gamma Basic plan?", [{ subject: "Gamma", plan: "Basic", value: "$10" }]);
  ask("What does the Beta Team plan cost? Please watch it for me.", [{ subject: "Beta", plan: "Team", value: "$40" }]);
  clock.set("2026-11-16T09:00:00+05:30");

  const check = await checkWatchlist(deps, "n1", clock.now(), cfg);
  assert.ok(check?.nudge, "a nudge");
  // Beta: watched (0.8) × 25% (1) × 6 days (0.74) beats Acme: one-off (0.3) × 30% (1) × 0.74. Gamma (1%) is below.
  assert.match(check.nudge.text, /You asked me to watch Beta on Tue 10 Nov; its Team plan price dropped 25%: \$40 per month then, \*\*\$30 per month\*\* now/);
  assert.match(check.nudge.text, /beta\.example, dated 2026-11-13/, "the source is named, so the change is not ours");
  assert.match(check.nudge.text, /2 more changes/);
  assert.ok(check.nudge.score!.score >= D.threshold);
  check.commit(true);
  assert.equal(latest(store, "Beta"), "$30", "the shown change is committed");
  assert.equal(latest(store, "Acme"), "$100", "the other changes stay pending for 'anything new?'");
  assert.equal(latest(store, "Gamma"), "$10");

  clock.set("2026-11-16T10:00:00+05:30");
  assert.equal(await checkWatchlist(deps, "n2", clock.now(), cfg), null, "nothing is due: no searches, never announced twice");
});

test("end to end: only a tiny change on a one-off question means no nudge, and the next chat does not search again", async () => {
  const { clock, deps, ask } = setup([{ subject: "Gamma", plan: "Basic", then: "$10", now: "$9.90" }]);
  ask("How much is the Gamma Basic plan?", [{ subject: "Gamma", plan: "Basic", value: "$10" }]);
  clock.set("2026-11-16T09:00:00+05:30");
  const check = await checkWatchlist(deps, "n1", clock.now(), cfg);
  assert.ok(check);
  assert.equal(check.nudge, null);
  check.commit(false);
  clock.set("2026-11-16T09:30:00+05:30");
  assert.equal(await checkWatchlist(deps, "n2", clock.now(), cfg), null);
});
