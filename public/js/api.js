// Everything that talks to the server: JSON calls and the chat stream (SSE framing over a POST body).
// Errors come back as one typed ApiError, so views can show the right message and a retry button.

export class ApiError extends Error {
  /**
   * kind: "network" (server unreachable), "http" (server answered with an error), "cut" (the stream
   * ended before "done"), "agent" (the agent reported an error, e.g. the spend cap).
   */
  constructor(kind, message, status = 0, code = "") {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    /** The hosted demo's reason, e.g. "demo_budget", "daily_limit", "rate_limited" (empty otherwise). */
    this.code = code;
  }
  /** Retrying could help (not for a spend cap or a rejected message). */
  get retryable() {
    if (["demo_budget", "daily_limit", "too_long", "demo_full", "access_required"].includes(this.code)) return false;
    if (this.kind === "agent") return !/spend cap/i.test(this.message);
    return this.kind !== "http" || this.status >= 500 || this.status === 429;
  }
}

async function request(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers ?? {}) } });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new ApiError("network", "Can't reach the minimi server. Is it still running?");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError("http", data.error || `The server answered ${res.status}.`, res.status, data.code || "");
  }
  return res;
}

const json = async (path, opts) => (await request(path, opts)).json();
const post = (path, body = {}, signal) => json(path, { method: "POST", body: JSON.stringify(body), signal });

export const api = {
  health: () => json("/api/health"),
  sessions: () => json("/api/sessions").then((d) => d.sessions ?? []),
  newSession: () => post("/api/sessions").then((d) => d.id),
  messages: (id) => json(`/api/sessions/${encodeURIComponent(id)}/messages`).then((d) => d.messages ?? []),
  nudge: (id, signal) => post(`/api/sessions/${encodeURIComponent(id)}/nudge`, {}, signal),
  setClock: (iso) => post("/api/clock", { now: iso }),
  resetClock: () => post("/api/clock", { reset: true }),
  logoUrl: (domain) => `/api/logo?domain=${encodeURIComponent(domain)}`,
  chat: streamChat,
};

/**
 * Splits an SSE byte stream into events. Feed it text chunks as they arrive; it returns the complete
 * events and keeps any partial one for the next chunk. Malformed frames are skipped, not thrown.
 */
export function createSSEParser() {
  let buf = "";
  return (chunk) => {
    buf += chunk.replace(/\r\n/g, "\n");
    const events = [];
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        const ev = JSON.parse(data);
        if (ev && typeof ev.type === "string") events.push(ev);
      } catch {
        /* a broken frame is dropped; the stream goes on */
      }
    }
    return events;
  };
}

/** POST /api/chat and yield its events. Throws ApiError("cut") if the stream ends without "done". */
export async function* streamChat({ sessionId, text }, signal) {
  const res = await request("/api/chat", { method: "POST", body: JSON.stringify({ sessionId, text }), signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parse = createSSEParser();
  let finished = false;
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (e?.name === "AbortError" || signal?.aborted) throw new DOMException("Stopped", "AbortError");
        throw new ApiError("cut", "The connection dropped before the answer finished.");
      }
      if (chunk.done) break;
      for (const ev of parse(decoder.decode(chunk.value, { stream: true }))) {
        if (ev.type === "done" || (ev.type === "error" && ev.final)) finished = true; // final: the demo refused the turn
        yield ev;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  if (!finished && !signal?.aborted) throw new ApiError("cut", "The connection dropped before the answer finished.");
}
