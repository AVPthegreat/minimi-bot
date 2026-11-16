// The agent-loop parts: speculative search during routing, the answer model's own bounded searches,
// one Anthropic search call per query, and the "current evidence only" price guard.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { Store } from "../src/db.ts";
import { FakeLLM } from "../src/llm/fake.ts";
import type { AnswerEvent, AnswerInput, LLM } from "../src/llm/types.ts";
import { AnthropicWebSearch } from "../src/search/anthropic.ts";
import { FakeSearch } from "../src/search/fake.ts";
import { runQueries } from "../src/search/rank.ts";
import type { SearchProvider } from "../src/search/types.ts";
import { FakeClock } from "../src/time.ts";

async function run(agent: Agent, sid: string, text: string) {
  const events: AgentEvent[] = [];
  for await (const e of agent.chat(sid, text)) events.push(e);
  await agent.idle();
  return { events, text: events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("") };
}

function make(llm: LLM, search: SearchProvider, clock = new FakeClock("2026-11-10T10:00:00+05:30")) {
  const store = new Store(":memory:");
  return { store, clock, agent: new Agent({ store, llm, search, clock, timezone: "Asia/Kolkata" }) };
}

test("a slow router never blocks search: the speculative search answers within the short router budget", async () => {
  const clock = new FakeClock("2026-11-10T10:00:00+05:30");
  const search = new FakeSearch(clock);
  const slow = new FakeLLM(search);
  slow.route = () => new Promise(() => {}); // the router model hangs
  const { agent } = make(slow, search, clock);
  const t0 = performance.now();
  const { events, text } = await run(agent, agent.newSession().id, "How much is the Cloudflare Workers paid plan?");
  assert.ok(performance.now() - t0 < 2500, "answered within the speculative router budget");
  const route = events.find((e) => e.type === "route");
  assert.equal(route?.type === "route" && route.via, "fallback");
  assert.equal(search.log.length, 1, "the speculative search was reused, not repeated");
  assert.match(text, /\$5/);
});

test("the speculative search is cancelled when the router says no search is needed", async () => {
  let aborted = false;
  const search: SearchProvider = {
    name: "watching",
    search: (_q, o) =>
      new Promise((resolve) => {
        o?.signal?.addEventListener("abort", () => ((aborted = true), resolve([])));
        setTimeout(() => resolve([]), 200);
      }),
  };
  const llm = new FakeLLM();
  llm.route = async () => ({ intent: "chat", memoryQuery: "", searchQueries: [], sinceDays: 0, highStakes: false });
  const { store, agent } = make(llm, search);
  const sid = agent.newSession().id;
  await run(agent, sid, "Write me a haiku about databases");
  assert.ok(aborted);
  assert.equal(store.searchesFor(store.sessionMessages(sid)[0]!.id).length, 0);
});

/** The agent's one search provider; it finds nothing until `open` (the planned round runs before that). */
function lateWorld(clock: FakeClock, missing: (q: string) => boolean = () => true) {
  const world = new FakeSearch(clock);
  const state = { open: false, log: [] as string[] };
  const search: SearchProvider = {
    name: "late",
    search: (q, o) => (state.log.push(q), !state.open && missing(q) ? Promise.resolve([]) : world.search(q, o)),
  };
  return { search, state };
}

/** Opens the world when the answer model is first called: everything it searches finds pages. */
function openOnAnswer(llm: LLM, state: { open: boolean }): LLM {
  const base = llm.streamAnswer.bind(llm);
  llm.streamAnswer = (input: AnswerInput) => ((state.open = true), base(input));
  return llm;
}

test("agent loop: when the planned round finds nothing, the model searches itself; the pages are sources, cited and grounded", async () => {
  const clock = new FakeClock("2026-11-10T10:00:00+05:30");
  const { search, state } = lateWorld(clock);
  const { store, agent } = make(openOnAnswer(new FakeLLM(search), state), search, clock);
  const sid = agent.newSession().id;
  const { events, text } = await run(agent, sid, "What does Neon Postgres cost?");
  assert.ok(events.some((e) => e.type === "status" && e.text.startsWith("Searching again:")));
  const sources = events.filter((e) => e.type === "sources").at(-1);
  const neon = sources?.type === "sources" ? sources.sources.find((s) => s.domain === "neon.com") : undefined;
  assert.ok(neon, "the follow-up page is a source");
  assert.match(text, new RegExp(`Neon: the Launch plan costs \\$19 per month \\[${neon.n}\\]`));
  assert.ok(!events.some((e) => e.type === "warning"), "self-found prices count as evidence");
  assert.ok(events.some((e) => e.type === "search" && e.state === "done"), "the follow-up search reports its end like a planned one");
  assert.ok(store.searchesFor(store.sessionMessages(sid)[0]!.id).some((s) => s.purpose === "self-search"));
});

