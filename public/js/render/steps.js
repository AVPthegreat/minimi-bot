// The agent's work, live: one row per web search (site logo, query, spinner -> check + result count).
// When the answer starts, the list folds into a pill ("Searched 4 sites") that opens it again.
import { h } from "../dom.js";
import { ICONS } from "../icons.js";
import { logo } from "./logo.js";

const STATE_ICON = { running: "", done: ICONS.check, failed: ICONS.x };
const short = (q) => (q.length > 90 ? `${q.slice(0, 88)}…` : q);

export function createSteps() {
  const rows = new Map(); // query -> { li, ev }
  const list = h("ol", { class: "steps-list", "aria-label": "Web searches" });
  const pillLogos = h("span", { class: "logo-stack", "aria-hidden": "true" });
  const pillText = h("span", {});
  const pill = h("button", { class: "steps-pill", type: "button", "aria-expanded": "true", onclick: () => setOpen(pill.getAttribute("aria-expanded") !== "true") },
    pillLogos, pillText, h("span", { class: "chev", html: ICONS.chevron }));
  const el = h("div", { class: "steps", hidden: true }, pill, list);

  function setOpen(open) {
    pill.setAttribute("aria-expanded", String(open));
    el.classList.toggle("open", open);
  }

  function summary() {
    const all = [...rows.values()].map((r) => r.ev);
    const running = all.filter((e) => e.state === "running").length;
    const results = all.reduce((n, e) => n + (e.results ?? 0), 0);
    const failed = all.filter((e) => e.state === "failed").length;
    pillText.textContent = running
      ? `Searching ${all.length} quer${all.length === 1 ? "y" : "ies"} in parallel`
      : `Searched ${all.length} quer${all.length === 1 ? "y" : "ies"} · ${results} result${results === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""}`;
    el.classList.toggle("is-running", running > 0);
    const domains = [...new Set(all.map((e) => e.domain).filter(Boolean))].slice(0, 4);
    pillLogos.replaceChildren(...(domains.length ? domains.map((d) => logo(d)) : [h("span", { class: "logo logo-icon", html: ICONS.search })]));
  }

  function paintRow(row) {
    const { ev } = row;
    row.li.className = `step step-${ev.state}`;
    row.logo.replaceWith((row.logo = ev.domain ? logo(ev.domain, ev.query) : h("span", { class: "logo logo-icon", html: ICONS.search })));
    row.state.innerHTML = ev.state === "running" ? '<span class="spinner" aria-hidden="true"></span>' : STATE_ICON[ev.state] ?? "";
    row.count.textContent = ev.state === "done" ? (ev.results === undefined ? "done" : `${ev.results} result${ev.results === 1 ? "" : "s"}`) :ev.state === "failed" ? "failed" : "searching…";
    row.li.setAttribute("aria-label", `${ev.query}: ${row.count.textContent}`);
  }

  return {
    el,
    /** Apply one `search` event from the stream. */
    update(ev) {
      if (!ev?.query) return;
      if (ev.state === "cancelled") {
        rows.get(ev.query)?.li.remove();
        rows.delete(ev.query);
      } else {
        let row = rows.get(ev.query);
        if (!row) {
          row = { li: null, logo: h("span"), state: h("span", { class: "step-state" }), count: h("span", { class: "step-count" }), ev };
          row.li = h("li", {}, row.logo, h("span", { class: "step-query", title: ev.query }, short(ev.query)), row.count, row.state);
          rows.set(ev.query, row);
          list.append(row.li);
        }
        row.ev = { ...row.ev, ...ev, domain: ev.domain ?? row.ev.domain };
        paintRow(row);
      }
      el.hidden = rows.size === 0;
      if (rows.size) summary();
    },
    /** The answer started (or the turn ended): fold the list; any search still open is closed as done. */
    fold() {
      for (const row of rows.values()) {
        if (row.ev.state === "running") {
          row.ev = { ...row.ev, state: "done" };
          paintRow(row);
        }
      }
      if (rows.size) summary();
      setOpen(false);
    },
    get count() {
      return rows.size;
    },
  };
}
