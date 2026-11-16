// Wiring: finds the page's elements, connects views to the store, and starts the app.
// Data flow: api.js -> chat.js (controller) -> store (state.js) -> render/* (views).
import { api } from "./api.js";
import { createConversation } from "./chat.js";
import { $ } from "./dom.js";
import { ICONS, hydrateIcons } from "./icons.js";
import { renderBanner } from "./render/banner.js";
import { renderDemoNotice } from "./render/demo.js";
import { initComposer } from "./render/composer.js";
import { renderEnv, renderSessions } from "./render/sidebar.js";
import { store } from "./state.js";
import { initTheme } from "./theme.js";
import { localInputValue, nowChip, zonedToUtc } from "./time.js";

const el = {
  sidebar: $("#sidebar"), scrim: $("#scrim"), main: $("#main"), sessions: $("#sessions"), env: $("#env"),
  now: $("#now"), banner: $("#banner"), log: $("#log"), clock: $("#clock"), clockForm: $("#clock-form"), clockInput: $("#clock-input"),
};

hydrateIcons();
$("#open-sidebar").innerHTML = ICONS.menu;
$("#close-sidebar").innerHTML = ICONS.close;
$("#new-chat-top").innerHTML = ICONS.plus;
$("#new-chat-kbd").textContent = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K";
initTheme($("#theme"));

const composer = initComposer(
  { form: $("#composer"), input: $("#input"), button: $("#send"), count: $("#count") },
  { onSend: (t) => chat.send(t), onStop: () => chat.stop() },
);
const chat = createConversation({ log: el.log, composer });

// ---- Views follow the store.
store.subscribe((s, changed) => {
  if (changed.some((k) => ["sessions", "sessionId", "health"].includes(k))) renderSessions(el.sessions, s, openFromSidebar);
  if (changed.some((k) => ["health", "serverError"].includes(k))) {
    renderEnv(el.env, s.health, s.serverError);
    el.now.textContent = s.health ? nowChip(s.health.now, s.health.timezone) : "";
    el.now.hidden = !s.health;
    el.clock.hidden = !s.health?.clockSettable;
    if (s.health && document.activeElement !== el.clockInput) el.clockInput.value = localInputValue(s.health.now, s.health.timezone);
  }
  if (changed.some((k) => ["serverError", "online"].includes(k))) renderBanner(el.banner, s, boot);
  if (changed.includes("health")) renderDemoNotice(el.banner, s.health, $("#input"));
  if (changed.includes("busy") && !s.busy && s.health?.demo) loadHealth().catch(() => {}); // fresh "messages left"
  if (changed.includes("busy")) composer.setBusy(s.busy);
  if (changed.includes("sidebarOpen")) paintDrawer(s.sidebarOpen);
});

// ---- Phone drawer.
function paintDrawer(open) {
  document.body.classList.toggle("drawer-open", open);
  el.scrim.hidden = !open;
  $("#open-sidebar").setAttribute("aria-expanded", String(open));
  el.main.inert = open && matchMedia("(max-width: 860px)").matches;
  if (open) $("#new-chat").focus();
}
const closeDrawer = () => store.set({ sidebarOpen: false });
function openFromSidebar(id) {
  closeDrawer();
  chat.openSession(id);
}
$("#open-sidebar").addEventListener("click", () => store.set({ sidebarOpen: true }));
$("#close-sidebar").addEventListener("click", closeDrawer);
el.scrim.addEventListener("click", closeDrawer);

// ---- Actions.
const newChat = () => {
  closeDrawer();
  chat.newChat();
};
$("#new-chat").addEventListener("click", newChat);
$("#new-chat-top").addEventListener("click", newChat);
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    newChat();
  } else if (e.key === "Escape" && store.get().sidebarOpen) closeDrawer();
});
window.addEventListener("online", () => store.set({ online: true }));
window.addEventListener("offline", () => store.set({ online: false }));

// ---- Demo clock (fake mode): move "now" to show memory across days.
el.clockForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const tz = store.get().health?.timezone;
  const ms = zonedToUtc(el.clockInput.value, tz);
  if (!Number.isFinite(ms)) return;
  try {
    await api.setClock(new Date(ms).toISOString());
    await loadHealth();
    chat.newChat();
  } catch (err) {
    store.set({ serverError: err.message });
  }
});
$("#clock-reset").addEventListener("click", async () => {
  try {
    await api.resetClock();
    await loadHealth();
  } catch (err) {
    store.set({ serverError: err.message });
  }
});

async function loadHealth() {
  const health = await api.health();
  store.set({ health, serverError: null });
  return health;
}

async function boot() {
  try {
    await loadHealth();
  } catch (e) {
    store.set({ serverError: e.message });
    return;
  }
  chat.refreshSessions();
  const id = location.hash.slice(1);
  if (/^[\w-]{1,64}$/.test(id)) chat.openSession(id);
  else chat.newChat();
}

// Keep "now" and the status chip fresh (and notice when the server comes back).
setInterval(() => {
  if (store.get().busy) return;
  const wasDown = !!store.get().serverError;
  loadHealth()
    .then(() => wasDown && !store.get().sessionId && boot())
    .catch((e) => store.set({ serverError: e.message }));
}, 60_000);

renderBanner(el.banner, store.get(), boot);
renderEnv(el.env, null, null);
boot();
