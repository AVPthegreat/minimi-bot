// The nudge's lifecycle: a change found by the watchlist is never lost. It is committed (saved as the
// fact's new value) only when the nudge is actually shown; a nudge dropped because the user typed first,
// or cancelled by the server's time limit, leaves the change pending for the next nudge and for
// "anything new?". A cancelled nudge stops its searches and model calls and writes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { Store } from "../src/db.ts";
import { FakeLLM } from "../src/llm/fake.ts";
import { FakeSearch } from "../src/search/fake.ts";
import type { SearchOptions, SearchProvider } from "../src/search/types.ts";
import { FakeClock } from "../src/time.ts";

function setup(wrap?: (s: SearchProvider) => SearchProvider) {
  const clock = new FakeClock("2026-11-10T10:00:00+05:30");
  const world = new FakeSearch(clock);
  const store = new Store(":memory:");
  const llm = new FakeLLM(new FakeSearch(clock));
  const agent = new Agent({ store, llm, search: wrap ? wrap(world) : world, clock, timezone: "Asia/Kolkata", watch: { enabled: true, afterDays: 3, maxSearches: 3 } });
  return { clock, store, agent, llm };
}

async function say(agent: Agent, sid: string, text: string) {
  const events: AgentEvent[] = [];
  for await (const e of agent.chat(sid, text)) events.push(e);
  await agent.idle();
  return events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("");
}

const neonLatest = (store: Store) =>
  (store.db.prepare("SELECT value FROM claims WHERE subject = 'Neon' AND attribute LIKE 'Launch%' ORDER BY id DESC LIMIT 1").get() as { value: string }).value;
const claimCount = (store: Store) => (store.db.prepare("SELECT COUNT(*) AS n FROM claims").get() as { n: number }).n;

/** Asked on 10 Nov; Neon's Launch plan changes in the fixture world before 16 Nov. */
async function askedAndWaited() {
  const s = setup();
  await say(s.agent, s.agent.newSession().id, "What does Postgres hosting cost on Supabase, Neon and Railway?");
  const before = neonLatest(s.store);
  s.clock.set("2026-11-16T09:00:00+05:30");
  return { ...s, before };
}

test("a nudge dropped because the user typed first does not lose the change: the next new chat announces it", async () => {
  const { store, agent, clock, before } = await askedAndWaited();
  const sid = agent.newSession().id;
  const pending = agent.nudge(sid);
  await say(agent, sid, "hi"); // the user talks before the nudge returns
  assert.equal(await pending, null, "not wedged between a question and its answer");
  assert.equal(neonLatest(store), before, "the new value is not committed while unseen");
  clock.set("2026-11-16T09:30:00+05:30");
  const next = await agent.nudge(agent.newSession().id);
  assert.ok(next && /Neon/.test(next.nudge.text) && /\$15/.test(next.nudge.text), "the change is announced in the next new chat");
  assert.notEqual(neonLatest(store), before, "committed once shown");
  clock.set("2026-11-16T10:00:00+05:30");
  assert.equal(await agent.nudge(agent.newSession().id), null, "and never announced twice");
});

test("a dropped nudge's change is still reported by 'anything new?'", async () => {
  const { agent } = await askedAndWaited();
  const sid = agent.newSession().id;
  const pending = agent.nudge(sid);
  await say(agent, sid, "hi");
  await pending;
  const text = await say(agent, agent.newSession().id, "Anything new?");
  assert.match(text, /\| Neon: Launch plan[^|]*\|[^\n]*Changed/);
});

test("a cancelled nudge passes the signal to its searches and model call and writes nothing", async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const ac = new AbortController();
  let armed = false;
  const s = setup((inner) => ({
    name: inner.name,
    search: (q: string, o?: SearchOptions) => {
      if (armed) {
        signals.push(o?.signal);
        ac.abort(); // the server's time limit fires while the search runs
      }
      return inner.search(q, o);
    },
  }));
  await say(s.agent, s.agent.newSession().id, "What does Postgres hosting cost on Supabase, Neon and Railway?");
  const before = neonLatest(s.store);
  const claimsBefore = claimCount(s.store);
  const checkedBefore = s.store.db.prepare("SELECT MAX(rechecked_at) AS t FROM claims").get();
  s.clock.set("2026-11-16T09:00:00+05:30");
  const recheckSignals: Array<AbortSignal | undefined> = [];
  const recheck = s.llm.recheck.bind(s.llm);
  s.llm.recheck = (input) => (recheckSignals.push(input.signal), recheck(input));
  armed = true;
  const sid = s.agent.newSession().id;
  assert.equal(await s.agent.nudge(sid, ac.signal), null);
  assert.ok(signals.length > 0 && signals.every((x) => x === ac.signal), "every search got the nudge's signal");
  assert.equal(recheckSignals.length, 0, "no paid model call once cancelled");
  assert.equal(s.store.sessionMessages(sid).length, 0, "no message the user never saw");
  assert.equal(claimCount(s.store), claimsBefore, "no claim versions written");
  assert.deepEqual(s.store.db.prepare("SELECT MAX(rechecked_at) AS t FROM claims").get(), checkedBefore, "nothing marked checked");
  assert.equal(neonLatest(s.store), before);
  // Nothing was lost: the next nudge still announces the change.
  armed = false;
  const live = new AbortController();
  const next = await s.agent.nudge(s.agent.newSession().id, live.signal);
  assert.ok(next && /Neon/.test(next.nudge.text));
  assert.deepEqual(recheckSignals, [live.signal], "the model call gets the nudge's signal");
});

test("a nudge already aborted before it starts does no work", async () => {
  const { agent, store } = await askedAndWaited();
  const n = claimCount(store);
  assert.equal(await agent.nudge(agent.newSession().id, AbortSignal.abort()), null);
  assert.equal(claimCount(store), n);
});
