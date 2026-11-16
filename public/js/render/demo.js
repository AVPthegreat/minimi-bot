// The hosted demo's notice (only when the server runs with DEMO_MODE=1 and /api/health has `demo`):
// what is private, what is limited, and what to do when the shared budget is used up.
import { h } from "../dom.js";

export function renderDemoNotice(bannerSlot, health, input) {
  const d = health?.demo;
  let note = document.getElementById("demo-note");
  if (!d) {
    note?.remove();
    return;
  }
  if (input && d.maxMessageChars) input.maxLength = d.maxMessageChars;
  const text = d.budgetUsedUp
    ? ["This hosted demo has used up its budget, so it can't answer new messages. Run minimi yourself in fake mode (no key needed): ", h("code", {}, "npm install && npm run dev"), "."]
    : [`Hosted demo · private to this browser, deleted after ${d.ttlDays} idle days · ${d.messagesLeftToday} of ${d.messagesPerDay} messages left today`];
  const banner = h("div", { class: "banner glass", role: "note", icon: d.budgetUsedUp ? "warn" : "globe" }, h("span", {}, ...text));
  if (!d.budgetUsedUp) banner.style.color = "var(--accent)"; // the icon; the text keeps --text
  const next = h("div", { id: "demo-note", class: "banner-slot" }, banner);
  if (note) note.replaceWith(next);
  else bannerSlot.before(next);
}
