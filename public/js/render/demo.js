// The hosted demo's notice (only when the server runs with DEMO_MODE=1 and /api/health has `demo`):
// a small, friendly line (private chats, messages left today; the deletion detail is in its tooltip and the
// report's Security section), or a clear warning with the way out when the shared budget is used up.
import { h } from "../dom.js";

export function renderDemoNotice(bannerSlot, health, input) {
  const d = health?.demo;
  let note = document.getElementById("demo-note");
  if (!d) {
    note?.remove();
    return;
  }
  if (input && d.maxMessageChars) input.maxLength = d.maxMessageChars;
  let next;
  if (d.budgetUsedUp) {
    // Can't answer at all: this one stays a clear warning, with the way out.
    const banner = h("div", { class: "banner", role: "note", icon: "warn" },
      h("span", {}, "This demo has used up its budget, so it can't answer new messages. Run minimi yourself in fake mode (no key needed): ", h("code", {}, "npm install && npm run dev"), "."));
    next = h("div", { id: "demo-note", class: "banner-slot" }, banner);
  } else {
    const left = Math.max(0, d.messagesLeftToday ?? 0);
    const count = left === 0 ? "no messages left today, more tomorrow" : `${left} message${left === 1 ? "" : "s"} left today`;
    const detail = `Private to this browser: only you can see these chats. They are deleted after ${d.ttlDays} idle day${d.ttlDays === 1 ? "" : "s"}. ${left} of ${d.messagesPerDay} messages left today.`;
    next = h("div", { id: "demo-note", class: "demo-note" },
      h("p", { class: "demo-pill", role: "note", title: detail, icon: "verify" },
        h("span", {}, `Your own private minimi · only you can see these chats · ${count}`),
        h("span", { class: "visually-hidden" }, ` Chats are deleted after ${d.ttlDays} idle day${d.ttlDays === 1 ? "" : "s"}.`)));
  }
  if (note) note.replaceWith(next);
  else bannerSlot.before(next);
}
