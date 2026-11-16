// The conversation controller: opens chats, sends a message and turns the stream's events into view
// calls. It owns the turn's lifecycle (busy, stop, retry, errors); views only draw.
import { ApiError, api } from "./api.js";
import { h } from "./dom.js";
import { store } from "./state.js";
import { renderFollowups } from "./render/followups.js";
import { renderHome } from "./render/home.js";
import { assistantMessage, userMessage } from "./render/message.js";

const SPEND_HINT = " Raise MAX_SPEND_USD in .env and restart the server to continue.";

export function createConversation({ log, composer }) {
  let controller = null;
  let stuck = true; // follow new content while the reader is at the bottom

  log.addEventListener("scroll", () => {
    stuck = log.scrollHeight - log.scrollTop - log.clientHeight < 140;
  }, { passive: true });
  new MutationObserver(() => {
    if (stuck) log.scrollTop = log.scrollHeight;
  }).observe(log, { childList: true, subtree: true, characterData: true });

  const watchOn = () => store.get().health?.watch ?? false;
  const clearFollowups = () => log.querySelectorAll(".followups").forEach((n) => n.remove());

  const refreshSessions = () =>
    api.sessions().then((sessions) => store.set({ sessions })).catch(() => {});

  function showHome() {
    const { health } = store.get();
    log.querySelector(".home")?.remove();
    stuck = false; // the home reads from the top
    log.append(renderHome({ nowMs: health?.now, timeZone: health?.timezone }, { send, fill: composer.fill }));
    log.scrollTop = 0;
  }

  function setSession(id) {
    store.set({ sessionId: id });
    history.replaceState(null, "", id ? `#${id}` : location.pathname);
  }

  /** The nudge request in flight; leaving the chat cancels it (the server then writes nothing). */
  let nudgeAbort = null;

  /** The "right moment" check for a new chat: silent unless something you asked about changed. */
  async function checkNudge(id) {
    const chip = h("p", { class: "watch-check", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), "Checking the facts I'm watching…");
    log.querySelector(".home")?.append(chip);
    const ac = new AbortController();
    nudgeAbort = ac;
    try {
      const n = await api.nudge(id, ac.signal);
      // The server returns a nudge only if it stored it as this chat's first message, so show it first even
      // if the user has started typing meanwhile: the change it reports is now recorded as seen.
      if (n?.text && store.get().sessionId === id) {
        const card = assistantMessage({ content: n.text, sources: n.sources, intent: "nudge" }, { watch: false });
        card.setFollowups(renderFollowups("nudge", send));
        log.querySelector(".home")?.classList.add("home-compact");
        log.prepend(card.el);
        if (log.querySelectorAll(".msg").length === 1) log.scrollTop = 0; // don't yank a reader away from an answer
      }
    } catch {
      /* a nudge is optional: no error for the user */
    } finally {
      chip.remove();
      if (nudgeAbort === ac) nudgeAbort = null;
    }
  }

  function cancelNudge() {
    nudgeAbort?.abort();
    nudgeAbort = null;
  }

  async function newChat() {
    if (store.get().busy) stop();
    cancelNudge();
    log.replaceChildren();
    setSession(null);
    showHome();
    // Focus the box on desktop; on a phone that would pop the keyboard over the home screen.
    if (matchMedia("(pointer: fine)").matches) composer.focus();
    try {
      const id = await api.newSession();
      setSession(id);
      checkNudge(id);
    } catch (e) {
      store.set({ serverError: e.message });
    }
  }

  async function openSession(id) {
    if (store.get().busy) stop();
    cancelNudge();
    setSession(id);
    log.replaceChildren(h("div", { class: "loading", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), "Loading the conversation…"));
    try {
      const messages = await api.messages(id);
      if (store.get().sessionId !== id) return;
      log.replaceChildren();
      if (!messages.length) return showHome();
      let last = null;
      for (const m of messages) {
        if (m.role === "user") log.append(userMessage(m).el);
        else {
          last = assistantMessage(m, { watch: watchOn() });
          last.done({ timings: m.timings });
          log.append(last.el);
        }
      }
      last?.setFollowups(renderFollowups(last.intent, send));
      stuck = true;
      log.scrollTop = log.scrollHeight;
    } catch (e) {
      log.replaceChildren(
        h("div", { class: "alert alert-error", role: "alert", icon: "warn" },
          h("span", {}, `Couldn't open this conversation. ${e.message}`),
          h("button", { class: "btn btn-small", type: "button", icon: "retry", onclick: () => openSession(id) }, "Retry")),
      );
    }
  }

  async function send(text) {
    if (store.get().busy || !text.trim()) return;
    store.set({ busy: true });
    log.setAttribute("aria-busy", "true");
    log.querySelector(".home")?.remove();
    clearFollowups();
    stuck = true;

    const user = userMessage({ content: text });
    const bot = assistantMessage({}, { watch: watchOn() });
    log.append(user.el, bot.el);
    bot.status("Thinking…");
    controller = new AbortController();
    let ok = false;
    let agentFailed = false;
    try {
      let sessionId = store.get().sessionId;
      if (!sessionId) {
        sessionId = await api.newSession();
        setSession(sessionId);
      }
      for await (const ev of api.chat({ sessionId, text }, controller.signal)) {
        switch (ev.type) {
          case "turn": user.setTime(ev.atLabel); break;
          case "status": if (!/searches done\)$/.test(ev.text)) bot.status(ev.text); break;
          case "route": bot.setIntent(ev.intent); break;
          case "search": bot.step(ev); break;
          case "sources": bot.setSources(ev.sources); break;
          case "delta": bot.append(ev.text); break;
          case "warning": bot.warn(ev.text); break;
          case "error": {
            agentFailed = true;
            const err = new ApiError("agent", ev.message, 0, ev.code || "");
            if (ev.code) { bot.fail(ev.message, null); break; } // a hosted-demo limit: say it plainly, no retry
            bot.fail(`The answer stopped early: ${ev.message}${/spend cap/i.test(ev.message) ? SPEND_HINT : ""}`, err.retryable ? () => send(text) : null);
            break;
          }
          case "done": bot.done(ev); ok = true; break;
          default: break; // newer server events are ignored by older pages, and vice versa
        }
      }
      store.set({ serverError: null });
    } catch (e) {
      if (e?.name === "AbortError") bot.stopped();
      else if (e instanceof ApiError) {
        bot.fail(e.kind === "cut" ? `${e.message} What arrived is kept.` : e.message, e.retryable ? () => send(text) : null);
        if (e.kind === "network") store.set({ serverError: e.message });
      } else {
        console.warn(e);
        bot.fail("Something went wrong while showing the answer.", () => send(text));
      }
      bot.done();
    } finally {
      controller = null;
      store.set({ busy: false });
      log.setAttribute("aria-busy", "false");
      if (ok && !agentFailed) bot.setFollowups(renderFollowups(bot.intent, send));
      refreshSessions();
    }
  }

  function stop() {
    controller?.abort();
  }

  return { newChat, openSession, send, stop, refreshSessions };
}
