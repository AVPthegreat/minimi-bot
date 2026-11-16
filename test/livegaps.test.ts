// One test per failure of the 16 Nov live eval (real models, 26/36). Each passed offline before only
// because the fakes were kinder than the real models; these tests use fakes that behave like the live
// ones (slow router, a model that ignores notes, paraphrases, names subjects its own way, writes
// unsourced prices, searches on its own when given a tool).
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderAnswerTurn } from "../src/llm/prompts.ts";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { priceChecker, unsupportedPrices } from "../src/claims.ts";
import { Store } from "../src/db.ts";
import { GroundingGuard } from "../src/grounding.ts";
import { FakeLLM } from "../src/llm/fake.ts";
import type { AnswerEvent, AnswerInput } from "../src/llm/types.ts";
import { canonicalSubject, fairCap, planSubjects, subjectQueries } from "../src/planner.ts";
import { AnthropicWebSearch } from "../src/search/anthropic.ts";
import { FakeSearch } from "../src/search/fake.ts";
import type { SearchProvider } from "../src/search/types.ts";
import { FakeClock } from "../src/time.ts";
import { MAX_ROWS_SHOWN } from "../src/watch.ts";

async function run(agent: Agent, sid: string, text: string) {
  const events: AgentEvent[] = [];
  for await (const e of agent.chat(sid, text)) events.push(e);
  await agent.idle();
  return { events, text: events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("") };
}

function counted(inner: SearchProvider) {
  const log: string[] = [];
  const search: SearchProvider = { name: inner.name, search: (q, o) => (log.push(q), inner.search(q, o)) };
  return { search, log };
}

function setup(llm?: FakeLLM, wrap?: (s: SearchProvider) => SearchProvider) {
  const clock = new FakeClock("2026-11-09T11:00:00+05:30");
  const world = new FakeSearch(clock);
  const { search, log } = counted(wrap ? wrap(world) : world);
  const store = new Store(":memory:");
  const agent = new Agent({ store, llm: llm ?? new FakeLLM(new FakeSearch(clock), { slowRouter: true }), search, clock, timezone: "Asia/Kolkata", watch: { enabled: true, afterDays: 3, maxSearches: 3 } });
  return { clock, store, agent, log };
}

// ---- 1. One search per subject, planned by the agent, even when the router model misses its budget.

test("planner reads the subjects of a comparison from the message", () => {
  assert.deepEqual(planSubjects("What does Postgres hosting cost on Supabase, Neon and Railway?"), ["Supabase", "Neon", "Railway"]);
  assert.deepEqual(planSubjects("We're a 20-person sales team. Compare HubSpot, Pipedrive, Salesforce, Zoho CRM and Close pricing."), [
    "HubSpot", "Pipedrive", "Salesforce", "Zoho CRM", "Close",
  ]);
  assert.deepEqual(planSubjects("Bun vs Deno for a CLI tool?"), ["Bun", "Deno"]);
  assert.deepEqual(planSubjects("How much is the Cloudflare Workers paid plan?"), []);
  assert.deepEqual(subjectQueries(["Neon", "Railway"], "Postgres hosting cost on Neon and Railway"), ["Neon pricing", "Railway pricing"]);
});

test("a comparison fans out one search per product, started before the (slow) router answers", async () => {
  const llm = new FakeLLM();
  llm.route = () => new Promise(() => {}); // the router model never answers, as live it missed 1.5 s
  const { agent, log } = setup(llm);
  const { events } = await run(agent, agent.newSession().id, "We're a 20-person sales team. Compare HubSpot, Pipedrive, Salesforce, Zoho CRM and Close pricing.");
  assert.equal(log.length, 6, "the question + one per CRM");
  for (const crm of ["HubSpot", "Pipedrive", "Salesforce", "Zoho CRM", "Close"]) assert.ok(log.includes(`${crm} pricing`), crm);
  const sources = events.filter((e) => e.type === "sources").at(-1);
  const domains = sources?.type === "sources" ? sources.sources.map((s) => s.domain) : [];
  for (const d of ["hubspot.com", "pipedrive.com", "salesforce.com", "zoho.com", "close.com"]) assert.ok(domains.includes(d), `${d} is a source`);
});

