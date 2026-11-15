// `npm run eval`       offline: fake model + fixture web, deterministic.
// `npm run eval:live`  real Claude + Tavily (needs keys), same scripts and clock; checks that depend on
//                      the fixture web are skipped, and latency numbers become meaningful.

import { loadConfig } from "../src/config.ts";
import { AnthropicLLM } from "../src/llm/anthropic.ts";
import { FakeLLM } from "../src/llm/fake.ts";
import { FakeSearch } from "../src/search/fake.ts";
import { TavilySearch } from "../src/search/tavily.ts";
import { SCENARIOS, runScenario } from "./scenarios.ts";

const live = process.env.EVAL_LIVE === "1";
const cfg = loadConfig();
if (live && (!cfg.anthropicKey || !cfg.tavilyKey)) {
  console.error("eval:live needs ANTHROPIC_API_KEY and TAVILY_API_KEY in .env");
  process.exit(2);
}

let failed = 0;
let passed = 0;
for (const sc of SCENARIOS) {
  console.log(`\n## ${sc.name}\n${sc.about}`);
  const reports = await runScenario(
    sc,
    (clock) =>
      live
        ? { llm: new AnthropicLLM({ apiKey: cfg.anthropicKey, answerModel: cfg.answerModel, fastModel: cfg.fastModel, answerEffort: cfg.answerEffort, fastSpeed: cfg.fastSpeed }), search: new TavilySearch(cfg.tavilyKey) }
        : { llm: new FakeLLM(), search: new FakeSearch(clock) },
    { live },
  );
  for (const r of reports) {
    const t = r.result.firstTokenMs === null ? "" : ` | first token ${r.result.firstTokenMs} ms, total ${r.result.totalMs} ms`;
    console.log(`  ${r.step}. "${r.say}" -> ${r.result.intent ?? "nudge"} | ${r.result.searches} searches${t}`);
    for (const c of r.checks) {
      if (c.skipped) console.log(`     -  ${c.name} (skipped live)`);
      else if (c.pass) (passed++, console.log(`     ok ${c.name}`));
      else (failed++, console.log(`     FAIL ${c.name}`));
    }
    if (process.env.EVAL_VERBOSE) console.log(r.result.text.replace(/^/gm, "       | "));
  }
}
console.log(`\n${passed} passed, ${failed} failed (${live ? "live" : "offline"})`);
process.exit(failed ? 1 : 0);
