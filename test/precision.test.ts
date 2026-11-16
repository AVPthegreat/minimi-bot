// Live run 3 (16 Nov, 33/36) and a bug the founder hit in the real UI. Each test fails without its fix.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { diffClaim, renderDiffTable, unsupportedPrices } from "../src/claims.ts";
import { Store } from "../src/db.ts";
import { GroundingGuard } from "../src/grounding.ts";
import { priceChecker } from "../src/claims.ts";
import { FakeLLM } from "../src/llm/fake.ts";
import { ownQuestion, rulesRoute } from "../src/router.ts";
import { FakeSearch } from "../src/search/fake.ts";
import type { SearchProvider } from "../src/search/types.ts";
import { FakeClock } from "../src/time.ts";

function setup() {
  const clock = new FakeClock("2026-11-10T10:00:00+05:30");
  const world = new FakeSearch(clock);
  const log: string[] = [];
  const search: SearchProvider = { name: "fake", search: (q, o) => (log.push(q), world.search(q, o)) };
  const store = new Store(":memory:");
  const agent = new Agent({ store, llm: new FakeLLM(new FakeSearch(clock), { slowRouter: true }), search, clock, timezone: "Asia/Kolkata" });
  return { agent, log, clock };
}

async function run(agent: Agent, sid: string, text: string) {
  const events: AgentEvent[] = [];
  for await (const e of agent.chat(sid, text)) events.push(e);
  await agent.idle();
  const route = events.find((e) => e.type === "route") as Extract<AgentEvent, { type: "route" }> | undefined;
  return { intent: route?.intent, text: events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("") };
}

// ---- 1. Routing: a message with its own question is that question, not a re-check of the last answer.

test("routing: a new question next to 'is that still correct?' is answered as that question", () => {
  const msg = `"What does Postgres hosting cost on Supabase and Neon?" then "Is that still correct?"`;
  assert.equal(ownQuestion(msg), "What does Postgres hosting cost on Supabase and Neon?");
  const r = rulesRoute(msg, false, true);
  assert.equal(r?.intent, "search");
  assert.deepEqual(r?.searchQueries, ["What does Postgres hosting cost on Supabase and Neon?"]);
  // Still a re-check: the message is the follow-up itself, or its other part points back to memory.
  assert.equal(ownQuestion("Is that still correct?"), null);
  assert.equal(rulesRoute("What did I ask you on 3 November? Is your answer still correct today?", true, false)?.intent, "verify");
  assert.equal(rulesRoute("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", true, false)?.intent, "verify");
  assert.equal(rulesRoute("who made you?", false, false)?.intent, "chat");
});

test("agent: the founder's message searches the new question per product, never the previous small talk", async () => {
  const { agent, log } = setup();
  const sid = agent.newSession().id;
  assert.equal((await run(agent, sid, "who made you?")).intent, "chat");
  const r = await run(agent, sid, `"What does Postgres hosting cost on Supabase and Neon?" then "Is that still correct?"`);
  assert.equal(r.intent, "search");
  assert.ok(log.includes("Supabase pricing") && log.includes("Neon pricing"), log.join(" | "));
  assert.ok(!log.some((q) => /who made you/i.test(q)), "no search for the small talk");
});

test("agent: 'is that still correct?' after small talk says there is nothing to re-check, without searching", async () => {
  const { agent, log } = setup();
  const sid = agent.newSession().id;
  await run(agent, sid, "who made you?");
  const r = await run(agent, sid, "Is that still correct?");
  assert.equal(r.intent, "verify");
  assert.equal(log.length, 0, "no web search");
  assert.match(r.text, /nothing factual/);
});

// ---- 2. Grounding: a price backed by the gathered sources passes; only unsourced numbers are flagged.

const cloudflare = [
  { n: 2, text: "Cloudflare Workers Pricing: $5 Minimum, 10M Requests Included\nThe Workers Paid plan costs $5/month and includes 10 million requests.", about: "dev Cloudflare Workers Pricing" },
  { n: 5, text: "Workers Paid: 5 USD per month minimum. Requests: $0.30 per additional million.", about: "srvrlss Cloudflare Workers Pricing 2026" },
];
const cfNames = ["Cloudflare", "Workers", "dev", "srvrlss"];

function stream(answer: string, check: ReturnType<typeof priceChecker>) {
  const guard = new GroundingGuard(check);
  let out = "";
  for (const piece of answer.split(/(?<=\s)/)) out += guard.push(piece);
  return { out: out + guard.end(), flagged: guard.flagged };
}

