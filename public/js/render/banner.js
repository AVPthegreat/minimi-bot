// Page-level problems (server down, browser offline) shown above the chat, with a way out.
import { h } from "../dom.js";

export function renderBanner(slot, { serverError, online }, retry) {
  if (!online) {
    slot.replaceChildren(h("div", { class: "banner glass", role: "alert", icon: "offline" }, h("span", {}, "You're offline. Messages will send again once the connection is back.")));
    return;
  }
  if (serverError) {
    slot.replaceChildren(
      h("div", { class: "banner glass", role: "alert", icon: "warn" },
        h("span", {}, serverError, " Start it with ", h("code", {}, "npm run dev"), "."),
        h("button", { class: "btn btn-small", type: "button", icon: "retry", onclick: retry }, "Try again")),
    );
    return;
  }
  slot.replaceChildren();
}