test("every product priced by the planned round: the tool stays offered but capped at 1, with a coverage note, and unused", async () => {
  const budgets: number[] = [];
  const clock = new FakeClock("2026-11-10T10:00:00+05:30");
  const llm = new FakeLLM(new FakeSearch(clock), { slowRouter: true });
  const base = llm.streamAnswer.bind(llm);
  const coverage: unknown[] = [];
  llm.streamAnswer = (input: AnswerInput) => (budgets.push(input.maxSelfSearches), coverage.push(input.coverage), base(input));
  const store = new Store(":memory:");
  const search = new FakeSearch(clock);
  const agent = new Agent({ store, llm, search, clock, timezone: "Asia/Kolkata" });
  await run(agent, agent.newSession().id, "What does Postgres hosting cost on Supabase, Neon and Railway?");
  assert.deepEqual(budgets, [1], "one model call; coverage is complete, so at most one follow-up was allowed");
  const cov = coverage[0] as Array<{ subject: string; sources: number[] }>;
  assert.deepEqual(cov.map((c) => c.subject).sort(), ["Neon", "Railway", "Supabase"]);
  assert.ok(cov.every((c) => c.sources.length > 0), "each product has a priced source");
  assert.match(renderAnswerTurn({ intent: "search", question: "q", nowLabel: "now", history: [], sources: [], memory: [], notes: [], shown: [], highStakes: false, maxSelfSearches: 1, rounds: [], coverage: [{ subject: "Neon", sources: [2] }, { subject: "Close", sources: [] }] }), /<coverage>\nNeon: priced in \[2\]\nClose: NO priced source\n<\/coverage>/);
  assert.equal(search.log.length, 4, "only the planned round ran: the question + one per product");
});

// ---- 1b. Grounding enforced in code: an unsourced price never reaches the user as fact.

test("grounding guard marks an unsourced price before it is shown, and passes sourced ones", () => {
  const check = priceChecker([{ text: "Neon: the Launch plan costs $19 per month.", about: "Neon Pricing" }]);
  const guard = new GroundingGuard(check);
  let shown = guard.push("Neon is the cheapest");
  assert.equal(shown, "Neon is the cheapest", "text without numbers streams at once");
  shown += guard.push(": Launch is $19 per month [1]. Scale is $59");
  assert.doesNotMatch(shown, /\$59/, "a sentence with a price is held until it is complete");
  shown += guard.push(" per month. Done.\n");
  shown += guard.end();
  assert.match(shown, /Launch is \$19 per month \[1\]\./);
  assert.match(shown, /Scale is \$59 \(unverified\) per month\./);
  assert.deepEqual(guard.flagged, ["$59"]);
});

test("grounding: a source title names the product; a shown total of a sourced price is supported", () => {
  // Live: the cited passage said "$5 per month" without the product name, and the price was flagged.
  const docs = [{ text: "The Workers Paid plan has a minimum charge of $5 per month.", about: "Pricing · Cloudflare Workers docs" }];
  assert.deepEqual(unsupportedPrices("Cloudflare Workers paid plan: $5 per month [1].", docs), []);
  const crm = [{ text: "Zoho CRM: the Standard plan costs $14 per user per month.", about: "Zoho CRM pricing" }];
  assert.deepEqual(unsupportedPrices("| Zoho CRM | Standard | $14 [2] | 20 x $14 = $280 |", crm), []);
  assert.deepEqual(unsupportedPrices("For your team, Zoho CRM Standard is $14 [2], so $280 per month.", crm, { multipliers: [20] }), []);
  assert.deepEqual(unsupportedPrices("Zoho CRM Standard is $14 [2], so $300 per month.", crm, { multipliers: [20] }), ["$300"]);
});

