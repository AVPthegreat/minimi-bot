import assert from "node:assert/strict";
import { test } from "node:test";
import { route, rulesRoute } from "../src/router.ts";
import type { LLM } from "../src/llm/types.ts";

test("rules: small talk, recall, verify and 'anything new' never need a model call", () => {
  assert.equal(rulesRoute("hi!", false, false)?.intent, "chat");
  assert.equal(rulesRoute("thanks", false, true)?.intent, "chat");
  assert.equal(rulesRoute("What did I ask you on 3 November?", true, false)?.intent, "recall");
  assert.equal(rulesRoute("What did I ask you on 3 November? Is your answer still correct today?", true, false)?.intent, "verify");
  assert.equal(rulesRoute("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", true, false)?.intent, "verify");
  assert.equal(rulesRoute("On Monday we shortlisted 5 CRM tools. Has any of them changed pricing or shipped something big since?", true, false)?.intent, "verify");
  assert.equal(rulesRoute("Is that still correct?", false, true)?.intent, "verify");
  assert.equal(rulesRoute("anything new?", false, false)?.intent, "updates");
});

test("rules defer to the model when unsure", () => {
  assert.equal(rulesRoute("What's the best Postgres host for a side project?", false, false), null);
  assert.equal(rulesRoute("Is Rust still popular?", false, false), null); // 'still' without a pointer to the past
  assert.equal(rulesRoute("anything new in React 20?", false, false), null);
});

test("rules extract the topic without time words", () => {
  const r = rulesRoute("Last Tuesday I asked you about Postgres hosting. Has pricing changed?", true, false, "I asked you about Postgres hosting. Has pricing changed?");
  assert.equal(r?.intent, "verify");
  assert.equal(r?.memoryQuery, "Postgres hosting pricing");
});

const slowModel: LLM = {
  name: "slow",
  route: () => new Promise(() => {}), // never answers
  streamAnswer: async function* () {},
  extractClaims: async () => [],
  recheck: async () => [],
};

test("a slow router model falls back to search instead of hanging", async () => {
  const plan = await route(slowModel, { text: "What is the Neon Launch plan price?", rest: "", nowLabel: "", history: [], timePhrases: [] }, { timeoutMs: 50 });
  assert.equal(plan.via, "fallback");
  assert.equal(plan.intent, "search");
  assert.deepEqual(plan.searchQueries, ["What is the Neon Launch plan price?"]);
});

test("model plans are cleaned: duplicate queries removed, at most 5", async () => {
  const model: LLM = {
    ...slowModel,
    route: async () => ({ intent: "search", memoryQuery: "", searchQueries: ["a", "a ", "b", "c", "d", "e", "f"], sinceDays: 0, highStakes: false }),
  };
  const plan = await route(model, { text: "compare things", rest: "compare things", nowLabel: "", history: [], timePhrases: [] });
  assert.deepEqual(plan.searchQueries, ["a", "b", "c", "d", "e"]);
});
