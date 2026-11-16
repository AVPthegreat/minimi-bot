import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { Store } from "../src/db.ts";
import { FakeLLM } from "../src/llm/fake.ts";
import { FakeSearch } from "../src/search/fake.ts";
import type { SearchProvider } from "../src/search/types.ts";
import { FakeClock } from "../src/time.ts";
import { SCENARIOS, offlineModels, runScenario } from "../eval/scenarios.ts";

// The whole offline eval is part of `npm test`.
for (const sc of SCENARIOS) {
  test(`eval scenario: ${sc.name}`, async () => {
    const reports = await runScenario(sc, offlineModels);
    const failures = reports.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => `step ${r.step} ("${r.say}"): ${c.name}\n${r.result.text}`));
    assert.deepEqual(failures, []);
  });
}

async function run(agent: Agent, sid: string, text: string, signal?: AbortSignal) {
  const events: AgentEvent[] = [];
  for await (const e of agent.chat(sid, text, signal)) events.push(e);
  await agent.idle();
  return events;
}

function setup(search?: SearchProvider) {
  const clock = new FakeClock("2026-11-10T10:00:00+05:30");
  const store = new Store(":memory:");
  const agent = new Agent({ store, llm: new FakeLLM(), search: search ?? new FakeSearch(clock), clock, timezone: "Asia/Kolkata" });
  return { clock, store, agent };
}

test("messages are stored with the time they were sent, searches with what they returned", async () => {
  const { store, agent } = setup();
  const sid = agent.newSession().id;
  await run(agent, sid, "How much is the Cloudflare Workers paid plan?");
  const [user, bot] = store.sessionMessages(sid);
  assert.equal(user!.created_at, Date.parse("2026-11-10T10:00:00+05:30"));
  assert.equal(bot!.role, "assistant");
  const searches = store.searchesFor(user!.id);
  assert.deepEqual(searches.map((x) => x.purpose).sort(), ["answer", "speculative"]);
  assert.equal(searches[0]!.provider, "fake");
});

test("when every search fails, the user is told and no prices are invented", async () => {
  const broken: SearchProvider = { name: "broken", search: async () => { throw new Error("HTTP 503"); } };
  const { agent } = setup(broken);
  const events = await run(agent, agent.newSession().id, "How much is the Cloudflare Workers paid plan?");
  const warning = events.find((e) => e.type === "warning");
  assert.ok(warning && warning.type === "warning" && /Web search failed/.test(warning.text));
  const text = events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("");
  assert.doesNotMatch(text, /\$\d/);
});

test("a stopped answer is still saved (partial) and marked aborted", async () => {
  const { store, agent } = setup();
  const sid = agent.newSession().id;
  const ac = new AbortController();
  const events: AgentEvent[] = [];
  for await (const e of agent.chat(sid, "What does Postgres hosting cost on Supabase, Neon and Railway?", ac.signal)) {
    events.push(e);
    if (e.type === "delta") ac.abort();
  }
  const bot = store.sessionMessages(sid).find((m) => m.role === "assistant")!;
  assert.equal(JSON.parse(bot.meta).aborted, true);
  assert.ok(events.some((e) => e.type === "done"));
});

test("memory spans sessions; FTS input with quotes or operators is safe", async () => {
  const { clock, agent } = setup();
  await run(agent, agent.newSession().id, "How much is the Cloudflare Workers paid plan?");
  clock.set("2026-11-12T10:00:00+05:30");
  const events = await run(agent, agent.newSession().id, 'What did I ask about "Cloudflare" OR NEAR(x) * ?');
  const text = events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("");
  assert.match(text, /How much is the Cloudflare Workers paid plan\?/);
});

test("empty and oversized input", async () => {
  const { store, agent } = setup();
  const sid = agent.newSession().id;
  const [e] = await run(agent, sid, "   ");
  assert.equal(e!.type, "error");
  await run(agent, sid, "x".repeat(10000));
  assert.equal(store.sessionMessages(sid)[0]!.content.length, 4000);
});

test("recall uses the earlier time when the message also says 'today'", async () => {
  const { clock, agent } = setup();
  await run(agent, agent.newSession().id, "How much is the Cloudflare Workers paid plan?"); // Tue 10 Nov
  clock.set("2026-11-18T09:00:00+05:30");
  const events = await run(agent, agent.newSession().id, "Today, tell me what I asked last Tuesday");
  const text = events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("");
  assert.match(text, /Cloudflare Workers paid plan/);
});

test("a nudge never lands between a question and its answer", async () => {
  const { clock, store, agent } = setup();
  await run(agent, agent.newSession().id, "What does Postgres hosting cost on Supabase, Neon and Railway?");
  clock.set("2026-11-18T09:00:00+05:30");
  const sid = agent.newSession().id;
  const pending = agent.nudge(sid); // starts the background check...
  await run(agent, sid, "hi"); // ...while the user is already talking
  assert.equal(await pending, null);
  assert.deepEqual(store.sessionMessages(sid).map((m) => m.role), ["user", "assistant"]);
});

test("a stopped turn stores no claims", async () => {
  const { store, agent } = setup();
  const ac = new AbortController();
  for await (const e of agent.chat(agent.newSession().id, "What does Postgres hosting cost on Supabase, Neon and Railway?", ac.signal)) {
    if (e.type === "sources") ac.abort();
  }
  await agent.idle();
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM claims").get() as { n: number }).n, 0);
});

test("searches are looked up by message through an index, also in a database made before the index existed", () => {
  const dir = mkdtempSync(join(tmpdir(), "minimi-db-"));
  try {
    const path = join(dir, "old.db");
    const old = new Store(path);
    old.db.exec("DROP INDEX IF EXISTS searches_message"); // the schema as it was
    old.close();
    const store = new Store(path); // opening runs the (idempotent) schema again
    const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM searches WHERE message_id = ?").all(1) as Array<{ detail: string }>;
    assert.ok(plan.some((p) => /USING INDEX searches_message/.test(p.detail)), JSON.stringify(plan));
    store.close();
    new Store(path).close(); // and again: no error the second time
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
