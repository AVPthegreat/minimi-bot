// `npm run eval`       offline: fake model + fixture web, deterministic.
// `npm run eval:live`  real Claude + search (needs ANTHROPIC_API_KEY), same scripts and clock; checks that
//                      depend on the fixture web are skipped. Writes eval/results/live-<time>.{json,md} with
//                      latency p50/p95 per question type and the spend, ready to paste into DESIGN.md.
//                      (EVAL_RESULTS=1 writes the same files for an offline run.)

import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { buildModels } from "../src/index.ts";
import { FakeLLM } from "../src/llm/fake.ts";
import { FakeSearch } from "../src/search/fake.ts";
import { UsageMeter } from "../src/usage.ts";
import { SCENARIOS, type StepReport, runScenario } from "./scenarios.ts";

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
const all: StepReport[] = [];
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
  all.push(...reports);
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
if (live || process.env.EVAL_RESULTS === "1") {
  const file = writeResults(all);
  console.log(`Results: ${file}.json and .md`);
}
process.exit(failed ? 1 : 0);

/** Nearest-rank percentile. */
function pct(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

function writeResults(reports: StepReport[]): string {
  const turns = reports.filter((r) => r.result.intent);
  const byIntent = new Map<string, StepReport[]>();
  for (const r of turns) byIntent.set(r.result.intent!, [...(byIntent.get(r.result.intent!) ?? []), r]);
  const latency = [...byIntent.entries()].map(([intent, rs]) => {
    const first = rs.flatMap((r) => (r.result.firstTokenMs === null ? [] : [r.result.firstTokenMs]));
    const total = rs.map((r) => r.result.totalMs);
    return {
      intent,
      turns: rs.length,
      firstTokenP50: pct(first, 50),
      firstTokenP95: pct(first, 95),
      totalP50: pct(total, 50),
      totalP95: pct(total, 95),
      searchesAvg: +(rs.reduce((a, r) => a + r.result.searches, 0) / rs.length).toFixed(1),
    };
  });
  const result = {
    mode: live ? "live" : "offline",
    at: new Date().toISOString(),
    models: live ? { answer: cfg.answerModel, fast: cfg.fastModel, search: cfg.searchProvider, searchModel: cfg.searchModel } : "fake",
    checks: { passed, failed },
    spendUsd: +meter.costUsd.toFixed(4),
    spend: meter.summary(),
    latency,
    steps: reports.map((r) => ({
      scenario: r.scenario,
      step: r.step,
      say: r.say,
      intent: r.result.intent ?? "nudge",
      firstTokenMs: r.result.firstTokenMs,
      totalMs: r.result.totalMs,
      searches: r.result.searches,
      failedChecks: r.checks.filter((c) => !c.pass).map((c) => c.name),
      warnings: r.result.warnings,
    })),
  };
  const dir = new URL("./results/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const base = new URL(`${result.mode}-${result.at.replace(/[:.]/g, "-")}`, dir).pathname;
  writeFileSync(`${base}.json`, JSON.stringify(result, null, 2) + "\n");
  const ms = (x: number | null) => (x === null ? "-" : `${(x / 1000).toFixed(1)} s`);
  const md = [
    `# Eval results (${result.mode}, ${result.at})`,
    "",
    `Checks: ${passed} passed, ${failed} failed. Spend: $${result.spendUsd.toFixed(2)} (${result.spend}).`,
    "",
    "| Question type | Turns | First token p50 | p95 | Total p50 | p95 | Searches/turn |",
    "|---|---|---|---|---|---|---|",
    ...latency.map((l) => `| ${l.intent} | ${l.turns} | ${ms(l.firstTokenP50)} | ${ms(l.firstTokenP95)} | ${ms(l.totalP50)} | ${ms(l.totalP95)} | ${l.searchesAvg} |`),
    "",
  ].join("\n");
  writeFileSync(`${base}.md`, md);
  return base;
}
