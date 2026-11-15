// Minimal chat client: sessions sidebar, streaming answers, sources, timestamps. No framework.
const $ = (s) => document.querySelector(s);
const log = $("#log");
const input = $("#input");
let sessionId = null;
let busy = false;
let controller = null;

// ---------- markdown (escape first, then a small safe subset: tables, lists, headings, code, bold, links, [n] citations)
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function inline(s, sources) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    // Citations: only outside tags (never inside an href built just above).
    .replace(/\[(\d{1,2})\](?![^<]*>)/g, (m, n) => {
      const src = sources.find((x) => x.n === Number(n));
      return src ? `<a class="cite" href="${esc(src.url)}" target="_blank" rel="noopener noreferrer" title="${esc(src.title)}">[${n}]</a>` : m;
    });
}
function markdown(text, sources = []) {
  const lines = text.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    } else if (line.trim().startsWith("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || "")) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, "|"), sources));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((x) => `<li>${inline(x, sources)}</li>`).join("")}</${tag}>`);
    } else if (/^#{1,4}\s/.test(line)) {
      const level = Math.min(4, line.match(/^#+/)[0].length + 2);
      out.push(`<h${level}>${inline(line.replace(/^#+\s/, ""), sources)}</h${level}>`);
      i++;
    } else if (line.trim() === "") {
      i++;
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() !== "" && !/^\s*([-*]|\d+\.)\s+|^#{1,4}\s|^```|^\s*\|/.test(lines[i])) para.push(lines[i++]);
      if (para.length === 0) para.push(lines[i++]);
      out.push(`<p>${para.map((p) => inline(p, sources)).join("<br>")}</p>`);
    }
  }
  return out.join("");
}

// ---------- rendering
function addMessage({ role, content = "", atLabel = "", sources = [], warnings = [], intent }) {
  $("#empty")?.remove();
  const el = document.createElement("article");
  el.className = `msg ${role}${intent === "nudge" ? " nudge" : ""}`;
  el.innerHTML = `<div class="meta"></div><div class="body"></div><div class="status" hidden></div><ul class="sources"></ul><div class="warnings"></div>`;
  log.append(el);
  const view = {
    el,
    text: content,
    sources,
    setMeta(t) { el.querySelector(".meta").textContent = t; },
    render() {
      const body = el.querySelector(".body");
      if (role === "user") body.textContent = view.text;
      else body.innerHTML = markdown(view.text, view.sources);
    },
    setStatus(t) { const s = el.querySelector(".status"); s.hidden = !t; s.textContent = t || ""; },
    setSources(list) {
      list = list.filter((s) => /^https?:\/\//i.test(s.url)); // never render javascript: or other schemes
      view.sources = list;
      el.querySelector(".sources").innerHTML = list
        .map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.title)}"${s.official ? ' class="official"' : ""}>[${s.n}] ${esc(s.domain)}${s.date ? ` &middot; ${esc(s.date)}` : ""}</a></li>`)
        .join("");
      view.render();
    },
    addWarning(t) {
      const w = document.createElement("div");
      w.className = "warning";
      w.textContent = t;
      el.querySelector(".warnings").append(w);
    },
  };
  view.setMeta(role === "user" ? atLabel : `Minimi${atLabel ? ` · ${atLabel}` : ""}`);
  if (sources.length) view.setSources(sources); else view.render();
  warnings.forEach((w) => view.addWarning(w));
  log.scrollTop = log.scrollHeight;
  return view;
}

function showError(text) {
  const v = addMessage({ role: "assistant" });
  v.addWarning(text);
}

// ---------- API
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function loadHealth() {
  const h = await api("/api/health");
  $("#now").textContent = `Now: ${h.nowLabel}`;
  $("#env").textContent = h.fake ? `Fake mode (${h.fakeReason}): offline test web.` : `${h.model} · search: ${h.search}`;
  $("#clock-form").hidden = !h.clockSettable;
}

async function loadSessions() {
  const { sessions } = await api("/api/sessions");
  const nav = $("#sessions");
  nav.innerHTML = sessions.length ? "" : '<p class="muted small">No conversations yet.</p>';
  for (const s of sessions) {
    const a = document.createElement("a");
    a.href = `#${s.id}`;
    a.innerHTML = `<span class="title"></span><span class="date"></span>`;
    a.querySelector(".title").textContent = s.title || "Untitled";
    a.querySelector(".date").textContent = s.updatedLabel;
    if (s.id === sessionId) a.setAttribute("aria-current", "true");
    a.addEventListener("click", (e) => { e.preventDefault(); openSession(s.id); document.body.classList.remove("show-sidebar"); });
    nav.append(a);
  }
}

