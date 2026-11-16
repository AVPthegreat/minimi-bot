// The Report page: reads /report/data.json (built by `npm run report`) and draws the headline numbers, the
// score timeline (inline SVG with a table alternative), the run-by-run story, the scenario and latency tables.
// Static data only: no third-party requests. Text always goes in as text (dom.js `h`).
import { h } from "./dom.js";
import { initTheme } from "./theme.js";

const REPO = "https://github.com/AVPthegreat/minimi-bot";
const $ = (id) => document.getElementById(id);
const usd = (n) => `$${n.toFixed(2)}`;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const sec = (ms) => (ms === null || ms === undefined ? "–" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const ist = (iso) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)) + " IST";

initTheme($("theme"));

try {
  const res = await fetch("/report/data.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`data.json answered ${res.status}`);
  render(await res.json());
} catch (e) {
  $("window-meta").textContent = "The numbers could not load.";
  const box = $("load-error");
  box.hidden = false;
  box.append(h("p", { class: "error-box", role: "alert" }, `Could not load the report data (${e.message}). Run `, h("code", {}, "npm run report"), " and reload."));
}

function render(d) {
  const latest = d.runs.at(-1);
  $("window-meta").textContent = `${d.totals.liveRuns} live runs · real Claude models and web search · ${ist(latest.at)} latest`;

  const stat = (icon, value, label, note) =>
    h("div", { class: "stat" },
      h("p", { class: "stat-meta", icon }, label.kind),
      h("p", { class: "stat-value" }, ...value),
      h("p", { class: "stat-label" }, label.text),
      h("p", { class: "stat-note" }, note));
  const off = d.offline;
  $("hero-stats").replaceChildren(
    stat("globe", [String(latest.passed), h("small", {}, ` / ${latest.total}`)], { kind: `Live run ${latest.run}`, text: "live checks passed" }, `${latest.scenarios.length} multi-day scenarios`),
    stat("verify", [String(off.eval.passed), h("small", {}, ` / ${off.eval.passed + off.eval.failed}`)], { kind: "Offline eval", text: "eval checks passed" }, "fake clock + fixture web, no keys"),
    stat("check", [String(off.unitTests.passed)], { kind: "npm test", text: `of ${off.unitTests.total} tests pass` }, "unit tests, no network"),
    stat("scale", [usd(d.totals.spendUsd)], { kind: "Total spend", text: "for all live runs" }, `${d.totals.calls} model calls, ${d.totals.webSearches} web searches`),
  );
  const s = d.sameSuite;
  $("same-suite").replaceChildren(
    "On the same ", String(s.scenarios), " scenarios, run ", String(s.before.run), " passed ",
    h("strong", {}, `${s.before.passed}/${s.before.total}`), "; run ", String(s.after.run), " passed ",
    h("strong", {}, `${s.after.passed}/${s.after.total}`), ".",
  );

  drawChart(d.runs);
  runsTable(d.runs);
  runList(d.runs);
  scenarioTable(latest);
  latencyTable(d.latency);
  $("generated").textContent = `Data built ${ist(d.generatedAt)} by npm run report`;
}

// ---- Score timeline: one series (share of live checks passed), a point per run, labelled directly.
function drawChart(runs) {
  const W = 760, H = 280, L = 44, R = 24, T = 36, B = 52;
  const x = (i) => L + (runs.length === 1 ? 0 : (i * (W - L - R)) / (runs.length - 1));
  const y = (p) => T + ((100 - p) / 50) * (H - T - B); // 50% .. 100%
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Live checks passed: ${runs.map((r) => `run ${r.run} ${r.passed} of ${r.total}`).join(", ")}.` });
  for (const p of [50, 75, 100]) {
    svg.append(el("line", { x1: L, x2: W - R, y1: y(p), y2: y(p), class: "grid" }));
    svg.append(el("text", { x: L - 8, y: y(p) + 4, "text-anchor": "end", class: "axis-text" }, `${p}%`));
  }
  const pts = runs.map((r, i) => [x(i), y(pct(r.passed, r.total))]);
  svg.append(el("path", { class: "area", d: `M${pts.map((p) => p.join(" ")).join("L")}L${pts.at(-1)[0]} ${y(50)}L${pts[0][0]} ${y(50)}Z` }));
  svg.append(el("path", { class: "line", d: `M${pts.map((p) => p.join(" ")).join("L")}` }));
  const wrap = $("chart");
  const tip = h("div", { class: "tip", role: "tooltip", hidden: true });
  runs.forEach((r, i) => {
    const [px, py] = pts[i];
    const last = i === runs.length - 1;
    svg.append(el("text", { x: px, y: H - 26, "text-anchor": "middle", class: "run-text" }, `Run ${r.run}`));
    svg.append(el("text", { x: px, y: H - 10, "text-anchor": "middle", class: "axis-text" }, `${r.scenarios.length} scenarios`));
    const hit = el("circle", { cx: px, cy: py, r: 18, class: "hit", tabindex: 0, "aria-label": `Run ${r.run}: ${r.passed} of ${r.total} live checks passed (${pct(r.passed, r.total)}%), ${usd(r.spendUsd)}` });
    svg.append(hit, el("circle", { cx: px, cy: py, r: 6, class: `pt${last ? " last" : ""}` }));
    const anchor = i === 0 ? "start" : last ? "end" : "middle";
    const lx = i === 0 ? px - 4 : last ? px + 4 : px;
    svg.append(el("text", { x: lx, y: py - 14, "text-anchor": anchor, class: "pt-label" }, `${r.passed}/${r.total}`));
    const show = () => {
      tip.replaceChildren(h("strong", {}, `Run ${r.run} · ${pct(r.passed, r.total)}%`), `${r.passed} of ${r.total} live checks, ${r.scenarios.length} scenarios, ${usd(r.spendUsd)} spent, ${r.webSearches} web searches. ${ist(r.at)}.`);
      const box = svg.getBoundingClientRect();
      const scale = box.width / W;
      tip.style.left = `${Math.min(Math.max(px * scale, 110), box.width - 110)}px`;
      tip.style.top = `${py * scale}px`;
      tip.hidden = false;
    };
    const hide = () => (tip.hidden = true);
    hit.addEventListener("mouseenter", show);
    hit.addEventListener("focus", show);
    hit.addEventListener("mouseleave", hide);
    hit.addEventListener("blur", hide);
  });
  wrap.replaceChildren(svg, tip);
}

function table(id, caption, head, rows) {
  const t = $(id);
  t.replaceChildren(
    ...(caption ? [h("caption", {}, caption)] : []),
    h("thead", {}, h("tr", {}, head.map(([label, num]) => h("th", { scope: "col", class: num ? "num" : null }, label)))),
    h("tbody", {}, rows),
  );
}

function runsTable(runs) {
  table("runs-table", "Live runs, 16 Nov 2026", [["Run"], ["Time"], ["Passed", 1], ["Failed", 1], ["Total", 1], ["Pass rate", 1], ["Spend", 1], ["Model calls", 1], ["Web searches", 1]],
    runs.map((r) => h("tr", {},
      h("th", { scope: "row" }, `Run ${r.run}`), h("td", {}, ist(r.at)),
      h("td", { class: "num" }, r.passed), h("td", { class: "num" }, r.failed), h("td", { class: "num" }, r.total),
      h("td", { class: "num" }, `${pct(r.passed, r.total)}%`), h("td", { class: "num" }, usd(r.spendUsd)),
      h("td", { class: "num" }, r.calls ?? "–"), h("td", { class: "num" }, r.webSearches ?? "–"))));
}

function runList(runs) {
  $("run-list").replaceChildren(...runs.map((r) => {
    const failures = r.failures.length
      ? r.failures.map((f) => h("li", {}, h("span", { class: "fail-mark", "aria-hidden": "true" }), `${f.check} `, h("span", { class: "stat-note" }, `(${f.scenario}, step ${f.step})`)))
      : [h("li", { class: "ok" }, "Nothing failed.")];
    const fixes = r.fixes.length
      ? r.fixes.map((f) => h("li", {}, h("a", { class: "sha", href: `${REPO}/commit/${f.commit}`, rel: "noopener noreferrer" }, f.commit), f.what))
      : [h("li", {}, "No changes needed.")];
    return h("li", {},
      h("p", { class: "run-meta" }, h("span", { class: "run-num" }, r.run), h("span", {}, ist(r.at)), h("span", {}, "·"), h("span", {}, `${usd(r.spendUsd)} · ${r.webSearches} web searches`), h("span", { class: "score" }, `${r.passed}/${r.total} passed`)),
      h("p", { class: "run-title" }, r.title ?? `Run ${r.run}`),
      r.learned ? h("p", { class: "run-learned" }, r.learned) : null,
      h("div", { class: "run-cols" },
        h("div", {}, h("h3", {}, `Failed checks (${r.failed})`), h("ul", {}, failures)),
        h("div", {}, h("h3", {}, r.run === runs.at(-1).run ? "Fixed after this run" : "Fixed before the next run"), h("ul", {}, fixes))));
  }));
}

function scenarioTable(run) {
  table("scenario-table", null, [["Scenario"], ["Steps", 1], ["Checks passed", 1], ["Skipped live", 1], ["Result"]],
    run.scenarios.map((s) => {
      const total = s.passed + s.failed;
      return h("tr", {},
        h("th", { scope: "row", class: "scen" }, s.name, h("span", { class: "about" }, s.about)),
        h("td", { class: "num" }, s.steps), h("td", { class: "num" }, `${s.passed}/${total}`), h("td", { class: "num" }, s.skipped),
        h("td", {}, h("span", { class: `chip-pill ${s.failed ? "miss" : "all"}` }, s.failed ? `${s.failed} missed` : "All passed")));
    }));
}

function latencyTable(lat) {
  $("lat-sub").textContent = `Medians from live run ${lat.run}, by question type (turns = how many questions of that type the run asked).`;
  const NAMES = { search: "Web search", verify: "Re-check", recall: "Memory", chat: "Small talk", updates: "Anything new?" };
  table("latency-table", null, [["Question type"], ["Turns", 1], ["First status", 1], ["First text", 1], ["First model token", 1], ["Full answer", 1], ["Searches", 1]],
    lat.byIntent.map((l) => h("tr", {},
      h("th", { scope: "row" }, NAMES[l.intent] ?? l.intent),
      h("td", { class: "num" }, l.turns), h("td", { class: "num" }, sec(l.firstStatusMs)), h("td", { class: "num" }, sec(l.firstTextMs)),
      h("td", { class: "num" }, sec(l.firstModelTokenMs)), h("td", { class: "num" }, sec(l.totalMs)), h("td", { class: "num" }, l.searchesAvg))));
}