test("agent loop: a product the planned round missed is searched again (1 tool call), cited and grounded", async () => {
  const clock = new FakeClock("2026-11-10T10:00:00+05:30");
  const { search, state } = lateWorld(clock, (q) => /supabase/i.test(q));
  const seen: number[] = [];
  const llm = openOnAnswer(new FakeLLM(search), state);
  const base = llm.streamAnswer.bind(llm);
  const budgets: number[] = [];
  llm.streamAnswer = (input: AnswerInput) => (seen.push(input.rounds.length), budgets.push(input.maxSelfSearches), base(input));
  const { store, agent } = make(llm, search, clock);
  const sid = agent.newSession().id;
  const { events, text } = await run(agent, sid, "Compare Neon and Supabase pricing");
  assert.equal(budgets[0], 3, "a product without a priced source: the full budget");
  const done = events.find((e) => e.type === "done");
  assert.deepEqual(done?.type === "done" && done.loop, { selfSearches: 1, covered: false });
  assert.deepEqual(seen, [0, 1], "two model calls: one tool round, then the answer");
  const last = events.filter((e) => e.type === "sources").at(-1);
  const supa = last?.type === "sources" ? last.sources.find((s) => s.domain === "supabase.com") : undefined;
  assert.ok(supa, "the follow-up page is a source");
  assert.match(text, new RegExp(`Supabase: [^\\n]*\\$\\d+[^\\n]*\\[${supa.n}\\]`));
  assert.ok(!events.some((e) => e.type === "warning"));
  const self = store.searchesFor(store.sessionMessages(sid)[0]!.id).filter((s) => s.purpose === "self-search");
  assert.deepEqual(self.map((s) => s.query), ["Supabase pricing"]);
});

test("agent loop is bounded: a model that always wants more gets at most ANSWER_MAX_SEARCHES searches, then must answer", async () => {
  const clock = new FakeClock("2026-11-10T10:00:00+05:30");
  const world = new FakeSearch(clock);
  const budgets: number[] = [];
  let call = 0;
  const greedy = new FakeLLM();
  greedy.streamAnswer = async function* (input: AnswerInput): AsyncIterable<AnswerEvent> {
    budgets.push(input.maxSelfSearches);
    if (input.maxSelfSearches > 0) {
      // Two calls per round, whatever the budget says.
      yield { type: "tool_call", id: `c${call++}`, query: "Neon pricing" };
      yield { type: "tool_call", id: `c${call++}`, query: "Railway pricing" };
      return;
    }
    const found = input.rounds.flatMap((r) => r.results.flatMap((x) => x.sources));
    const refused = input.rounds.flatMap((r) => r.results.filter((x) => x.error));
    yield { type: "text", text: `Done after ${input.rounds.length} rounds; ${found.length} pages; ${refused.length} refused.` };
  };
  const store = new Store(":memory:");
  const agent = new Agent({ store, llm: greedy, search: world, clock, timezone: "Asia/Kolkata", maxSelfSearches: 3 });
  const sid = agent.newSession().id;
  const { text } = await run(agent, sid, "What does Supabase cost?");
  assert.deepEqual(budgets, [3, 1, 0], "the budget shrinks each round and the last call has no tool");
  const self = store.searchesFor(store.sessionMessages(sid)[0]!.id).filter((s) => s.purpose === "self-search");
  assert.equal(self.length, 3, "2 + 1 searches ran");
  assert.match(text, /Done after 2 rounds; \d+ pages; 1 refused/, "the 4th call got a 'budget used up' result");
});

test("agent loop stops searching when the spend cap is reached", async () => {
  const clock = new FakeClock("2026-11-10T10:00:00+05:30");
  const llm = new FakeLLM();
  llm.streamAnswer = async function* (input: AnswerInput): AsyncIterable<AnswerEvent> {
    if (input.maxSelfSearches > 0) yield { type: "tool_call", id: "c1", query: "Neon pricing" };
    else yield { type: "text", text: "answer" };
  };
  const store = new Store(":memory:");
  const meter = { check: () => { throw new Error("Spend cap reached"); } };
  const agent = new Agent({ store, llm, search: new FakeSearch(clock), clock, timezone: "Asia/Kolkata", meter });
  const sid = agent.newSession().id;
  const { text } = await run(agent, sid, "What does Supabase cost?");
  assert.match(text, /spend cap is reached/);
  assert.equal(store.searchesFor(store.sessionMessages(sid)[0]!.id).filter((s) => s.purpose === "self-search").length, 0);
});

