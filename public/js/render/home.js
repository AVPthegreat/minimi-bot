// The empty-chat home: a greeting, the pitch, and four quick actions laid out like minimi's app panel
// (kind · how it runs, the question in bold, what happens in grey) that show what this agent is good at.
// "send" actions ask at once; "fill" actions put an editable question in the composer.
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

/** `actions.send(prompt)` asks now; `actions.fill(prompt, select)` puts it in the composer. */
export function renderHome({ nowMs, timeZone }, actions) {
  const hello = nowMs && timeZone ? greeting(nowMs, timeZone) : "Hello";
  return h("section", { class: "home", "aria-labelledby": "home-title" },
    h("div", { class: "home-mark", "aria-hidden": "true", html: CAT }),
    h("p", { class: "home-hello" }, hello),
    h("h1", { id: "home-title", class: "home-title" }, "Ask once. I ", h("em", {}, "ping"), " you when it changes."),
    h("p", { class: "home-sub" }, "I search the web, cite every price with its source and date, remember what you asked and when, and speak up when something you asked about changes."),
    h("div", { class: "quick-panel" },
      h("p", { class: "quick-head" }, h("span", {}, "Try one"), h("span", {}, "4 things I do well")),
      h("div", { class: "quick-grid" },
        ACTIONS.map((a) =>
          h("button", {
            class: "quick",
            type: "button",
            onclick: () => (a.mode === "send" ? actions.send(a.prompt) : actions.fill(a.prompt, a.select)),
          },
          h("span", { class: "quick-meta" }, h("span", { class: "quick-icon", icon: a.icon }), h("span", {}, a.kind), h("span", { class: "quick-go" }, a.mode === "send" ? "Ask now" : "Edit, then send")),
          h("span", { class: "quick-title" }, a.title),
          h("span", { class: "quick-text" }, a.text),
          h("span", { class: "quick-quote" }, `Asks: "${a.prompt}"`),
          ),
        ),
      ),
    ),
  );
}
