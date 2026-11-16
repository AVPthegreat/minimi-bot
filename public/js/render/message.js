// One message on screen. A user message is a bubble; an answer is a glass card that fills in as the
// stream arrives: intent badge, search steps, a live status line, the markdown body, sources, warnings,
// and a footer (timing, "watching", copy). A nudge is the same card in its "right moment" style.
import { copyText, h } from "../dom.js";
import { ICONS } from "../icons.js";
import { markdown } from "../markdown.js";
import { renderSources } from "./sources.js";
import { createSteps } from "./steps.js";

const INTENT = {
  search: { label: "Web search", icon: "globe" },
  verify: { label: "Re-check", icon: "verify" },
  updates: { label: "Watchlist", icon: "sparkles" },
  recall: { label: "Memory", icon: "memory" },
  nudge: { label: "Right moment", icon: "bell" },
};

export function userMessage({ content, atLabel }) {
  const time = h("time", { class: "msg-time" }, atLabel || "");
  const el = h("article", { class: "msg msg-user", "aria-label": "You said" }, h("div", { class: "bubble" }, content), time);
  return { el, setTime: (t) => (time.textContent = t) };
}

/**
 * An answer card. `opts.watch` = the watchlist is on (so a sourced answer can say it is being watched).
 * Returns a small view API the chat controller drives event by event.
 */
export function assistantMessage(msg = {}, opts = {}) {
  let text = msg.content ?? "";
  let sources = msg.sources ?? [];
  let intent = msg.intent;
  let frame = 0;

  const badge = h("span", { class: "intent", hidden: true });
  const time = h("time", { class: "msg-time" }, msg.atLabel ?? "");
  const copyBtn = h("button", { class: "icon-btn icon-btn-small", type: "button", "aria-label": "Copy answer", title: "Copy answer", icon: "copy", hidden: !text });
  const head = h("header", { class: "msg-head" }, h("span", { class: "msg-name" }, "minimi"), badge, time, h("span", { class: "spacer" }), copyBtn);
  const steps = createSteps();
  const status = h("p", { class: "status-line", role: "status", hidden: true });
  const body = h("div", { class: "md" });
  const sourcesEl = h("div", { class: "sources", hidden: true });
  const warnings = h("div", { class: "warnings" });
  const foot = h("footer", { class: "msg-foot", hidden: true });
  const card = h("div", { class: "card glass" }, head, steps.el, status, body, sourcesEl, warnings, foot);
  const el = h("article", { class: "msg msg-assistant", "aria-label": "minimi answered" }, h("span", { class: "orb orb-small", "aria-hidden": "true" }), card);

  copyBtn.addEventListener("click", async () => {
    const ok = await copyText(text.trim());
    copyBtn.innerHTML = ok ? ICONS.check : ICONS.x;
    copyBtn.setAttribute("aria-label", ok ? "Copied" : "Copy failed");
    setTimeout(() => {
      copyBtn.innerHTML = ICONS.copy;
      copyBtn.setAttribute("aria-label", "Copy answer");
    }, 1500);
  });

  const render = () => {
    frame = 0;
    body.innerHTML = markdown(text, sources);
    copyBtn.hidden = !text.trim();
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(render);
  };

  const view = {
    el,
    get text() {
      return text;
    },
    get intent() {
      return intent;
    },
    setIntent(i) {
      intent = i;
      el.classList.toggle("msg-nudge", i === "nudge");
      const info = INTENT[i];
      badge.hidden = !info;
      if (info) badge.replaceChildren(h("span", { html: ICONS[info.icon] }), info.label);
    },
    setTime: (t) => (time.textContent = t),
    status(t) {
      status.hidden = !t;
      status.textContent = t || "";
    },
    step: (ev) => steps.update(ev),
    append(t) {
      if (!text) {
        steps.fold();
        view.status("");
      }
      text += t;
      schedule();
    },
    setSources(list) {
      sources = list ?? [];
      renderSources(sourcesEl, sources);
      schedule();
    },
    warn(t) {
      warnings.append(h("p", { class: "alert alert-warn", icon: "warn" }, h("span", {}, t)));
    },
    /** A failed turn: what happened, in plain words, with Retry when it could help. */
    fail(message, retry) {
      view.status("");
      steps.fold();
      const actions = retry ? h("button", { class: "btn btn-small", type: "button", icon: "retry", onclick: (e) => { e.currentTarget.disabled = true; retry(); } }, "Retry") : null;
      warnings.append(h("div", { class: "alert alert-error", role: "alert", icon: "warn" }, h("span", {}, message), actions));
    },
    stopped() {
      view.status("");
      steps.fold();
      warnings.append(h("p", { class: "alert alert-muted" }, "Stopped. The part written so far is kept."));
    },
    /** The turn is over: final render, timing and the watch note in the footer. */
    done({ atLabel, timings } = {}) {
      steps.fold();
      view.status("");
      if (atLabel) time.textContent = atLabel;
      if (frame) cancelAnimationFrame(frame);
      render();
      const parts = [];
      const first = timings?.firstTokenMs ?? null;
      if (first !== null) parts.push(h("span", {}, `First words in ${first < 1000 ? `${first} ms` : `${(first / 1000).toFixed(1)} s`}`));
      if (opts.watch && sources.length && (intent === "search" || intent === "verify")) {
        parts.push(h("span", { class: "watching", icon: "eye" }, "Watching these facts. A new chat tells you if one changes."));
      }
      foot.replaceChildren(...parts);
      foot.hidden = parts.length === 0;
    },
    /** Follow-up chips live outside the card, under it; only the latest answer keeps them. */
    setFollowups(node) {
      el.querySelector(".followups")?.remove();
      if (node) el.append(node);
    },
  };

  if (msg.intent) view.setIntent(msg.intent);
  if (sources.length) renderSources(sourcesEl, sources);
  for (const w of msg.warnings ?? []) view.warn(w);
  if (text) render();
  return view;
}
