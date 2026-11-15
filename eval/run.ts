// `npm run eval`       offline: fake model + fixture web, deterministic.
// `npm run eval:live`  real Claude + Tavily (needs keys), same scripts and clock; checks that depend on
//                      the fixture web are skipped, and latency numbers become meaningful.

import { loadConfig } from "../src/config.ts";
import { buildModels } from "../src/index.ts";
import { FakeLLM } from "../src/llm/fake.ts";
import { FakeSearch } from "../src/search/fake.ts";
import { UsageMeter } from "../src/usage.ts";
import { SCENARIOS, runScenario } from "./scenarios.ts";

const live = process.env.EVAL_LIVE === "1";
const cfg = loadConfig();
if (live && cfg.fakeMode) {
  console.error("eval:live needs ANTHROPIC_API_KEY (and optionally TAVILY_API_KEY) in the environment or .env");
  process.exit(2);
}
// A live eval spends money: cap it (MAX_SPEND_USD, default $5). Scenarios stop once the cap is hit.
const meter = new UsageMeter(cfg.maxSpendUsd ?? 5);
const only = process.env.EVAL_ONLY;

let failed = 0;
let passed = 0;
for (const sc of SCENARIOS.filter((s) => !only || s.name === only)) {
  if (live && meter.limitUsd !== null && meter.costUsd >= meter.limitUsd) {
    console.log(`\nSkipping ${sc.name}: spend cap reached.`);
    continue;
  }
  console.log(`\n## ${sc.name}\n${sc.about}`);
  const reports = await runScenario(
    sc,
    (clock) =>
      live ? buildModels(cfg, clock, meter) : { llm: new FakeLLM(), search: new FakeSearch(clock) },
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
console.log(`\n${passed} passed, ${failed} failed (${live ? `live, search: ${cfg.searchProvider}` : "offline"})`);
if (live) console.log(`Spend: ${meter.summary()}`);
process.exit(failed ? 1 : 0);
