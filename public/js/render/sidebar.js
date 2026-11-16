// The conversation list (grouped Today / Yesterday / This week / Earlier) and the status chip.
// Redraws from the store; clicking a chat calls `open(id)`.
import { h } from "../dom.js";
import { groupSessions, shortWhen } from "../time.js";

export function renderSessions(nav, { sessions, sessionId, health }, open) {
  const now = health?.now ?? Date.now();
  const tz = health?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const visible = sessions.filter((s) => s.title);
  if (!visible.length) {
    nav.replaceChildren(h("p", { class: "sessions-empty" }, "Your chats will show up here, grouped by day."));
    return;
  }
  nav.replaceChildren(
    ...groupSessions(visible, now, tz).map((g) =>
      h("section", { class: "session-group" },
        h("h2", { class: "group-label" }, g.label),
        h("ul", {},
          g.sessions.map((s) =>
            h("li", {},
              h("a", {
                href: `#${s.id}`,
                class: "session",
                "aria-current": s.id === sessionId ? "page" : null,
                onclick: (e) => {
                  e.preventDefault();
                  open(s.id);
                },
              },
              h("span", { class: "session-title" }, s.title),
              h("time", { class: "session-time", title: s.updatedLabel }, shortWhen(s.updatedAt, now, tz))),
            ),
          ),
        ),
      ),
    ),
  );
}

/** "Opus 5.5 · Tavily" when live; "Demo mode · offline web" in fake mode (with the reason as a tooltip). */
export function renderEnv(el, health, serverError) {
  if (serverError) {
    el.className = "env-chip env-down";
    el.replaceChildren(h("span", { class: "dot" }), "Server unreachable");
    el.title = serverError;
    return;
  }
  if (!health) {
    el.replaceChildren(h("span", { class: "dot" }), "Connecting…");
    return;
  }
  if (health.fake) {
    el.className = "env-chip env-demo";
    el.replaceChildren(h("span", { class: "dot" }), "Demo mode · offline test web");
    el.title = `Fake models and a fixture web (${health.fakeReason}). Add an API key to .env for real answers.`;
    return;
  }
  const model = (health.model.match(/claude-([a-z]+)-(\d+)-(\d+)/) ?? []).slice(1);
  const pretty = model.length ? `${model[0][0].toUpperCase()}${model[0].slice(1)} ${model[1]}.${model[2]}` : health.model;
  const search = { tavily: "Tavily", "anthropic-web-search": "Claude web search" }[health.search] ?? health.search;
  el.className = "env-chip env-live";
  el.replaceChildren(h("span", { class: "dot" }), `${pretty} · ${search}`);
  el.title = `${health.model} · search: ${health.search} · timezone: ${health.timezone}`;
}
