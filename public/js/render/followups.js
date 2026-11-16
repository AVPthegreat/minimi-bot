// Next steps offered under the latest answer, picked by what kind of answer it was. Each one is a real
// question the agent handles (see src/router.ts rules), not a canned reply.
import { h } from "../dom.js";

const SUGGEST = {
  search: [
    { icon: "verify", label: "Is that still correct?", prompt: "Is that still correct?" },
    { icon: "sparkles", label: "Anything new?", prompt: "Anything new?" },
    { icon: "memory", label: "What did I ask today?", prompt: "What did I ask today?" },
  ],
  verify: [
    { icon: "sparkles", label: "Anything new?", prompt: "Anything new?" },
    { icon: "memory", label: "What did I ask last week?", prompt: "What did I ask last week?" },
  ],
  updates: [{ icon: "verify", label: "Is that still correct?", prompt: "Is that still correct?" }],
  recall: [{ icon: "verify", label: "Is that still correct?", prompt: "Is that still correct?" }],
  nudge: [
    { icon: "verify", label: "Show me what changed", prompt: "Anything new?" },
  ],
};

/** The chips for an answer of this intent (none for small talk). `send(prompt)` runs one. */
export function renderFollowups(intent, send) {
  const items = SUGGEST[intent] ?? [];
  if (!items.length) return null;
  return h("div", { class: "followups", role: "group", "aria-label": "Suggested next questions" },
    items.map((s) => h("button", { class: "chip-btn", type: "button", icon: s.icon, onclick: () => send(s.prompt) }, s.label)),
  );
}