test("an answer model that invents a price: shown as unverified, warned, and tracked only as unverified", async () => {
  const clock = new FakeClock("2026-11-10T10:00:00+05:30");
  const llm = new FakeLLM(undefined, { slowRouter: true });
  llm.streamAnswer = async function* (): AsyncIterable<AnswerEvent> {
    yield { type: "text", text: "Neon's Launch plan is $19 per month [2]. " };
    yield { type: "text", text: "Neon's Business plan is $700 per month.\n" };
  };
  llm.extractClaims = async () => [
    { subject: "Neon", attribute: "Launch plan price", value: "$19", unit: "per month", sourceUrl: null, sourceDate: null },
    { subject: "Neon", attribute: "Business plan price", value: "$700", unit: "per month", sourceUrl: null, sourceDate: null },
  ];
  const store = new Store(":memory:");
  const agent = new Agent({ store, llm, search: new FakeSearch(clock), clock, timezone: "Asia/Kolkata" });
  const { events, text } = await run(agent, agent.newSession().id, "What does Postgres hosting cost on Supabase, Neon and Railway?");
  const deltas = events.flatMap((e) => (e.type === "delta" ? [e.text] : []));
  assert.ok(!deltas.some((d) => /\$700(?! \(unverified\))/.test(d)), "the bare $700 was never streamed");
  assert.match(text, /\$700 \(unverified\)/);
  assert.match(text, /\$19 per month \[2\]/);
  assert.ok(events.some((e) => e.type === "warning" && e.text.includes("$700")));
  const values = (store.db.prepare("SELECT value FROM claims").all() as Array<{ value: string }>).map((r) => r.value);
  assert.deepEqual(values, ["$19", "$700 (unverified)"]);
});

// ---- 2. The user sees honest progress at once, then the answer as it is written.

test("progress: a 'searching' line comes first, each finished search is reported, then the answer streams", async () => {
  const slow = (s: SearchProvider): SearchProvider => ({ name: "slow", search: async (q, o) => (await new Promise((r) => setTimeout(r, 40)), s.search(q, o)) });
  const { agent } = setup(undefined, slow);
  const { events } = await run(agent, agent.newSession().id, "What does Postgres hosting cost on Supabase, Neon and Railway?");
  const kinds = events.map((e) => e.type);
  const firstStatus = kinds.indexOf("status");
  assert.ok(firstStatus >= 0 && firstStatus < kinds.indexOf("route"), "the progress line is sent before routing finishes");
  const first = events[firstStatus];
  assert.match(first?.type === "status" ? first.text : "", /Searching the web for Supabase, Neon, Railway \(4 searches in parallel\)/);
  const finished = events.filter((e) => e.type === "status" && /searches done\)/.test(e.text));
  assert.equal(finished.length, 4);
  assert.ok(events.indexOf(finished.at(-1)!) < kinds.indexOf("delta"));
  const done = events.find((e) => e.type === "done");
  assert.ok(done?.type === "done" && done.timings.firstStatusMs! < done.timings.firstModelTokenMs!);
  assert.ok(events.filter((e) => e.type === "delta").length > 5, "the answer arrives in pieces, not all at once");
});

// ---- 3. The reply states how the date was read, whatever the model writes.

