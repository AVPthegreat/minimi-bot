// The empty-chat home: a greeting, the pitch, four small square tiles that show what this agent is good
// at, and a highlighted link to the report. It fits one screen without scrolling.
// "send" tiles ask at once; "fill" tiles put an editable question in the composer.
import { h } from "../dom.js";
import { CAT } from "../icons.js";
import { greeting } from "../time.js";

const ACTIONS = [
  {
    icon: "scale",
    title: "Compare prices",
    text: "One search per product, in parallel, with dated sources.",
    prompt: "What does Postgres hosting cost on Supabase, Neon and Railway?",
    mode: "send",
    kind: "Web search",
  },
  {
    icon: "verify",
    title: "Is that still correct?",
    text: "Re-checks what I told you before: a then/now table.",
    prompt: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    mode: "fill",
    kind: "Re-check",
  },
  {
    icon: "calendar",
    title: "What did I ask on…",
    text: "\"Last Tuesday\" becomes a date; I quote what you asked.",
    prompt: "What did I ask you yesterday?",
    select: "yesterday",
    mode: "fill",
    kind: "Memory",
  },
  {
    icon: "sparkles",
    title: "Anything new?",
    text: "Re-checks the facts I'm watching and shows what changed.",
    prompt: "Anything new?",
    mode: "send",
    kind: "Watchlist",
  },
];

/** The report's headline numbers, fetched once per page load; null if the file can't be read. */
let reportNumbers;
function loadReportNumbers() {
  reportNumbers ??= fetch("/report/data.json", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const live = d?.latest, unit = d?.offline?.unitTests;
      const parts = [];
      if (Number.isFinite(live?.passed) && Number.isFinite(live?.total)) parts.push(`${live.passed}/${live.total} live${live.finalCode ? " on the final code" : " checks"}`);
      if (Number.isFinite(unit?.total)) parts.push(`${unit.total} tests`);
      return parts.length ? [...parts, "architecture"].join(" · ") : null;
    })
    .catch(() => null);
  return reportNumbers;
}

function reportCard() {
  const detail = h("span", { class: "report-card-detail" }, "Live checks, tests and architecture");
  loadReportNumbers().then((text) => { if (text) detail.textContent = text; });
  return h("a", { class: "report-card", href: "/report" },
    h("span", { class: "report-card-icon", icon: "chart" }),
    h("span", { class: "report-card-body" },
      h("span", { class: "report-card-title" }, "See how it was built and tested"),
      detail),
    h("span", { class: "report-card-go", icon: "chevron" }),
  );
}

/** `actions.send(prompt)` asks now; `actions.fill(prompt, select)` puts it in the composer. */
export function renderHome({ nowMs, timeZone }, actions) {
  const hello = nowMs && timeZone ? greeting(nowMs, timeZone) : "Hello";
  return h("section", { class: "home", "aria-labelledby": "home-title" },
    h("div", { class: "home-mark", "aria-hidden": "true", html: CAT }),
    h("p", { class: "home-hello" }, hello),
    h("h1", { id: "home-title", class: "home-title" }, "Ask once. I ", h("em", {}, "ping"), " you when it changes."),
    h("p", { class: "home-sub" }, "I search the web, cite every price with its source and date, remember what you asked and when, and speak up when something you asked about changes."),
    h("h2", { class: "visually-hidden" }, "Try one"),
    h("div", { class: "tiles" },
      ACTIONS.map((a) =>
        h("button", {
          class: "tile",
          type: "button",
          title: `${a.text} ${a.mode === "send" ? "Asks" : "Puts in the box"}: "${a.prompt}"`,
          onclick: () => (a.mode === "send" ? actions.send(a.prompt) : actions.fill(a.prompt, a.select)),
        },
        h("span", { class: "tile-icon", icon: a.icon }),
        h("span", { class: "tile-title" }, a.title),
        h("span", { class: "tile-hint" }, a.mode === "send" ? "Ask now" : "Edit, then send"),
        ),
      ),
    ),
    reportCard(),
  );
}
