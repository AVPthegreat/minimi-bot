// `npm run report`: builds public/report/data.json, the data behind the in-app Report page (/report) and the
// README's score table. Every number comes from a file or a command, never typed in by hand:
//   eval/live-reports/runN-*.json    the result file each live run wrote (checks, spend, latency, steps)
//   eval/live-reports/runN-console.log  the same run's console output (per-scenario check counts, descriptions)
//   eval/live-reports/CHANGELOG.json    hand-written: what each run taught us and the commits that fixed it
//   npm run eval / npm test             run here (offline, no keys) for the offline and unit-test counts
// `npm run report -- --no-run` skips the offline runs and keeps the counts already in data.json.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIVE = join(ROOT, "eval/live-reports");
const OUT = join(ROOT, "public/report/data.json");

interface LiveFile {
  mode: string;
  at: string;
  models: Record<string, string>;
  checks: { passed: number; failed: number };
  unverifiedPrices?: { count: number; answers: number };
  spendUsd: number;
  spend: string;
  latency: { intent: string; turns: number; firstStatusP50: number | null; firstTokenP50: number | null; firstModelTokenP50: number | null; totalP50: number | null; searchesAvg: number }[];
  steps: { scenario: string; step: number; say: string; intent?: string; firstStatusMs?: number | null; firstTokenMs?: number | null; totalMs?: number | null; searches: number; failedChecks: string[] }[];
}

interface ScenarioLog {
  name: string;
  about: string;
  steps: number;
  passed: number;
  failed: number;
  skipped: number;
}

/** Splits a console log into scenarios and counts its check lines (ok / FAIL / skipped). */
function parseConsole(text: string): ScenarioLog[] {
  const out: ScenarioLog[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i]!.match(/^## (\S+)\s*$/);
    if (head) {
      out.push({ name: head[1]!, about: (lines[i + 1] ?? "").trim(), steps: 0, passed: 0, failed: 0, skipped: 0 });
      continue;
    }
    const cur = out.at(-1);
    if (!cur) continue;
    const l = lines[i]!;
    if (/^ {2}\d+\. "/.test(l)) cur.steps++;
    else if (l.startsWith("     ok ")) cur.passed++;
    else if (l.startsWith("     FAIL ")) cur.failed++;
    else if (l.startsWith("     -  ")) cur.skipped++;
  }
  return out;
}

const median = (xs: number[]): number | null => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : Math.round((v[m - 1]! + v[m]!) / 2);
};