test("run 3: '$5' in generic sentences about the plan named earlier is backed (was flagged 3 times)", () => {
  const answer =
    "**The Cloudflare Workers Paid plan costs $5 per month per account** [2][5].\n\n" +
    "**What the $5/month includes:**\n- 10 million requests per month [2]\n\n" +
    "All five sources agree on the $5/month price, but none is Cloudflare's own page.\n" +
    "**What you pay on top of the $5 minimum:** requests cost $0.30 per million [5].\n";
  const r = stream(answer, priceChecker(cloudflare, { names: cfNames }));
  assert.deepEqual(r.flagged, []);
  assert.doesNotMatch(r.out, /unverified/);
  // Still precise: an amount no source states, or a sourced amount said about another product.
  assert.deepEqual(stream(`${answer}What the $7/month adds is unclear.\n`, priceChecker(cloudflare, { names: cfNames })).flagged, ["$7"]);
  assert.deepEqual(unsupportedPrices("Neon Launch is $5 per month.", cloudflare, { names: [...cfNames, "Neon"] }), ["$5"]);
});

test("run 3: a price backed by the source it cites passes; citing a source about another product does not", () => {
  const docs = [
    { n: 8, text: "Supabase Pro costs $25 per organization per month.", about: "supabase Supabase pricing" },
    { n: 12, text: "This month: Pro now comes with $10 of compute credits.", about: "mean Supabase News" },
    { n: 3, text: "Neon gives $10 of credit to new accounts.", about: "neon Neon pricing" },
  ];
  const names = ["Supabase", "Neon", "mean"];
  assert.deepEqual(unsupportedPrices("**Supabase Pro** at $25/month includes $10 in compute credits [12].", docs, { names }), []);
  assert.deepEqual(unsupportedPrices("One says $25/month per project [5]; another says $25 per organization [8].", docs, { names: [...names, "uibakery"] }), []);
  assert.deepEqual(unsupportedPrices("**Supabase Pro** at $25/month includes $15 in compute credits [12].", docs, { names }), ["$15"]);
  assert.deepEqual(unsupportedPrices("Railway Pro includes $10 in credits [3].", docs, { names: [...names, "Railway"] }), ["$10"]);
});

test("run 3: each price belongs to its own clause ('$5/month on Railway, about $15/month typical on Neon')", () => {
  const docs = [
    { n: 1, text: "Neon Pricing: Typical Spend $15/Month on Launch.", about: "neon Neon pricing" },
    { n: 2, text: "Hobby: $5/month, includes $5 of usage.", about: "railway Railway pricing" },
    { n: 4, text: "Supabase Pro: $25/month per organization.", about: "jetadmin Supabase pricing" },
  ];
  const names = ["Supabase", "Neon", "Railway", "Postgres"];
  const s = "Paid Postgres hosting starts at **$5/month on Railway**, **about $15/month typical on Neon**, and **$25/month on Supabase Pro**.";
  assert.deepEqual(unsupportedPrices(s, docs, { names }), []);
  assert.deepEqual(unsupportedPrices("Paid hosting starts at **$5/month on Neon**, **about $15/month on Railway**.", docs, { names }), ["$5", "$15"]);
});

test("run 3: totals for the user's team size pass when the unit price is sourced for that product", () => {
  const docs = [
    { n: 7, text: "Pipedrive Lite: $14/user/month billed annually.", about: "dupple Pipedrive pricing" },
    { n: 11, text: "HubSpot Sales Hub Starter: $20 per seat per month.", about: "resonatehq HubSpot pricing" },
  ];
  const names = ["Pipedrive", "HubSpot"];
  const s = "For 20 seats, the lowest are **Pipedrive Lite at about $280/month** and **HubSpot Starter at about $400/month**.";
  assert.deepEqual(unsupportedPrices(s, docs, { names, multipliers: [20] }), []);
  // A total of another product's price, or a number that is no sourced price times the team size.
  assert.deepEqual(unsupportedPrices("**HubSpot Starter at about $280/month** for 20 seats.", docs, { names, multipliers: [20] }), ["$280"]);
  assert.deepEqual(unsupportedPrices("**Pipedrive Lite at about $300/month**.", docs, { names, multipliers: [20] }), ["$300"]);
});