test("the loop is off for small talk, recall and arithmetic: zero searches", async () => {
  const seen: number[] = [];
  const clock = new FakeClock("2026-11-10T10:00:00+05:30");
  const world = new FakeSearch(clock);
  const llm = new FakeLLM(world);
  const base = llm.streamAnswer.bind(llm);
  llm.streamAnswer = (input: AnswerInput) => (seen.push(input.maxSelfSearches), base(input));
  const { agent } = make(llm, world, clock);
  const sid = agent.newSession().id;
  await run(agent, sid, "hi");
  await run(agent, sid, "What did I ask you yesterday?");
  await run(agent, sid, "What is 17 * 23?");
  assert.deepEqual(seen, [0, 0, 0]);
  assert.deepEqual(world.log, [], "no search of any kind");
});

test("a stale price copied from an old answer is flagged", async () => {
  const clock = new FakeClock("2026-11-10T10:00:00+05:30");
  const search = new FakeSearch(clock);
  const llm = new FakeLLM(search);
  const base = llm.streamAnswer.bind(llm);
  // A model that repeats what it said last time instead of reading today's sources.
  llm.streamAnswer = async function* (input: AnswerInput): AsyncIterable<AnswerEvent> {
    yield* base(input);
    if (input.history.some((m) => m.content.includes("$19"))) yield { type: "text", text: "\n\nAs I said before, Neon's Launch plan is $19 per month." };
  };
  const { agent } = make(llm, search, clock);
  const sid = agent.newSession().id;
  await run(agent, sid, "What does Postgres hosting cost on Supabase, Neon and Railway?");
  clock.set("2026-11-18T09:00:00+05:30"); // Neon is now $15
  const { events } = await run(agent, sid, "What does Postgres hosting cost on Supabase, Neon and Railway?");
  const warnings = events.flatMap((e) => (e.type === "warning" ? [e.text] : []));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /\$19/);
});

test("re-check of facts the web no longer confirms never claims 'nothing changed'", async () => {
  const clock = new FakeClock("2026-11-10T10:00:00+05:30");
  const world = new FakeSearch(clock);
  let down = false;
  const flaky: SearchProvider = { name: "flaky", search: (q, o) => (down ? Promise.resolve([]) : world.search(q, o)) };
  const { agent } = make(new FakeLLM(), flaky, clock);
  await run(agent, agent.newSession().id, "What does Postgres hosting cost on Supabase, Neon and Railway?");
  clock.set("2026-11-18T09:00:00+05:30");
  down = true;
  const { text } = await run(agent, agent.newSession().id, "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
  assert.doesNotMatch(text, /Nothing I checked has changed/);
  assert.match(text, /I couldn't verify any of the 5 facts from Tue 10 Nov/);
});

test("Anthropic web search: one small call per planned query, all in parallel, results and quotes per query", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const pages: Record<string, { url: string; title: string; quote: string }> = {
    "Supabase pricing": { url: "https://supabase.com/pricing", title: "Supabase Pricing", quote: "Pro $25/month" },
    "Neon pricing": { url: "https://neon.com/pricing", title: "Neon Pricing", quote: "Launch plan $15/month" },
  };
  const client = {
    messages: {
      create: async (body: { messages: Array<{ content: string }> }) => {
        calls.push(body as never);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        const q = body.messages[0]!.content.replace(/^Query: /, "");
        const p = pages[q]!;
        return {
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 50, server_tool_use: { web_search_requests: 1 } },
          content: [
            { type: "server_tool_use", id: "t1", name: "web_search", input: { query: q } },
            { type: "web_search_tool_result", tool_use_id: "t1", content: [{ type: "web_search_result", url: p.url, title: p.title, page_age: "November 14, 2026", encrypted_content: "x" }] },
            { type: "text", text: `- ${p.quote}`, citations: [{ type: "web_search_result_location", url: p.url, title: p.title, cited_text: p.quote, encrypted_index: "z" }] },
          ],
        };
      },
    },
  };
  const provider = new AnthropicWebSearch(client as never, "claude-haiku-5-5");
  const runs = await runQueries(provider, [
    { query: "Supabase pricing", purpose: "answer" },
    { query: "Neon pricing", purpose: "answer" },
  ]);
  assert.equal(calls.length, 2, "one model call per query: the agent's plan is what runs");
  assert.equal(maxInFlight, 2, "the calls run in parallel");
  for (const c of calls) assert.equal((c.tools as Array<{ max_uses: number }>)[0]!.max_uses, 1);
  assert.equal(runs[0]!.results[0]!.url, "https://supabase.com/pricing");
  assert.equal(runs[1]!.results[0]!.url, "https://neon.com/pricing");
  assert.equal(runs[1]!.results[0]!.snippet, "Launch plan $15/month");
  assert.equal(runs[1]!.results[0]!.publishedDate, "2026-11-14");
});