test("'last Tuesday' is stated as 'Last Tuesday = Tue 10 Nov' by code, even if the model ignores it", async () => {
  const { clock, agent } = setup();
  clock.set("2026-11-10T10:00:00+05:30");
  await run(agent, agent.newSession().id, "What does Postgres hosting cost on Supabase, Neon and Railway?");
  clock.set("2026-11-18T09:00:00+05:30"); // a Wednesday: "last Tuesday" could be 17 or 10 Nov
  const { text } = await run(agent, agent.newSession().id, "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
  assert.ok(text.startsWith("**Last Tuesday = Tue 10 Nov.**"), text.slice(0, 120));
  assert.match(text, /could mean Tue 17 Nov or Tue 10 Nov/);
});

// ---- 4. Monday's conversation is found, quoted, and every one of the 5 tools is re-checked.

test("Monday's shortlist: quoted by code, and all 5 tools re-checked even when the model names subjects its own way", async () => {
  const llm = new FakeLLM(undefined, { slowRouter: true });
  // Live, the small model returned editions as subjects and more facts than the old cap of 12 kept.
  llm.extractClaims = async () =>
    ["HubSpot Sales Hub", "Pipedrive", "Salesforce Sales Cloud", "Zoho CRM", "Close"].flatMap((subject) =>
      ["Starter", "Growth", "Pro", "Enterprise"].map((tier, i) => ({
        subject, attribute: `${tier} plan price`, value: `$${10 + i}`, unit: "per seat per month", sourceUrl: null, sourceDate: null,
      })),
    );
  const { clock, store, agent, log } = setup(llm);
  await run(agent, agent.newSession().id, "We're a 20-person sales team. Compare HubSpot, Pipedrive, Salesforce, Zoho CRM and Close pricing.");
  const subjects = (store.db.prepare("SELECT DISTINCT subject FROM claims").all() as Array<{ subject: string }>).map((r) => r.subject).sort();
  assert.deepEqual(subjects, ["Close", "HubSpot", "Pipedrive", "Salesforce", "Zoho CRM"]);
  clock.set("2026-11-12T15:00:00+05:30");
  log.length = 0;
  const { text } = await run(agent, agent.newSession().id, "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?");
  assert.match(text, /\*\*Monday = Mon 9 Nov\.\*\*/);
  assert.match(text, /You asked on Mon 9 Nov, 11:00: "We're a 20-person sales team\. Compare HubSpot, Pipedrive, Salesforce, Zoho CRM and Close pricing\."/);
  for (const t of ["HubSpot", "Pipedrive", "Salesforce", "Zoho CRM", "Close"]) assert.ok(text.includes(`| ${t}:`), `${t} re-checked`);
  assert.equal(log.filter((q) => !/news/.test(q)).length, 5, "one re-check search per tool");
});

test("canonical subjects and a fair cap", () => {
  const c = canonicalSubject({ subject: "HubSpot Sales Hub", attribute: "Starter plan price" }, ["HubSpot", "Close"]);
  assert.deepEqual(c, { subject: "HubSpot", attribute: "Sales Hub Starter plan price" });
  const items = ["A", "A", "A", "A", "B", "C"].map((subject, i) => ({ subject, i }));
  assert.deepEqual(fairCap(items, 4, 3).map((x) => x.i), [0, 1, 4, 5]);
});

// ---- 5. "Anything new?" is bounded in code: at most 3 subjects (every due fact of each, up to 8, shares
// that subject's search), at most 6 table rows, and a line counts the facts checked but not shown.

test("'anything new?' re-checks every fact of at most 3 subjects, shows at most 6 rows and counts the rest", async () => {
  const { clock, store, agent, log } = setup();
  const sid = agent.newSession().id;
  const subjects = ["Supabase", "Neon", "Railway", "HubSpot", "Pipedrive", "Close"];
  store.addClaims(null, sid, subjects.flatMap((s) => ["A", "B", "C"].map((p) => ({
    subject: s, attribute: `${p} plan price`, value: "$1", unit: "per month", sourceUrl: null, sourceDate: null,
  }))), clock.now());
  clock.set("2026-11-20T10:00:00+05:30");
  const { text } = await run(agent, agent.newSession().id, "Anything new?");
  const rows = text.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| What"));
  assert.ok(rows.length > 0);
  assert.ok(new Set(rows.map((l) => l.slice(2).split(":")[0])).size <= 3, "at most 3 subjects");
  assert.equal(rows.length, MAX_ROWS_SHOWN, "3 subjects x 3 facts = 9 checked, 6 shown");
  assert.match(text, /\(3 more facts checked: /, "the 3 not shown are counted");
  assert.ok(log.length <= 6, "one re-check + one news search per subject");
});

// ---- Live run 2 (16 Nov, 30/36): the causes found in its results.

test("run 2: '$50,' is the price $50; plurals match; old prices count only when stated as past", () => {
  assert.deepEqual(unsupportedPrices("Neon Scale is $50, Launch is $19.", "Neon: Scale $50 and Launch $19."), []);
  const page = [{ text: "Workers: $0.30 per million request.", about: "Cloudflare Workers pricing" }];
  assert.deepEqual(unsupportedPrices("Extra requests cost $0.30 per million [1].", page), []);
  const old = [{ text: "Supabase: the Team plan costs $599 per month.", pastOnly: true }];
  assert.deepEqual(unsupportedPrices("Supabase Team was $599 per month on Tue 10 Nov.", old), []);
  assert.deepEqual(unsupportedPrices("Supabase Team: $599 per month then, unchanged now.", old), []);
  assert.deepEqual(unsupportedPrices("Supabase Team is $599 per month.", old), ["$599"], "an old answer never backs today's price");
});

test("run 2: the search model's quoted bullet (with the price) becomes the result's snippet", async () => {
  const client = {
    messages: {
      create: async () => ({
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [
          { type: "server_tool_use", id: "t1", name: "web_search", input: { query: "Railway pricing" } },
          { type: "web_search_tool_result", tool_use_id: "t1", content: [{ type: "web_search_result", url: "https://railway.com/pricing", title: "Pricing | Railway", page_age: null, encrypted_content: "x" }] },
          // The citation is a fragment without the price; the bullet keeps plan, price and unit together.
          { type: "text", text: '- "Hobby plan: $5/month, includes $5 of usage"', citations: [{ type: "web_search_result_location", url: "https://railway.com/pricing", title: "Pricing | Railway", cited_text: "Hobby plan", encrypted_index: "z" }] },
          { type: "text", text: '\n- "Pro plan: $20/seat/month" <https://railway.com/pricing>\n- "Made up: $1" <https://elsewhere.example/>' },
        ],
      }),
    },
  };
  const [r] = await new AnthropicWebSearch(client as never, "claude-haiku-5-5").search("Railway pricing");
  assert.match(r!.snippet, /Hobby plan: \$5\/month/);
  assert.match(r!.snippet, /Pro plan: \$20\/seat\/month/);
  assert.doesNotMatch(r!.snippet, /Made up/);
  assert.deepEqual(unsupportedPrices("Railway Hobby is $5 per month [1].", [{ text: r!.snippet, about: r!.title }]), []);
});

test("run 2: a tool whose prices were all unverified is still tracked (as unverified) and re-checked; short names are filed under the searched name", async () => {
  const llm = new FakeLLM(undefined, { slowRouter: true });
  const base = llm.streamAnswer.bind(llm);
  llm.streamAnswer = async function* (input: AnswerInput): AsyncIterable<AnswerEvent> {
    yield* base(input);
    if (input.intent === "search") yield { type: "text", text: "\n- Zoho's Enterprise tier is $52 per user per month.\n" };
  };
  llm.extractClaims = async () => [
    ...["HubSpot", "Pipedrive", "Salesforce", "Close"].map((subject) => ({ subject, attribute: "Starter plan price", value: "$20", unit: "per seat per month", sourceUrl: null, sourceDate: null })),
    { subject: "Zoho", attribute: "Enterprise plan price", value: "$52", unit: "per user per month", sourceUrl: null, sourceDate: null },
  ];
  const { clock, store, agent } = setup(llm);
  await run(agent, agent.newSession().id, "We're a 20-person sales team. Compare HubSpot, Pipedrive, Salesforce, Zoho CRM and Close pricing.");
  const zoho = store.db.prepare("SELECT subject, value FROM claims WHERE subject LIKE 'Zoho%'").get() as { subject: string; value: string };
  assert.deepEqual({ ...zoho }, { subject: "Zoho CRM", value: "$52 (unverified)" });
  clock.set("2026-11-12T15:00:00+05:30");
  const { text } = await run(agent, agent.newSession().id, "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?");
  for (const t of ["HubSpot", "Pipedrive", "Salesforce", "Zoho CRM", "Close"]) assert.ok(text.includes(`| ${t}:`), `${t} re-checked`);
  assert.match(text, /\| Zoho CRM: Enterprise plan price \| \$52 \(unverified\) per user per month \|/);
});

test("run 2: after a nudge checked the watchlist, the next new chat runs no searches (subjects with many facts)", async () => {
  const { clock, store, agent, log } = setup();
  const sid = agent.newSession().id;
  store.addClaims(null, sid, ["Supabase", "Neon", "Railway"].flatMap((s) => ["Free", "Launch", "Pro", "Team"].map((p) => ({
    subject: s, attribute: `${p} plan price`, value: "$1", unit: "per month", sourceUrl: null, sourceDate: null,
  }))), clock.now());
  clock.set("2026-11-16T09:00:00+05:30");
  await agent.nudge(agent.newSession().id);
  assert.ok(log.length > 0 && log.length <= 3, "one search per subject");
  clock.set("2026-11-16T09:30:00+05:30");
  log.length = 0;
  assert.equal(await agent.nudge(agent.newSession().id), null);
  assert.equal(log.length, 0, "every fact of a checked subject was marked checked");
});