test("number formats: '$5.00', '5 USD', 'USD 5', '₹499' / 'Rs. 499', '₹1,49,999' compare as the same amounts", () => {
  const docs = [
    { text: "Acme Basic: USD 5 per month. Acme Team: Rs. 499 per user. Acme Enterprise: ₹1,49,999 a year.", about: "acme Acme pricing" },
  ];
  const names = ["Acme"];
  assert.deepEqual(unsupportedPrices("Acme Basic is $5.00/month, Team is ₹499/month and Enterprise ₹1,49,999/year.", docs, { names }), []);
  assert.deepEqual(unsupportedPrices("Acme Enterprise is ₹1,49,000 a year.", docs, { names }), ["₹1,49,000"]);
  assert.deepEqual(unsupportedPrices("Acme Basic is €5 per month.", docs, { names }), ["€5"]);
  // While streaming, "Rs. 999" is one price, not a sentence end followed by a bare number.
  assert.deepEqual(stream("Acme Team is Rs. 999 per user. Done.\n", priceChecker(docs, { names })).flagged, ["Rs. 999"]);
});

// ---- 3. "Changed" means the value changed.

test("diff: a status-only change is 'Unchanged, now confirmed'; wording-only changes are unchanged", () => {
  const was = (value: string, unit: string | null) => ({ subject: "Cloudflare Workers", attribute: "Paid plan minimum price", value, unit });
  const confirmed = diffClaim(was("$5 (unverified)", "per month per account"), { value: "$5", unit: "per month", sourceN: 5 });
  assert.equal(confirmed.status, "unchanged");
  assert.match(renderDiffTable([confirmed], "Tue 3 Nov", "Sun 15 Nov"), /\| Unchanged, now confirmed \|/);
  assert.equal(diffClaim(was("$25", "per month per organization"), { value: "$25", unit: "per organization per month" }).status, "unchanged");
  assert.equal(diffClaim(was("$20", "per month per workspace"), { value: "$20", unit: "per month" }).status, "unchanged");
  assert.equal(diffClaim(was("2 projects, 500 MB each", null), { value: "2 projects, 500 MB database each" }).status, "unchanged");
  // Real changes still show as changed.
  assert.equal(diffClaim(was("$350", "per user per month"), { value: "$330", unit: "per user per month" }).status, "changed");
  assert.equal(diffClaim(was("$5 (unverified)", "per month"), { value: "$7", unit: "per month" }).status, "changed");
  assert.equal(diffClaim(was("$20", "per month"), { value: "$20", unit: "per year" }).status, "changed");
  assert.equal(diffClaim(was("2 GB", null), { value: "2 TB" }).status, "changed");
  assert.equal(diffClaim(was("$20", "per seat per month"), { value: "$20", unit: "per organization per month" }).status, "changed");
});

// ---- 4. The eval's grounding check: fails on a price shown as fact without a source, counts flagged ones apart.

test("eval check: an unmarked unsourced price fails; an honestly flagged one passes and is counted", async () => {
  const { pricesShownAsFactWithoutSource } = await import("../eval/scenarios.ts");
  const store = new Store(":memory:");
  const sid = store.createSession("s", 0).id;
  const id = store.addMessage(sid, "user", "How much is Neon Launch?", 0);
  store.logSearch(id, "Neon pricing", "fake", "answer", [{ title: "Neon pricing", url: "https://neon.com", snippet: "Launch: $19 per month." }], 0);
  const base = { sources: [], warnings: [], searches: 1, firstTokenMs: 0, totalMs: 0, userMessageId: id, intent: "search" };
  assert.deepEqual(pricesShownAsFactWithoutSource({ ...base, text: "Neon Launch is $19 per month [1].", unverified: [] }, store, ""), []);
  assert.deepEqual(pricesShownAsFactWithoutSource({ ...base, text: "Neon Launch is $25 per month.", unverified: [] }, store, ""), ["$25"]);
  assert.deepEqual(pricesShownAsFactWithoutSource({ ...base, text: "Neon Launch is $25 (unverified) per month.", unverified: ["$25"] }, store, ""), []);
  // A total is a sourced amount times a number the user gave.
  assert.deepEqual(pricesShownAsFactWithoutSource({ ...base, text: "For your team: $380 a month.", unverified: [] }, store, "We are 20 people"), []);
  assert.deepEqual(pricesShownAsFactWithoutSource({ ...base, text: "For your team: $400 a month.", unverified: [] }, store, "We are 20 people"), ["$400"]);
  // A price the guard flagged must reach the user marked, or the check fails.
  const { SCENARIOS } = await import("../eval/scenarios.ts");
  const check = SCENARIOS.flatMap((sc) => sc.steps.flatMap((st) => st.checks)).find((c) => c.name === "no price shown as fact without a source")!;
  assert.equal(check.ok({ ...base, text: "Neon Launch is $25 per month.", unverified: ["$25"] }, { store, question: "" }), false);
  assert.equal(check.ok({ ...base, text: "Neon Launch is $25 (unverified) per month.", unverified: ["$25"] }, { store, question: "" }), true);
  store.close();
});