async function openSession(id) {
  sessionId = id;
  history.replaceState(null, "", `#${id}`);
  log.innerHTML = "";
  const { messages } = await api(`/api/sessions/${id}/messages`);
  messages.forEach((m) => addMessage(m));
  await loadSessions();
}

async function newChat() {
  if (busy) return;
  log.innerHTML = $("#empty") ? log.innerHTML : "";
  const { id } = await api("/api/sessions", { method: "POST" });
  sessionId = id;
  history.replaceState(null, "", "#");
  log.innerHTML = `<div id="empty" class="empty"><h1>Ask me anything.</h1><p class="muted">I search the web, cite sources with dates, and remember what you asked and when.</p></div>`;
  loadSessions();
  input.focus();
  // The "right moment" check: at most one short note, only if something you asked about changed.
  api(`/api/sessions/${id}/nudge`, { method: "POST" })
    .then((n) => { if (n.text && sessionId === id && !log.querySelector(".msg")) addMessage({ role: "assistant", content: n.text, sources: n.sources, intent: "nudge" }); })
    .catch(() => {});
}

async function send(text) {
  if (busy || !text.trim()) return;
  busy = true;
  $("#send").textContent = "Stop";
  if (!sessionId) sessionId = (await api("/api/sessions", { method: "POST" })).id;
  const user = addMessage({ role: "user", content: text });
  const bot = addMessage({ role: "assistant" });
  bot.setStatus("Thinking");
  controller = new AbortController();
  let frame = 0;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, text }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!chunk.startsWith("data: ")) continue;
        const ev = JSON.parse(chunk.slice(6));
        if (ev.type === "turn") user.setMeta(ev.atLabel);
        else if (ev.type === "status") bot.setStatus(ev.text);
        else if (ev.type === "sources") bot.setSources(ev.sources);
        else if (ev.type === "delta") {
          bot.setStatus("");
          bot.text += ev.text;
          if (!frame) frame = requestAnimationFrame(() => { frame = 0; bot.render(); log.scrollTop = log.scrollHeight; });
        } else if (ev.type === "warning") bot.addWarning(ev.text);
        else if (ev.type === "error") bot.addWarning(`Error: ${ev.message}`);
        else if (ev.type === "done") bot.setMeta(`Minimi · ${ev.atLabel} · first words in ${((ev.timings.firstTokenMs ?? ev.timings.totalMs) / 1000).toFixed(1)} s`);
      }
    }
    bot.render();
  } catch (e) {
    if (e.name !== "AbortError") bot.addWarning(`Couldn't reach the agent: ${e.message}`);
  } finally {
    bot.setStatus("");
    bot.render();
    busy = false;
    controller = null;
    $("#send").textContent = "Send";
    loadSessions();
  }
}

// ---------- wiring
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) { controller?.abort(); return; }
  const text = input.value;
  input.value = "";
  input.style.height = "auto";
  send(text);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); }
});
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = `${Math.min(200, input.scrollHeight)}px`; });
$("#new-chat").addEventListener("click", newChat);
$("#toggle-sidebar").addEventListener("click", () => document.body.classList.toggle("show-sidebar"));
$("#clock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = $("#clock-input").value;
  if (!v) return;
  try {
    // datetime-local has no zone: send it as the user's wall-clock time; the server reads it as local to the browser.
    await api("/api/clock", { method: "POST", body: JSON.stringify({ now: new Date(v).toISOString() }) });
    await loadHealth();
    await loadSessions();
  } catch (err) { showError(err.message); }
});
$("#clock-reset").addEventListener("click", async () => {
  await api("/api/clock", { method: "POST", body: JSON.stringify({ reset: true }) }).catch((err) => showError(err.message));
  await loadHealth();
});

(async () => {
  try {
    await loadHealth();
    const id = location.hash.slice(1);
    if (/^[\w-]{1,64}$/.test(id)) await openSession(id);
    else await newChat();
  } catch (e) {
    showError(`Couldn't load: ${e.message}`);
  }
})();