function commitExists(sha: string): boolean {
  try {
    execFileSync("git", ["-C", ROOT, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ---- Live runs
const files = readdirSync(LIVE);
const runNums = [...new Set(files.map((f) => f.match(/^run(\d+)-/)?.[1]).filter(Boolean).map(Number))].sort((a, b) => a - b);
if (!runNums.length) throw new Error(`No runN-*.json files in ${LIVE}`);
const changelog = JSON.parse(readFileSync(join(LIVE, "CHANGELOG.json"), "utf8")) as {
  runs: { run: number; title: string; learned: string; fixes: { commit: string; what: string }[] }[];
};

const runs = runNums.map((n) => {
  const jsonFile = files.find((f) => f.startsWith(`run${n}-`) && f.endsWith(".json"));
  const logFile = files.find((f) => f === `run${n}-console.log`);
  if (!jsonFile || !logFile) throw new Error(`run ${n}: needs both run${n}-*.json and run${n}-console.log`);
  const data = JSON.parse(readFileSync(join(LIVE, jsonFile), "utf8")) as LiveFile;
  const scenarios = parseConsole(readFileSync(join(LIVE, logFile), "utf8"));
  // The two sources must agree, or the report would be quoting numbers nobody measured.
  const okSum = scenarios.reduce((s, x) => s + x.passed, 0);
  const failSum = scenarios.reduce((s, x) => s + x.failed, 0);
  if (okSum !== data.checks.passed || failSum !== data.checks.failed) {
    throw new Error(`run ${n}: console log counts ${okSum}/${failSum} but the result file says ${data.checks.passed}/${data.checks.failed}`);
  }
  const usage = data.spend.match(/over (\d+) calls, (\d+) web searches/);
  const notes = changelog.runs.find((r) => r.run === n);
  for (const f of notes?.fixes ?? []) if (!commitExists(f.commit)) console.warn(`warning: CHANGELOG.json run ${n} names commit ${f.commit}, which is not in this repository`);
  return {
    run: n,
    at: data.at,
    mode: data.mode,
    models: data.models,
    passed: data.checks.passed,
    failed: data.checks.failed,
    total: data.checks.passed + data.checks.failed,
    skippedLive: scenarios.reduce((s, x) => s + x.skipped, 0),
    spendUsd: data.spendUsd,
    calls: usage ? Number(usage[1]) : null,
    webSearches: usage ? Number(usage[2]) : null,
    unverifiedPrices: data.unverifiedPrices ?? null,
    scenarios,
    failures: data.steps.filter((s) => s.failedChecks.length).flatMap((s) => s.failedChecks.map((check) => ({ scenario: s.scenario, step: s.step, say: s.say, check }))),
    title: notes?.title ?? null,
    learned: notes?.learned ?? null,
    fixes: notes?.fixes ?? [],
    _steps: data.steps,
    _latency: data.latency,
  };
});

const first = runs[0]!;
const latest = runs.at(-1)!;

// The same suite before and after: the latest run, counted only on the first run's scenarios.
const firstNames = new Set(first.scenarios.map((s) => s.name));
const latestOnFirst = latest.scenarios.filter((s) => firstNames.has(s.name));
const sameSuite = {
  scenarios: firstNames.size,
  before: { run: first.run, passed: first.passed, total: first.total },
  after: {
    run: latest.run,
    passed: latestOnFirst.reduce((s, x) => s + x.passed, 0),
    total: latestOnFirst.reduce((s, x) => s + x.passed + x.failed, 0),
  },
};

const latency = {
  run: latest.run,
  overall: {
    turns: latest._steps.filter((s) => typeof s.totalMs === "number").length,
    firstStatusMs: median(latest._steps.map((s) => s.firstStatusMs ?? NaN)),
    firstTextMs: median(latest._steps.map((s) => s.firstTokenMs ?? NaN)),
    totalMs: median(latest._steps.map((s) => s.totalMs ?? NaN)),
  },
  byIntent: latest._latency.map((l) => ({ intent: l.intent, turns: l.turns, firstStatusMs: l.firstStatusP50, firstTextMs: l.firstTokenP50, firstModelTokenMs: l.firstModelTokenP50, totalMs: l.totalP50, searchesAvg: l.searchesAvg })),
};

// ---- Offline counts (run here, no keys, no network)
const previous = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as { offline?: unknown }).offline : null;
function runOffline() {
  const node = (args: string[]) =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, FAKE_MODE: "1", EVAL_LIVE: "" }, timeout: 300_000 });
  const ev = node(["eval/run.ts"]);
  const evalLine = ev.stdout.match(/(\d+) passed, (\d+) failed \(offline\)/);
  const testFiles = readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".test.ts")).map((f) => join("test", f));
  const ut = node(["--test", ...testFiles]);
  const tests = ut.stdout.match(/^# tests (\d+)/m);
  const pass = ut.stdout.match(/^# pass (\d+)/m);
  if (!evalLine || !tests || !pass) throw new Error("Could not read the offline eval or unit-test summary (run npm run eval and npm test to see why).");
  return {
    eval: { passed: Number(evalLine[1]), failed: Number(evalLine[2]), scenarios: (ev.stdout.match(/^## /gm) ?? []).length },
    unitTests: { total: Number(tests[1]), passed: Number(pass[1]) },
    measuredAt: new Date().toISOString(),
  };
}
const offline = process.argv.includes("--no-run") && previous ? previous : runOffline();

// ---- Write
const data = {
  generatedAt: new Date().toISOString(),
  note: "Built by npm run report from eval/live-reports (live runs with the real models) and an offline run of npm run eval and npm test.",
  totals: {
    liveRuns: runs.length,
    spendUsd: Math.round(runs.reduce((s, r) => s + r.spendUsd, 0) * 10000) / 10000,
    calls: runs.reduce((s, r) => s + (r.calls ?? 0), 0),
    webSearches: runs.reduce((s, r) => s + (r.webSearches ?? 0), 0),
  },
  latest: { run: latest.run, passed: latest.passed, total: latest.total, scenarios: latest.scenarios.length },
  sameSuite,
  offline,
  latency,
  runs: runs.map(({ _steps, _latency, ...r }) => r),
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(data, null, 2) + "\n");
console.log(`Wrote ${OUT.replace(ROOT, "")}`);
for (const r of runs) console.log(`  run ${r.run}: ${r.passed}/${r.total} live checks, $${r.spendUsd.toFixed(2)}, ${r.calls} calls, ${r.webSearches} web searches`);
console.log(`  same ${sameSuite.scenarios} scenarios: ${sameSuite.before.passed}/${sameSuite.before.total} -> ${sameSuite.after.passed}/${sameSuite.after.total}`);
const o = offline as ReturnType<typeof runOffline>;
console.log(`  offline: ${o.eval.passed}/${o.eval.passed + o.eval.failed} eval checks, ${o.unitTests.passed}/${o.unitTests.total} unit tests`);
console.log(`  total live spend $${data.totals.spendUsd.toFixed(2)}`);
