// A small HTTP server (node:http, no framework): static UI + a JSON API + one streaming endpoint.
// The chat stream is Server-Sent-Events framing over a POST response, read with fetch() in the page.

import { readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent } from "./index.ts";
import { formatLocal } from "./time.ts";

const { agent, clock, config, llm, search } = createAgent();
const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const MAX_BODY = 64 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Message too large.");
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    throw new HttpError(400, "Body must be JSON.");
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const tz = config.timezone;
const label = (ms: number) => formatLocal(ms, tz, clock?.now() ?? Date.now());

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "POST") {
    // Cross-site protection: a page on another site must not be able to spend your API budget or move the
    // clock. Browsers cannot send application/json cross-origin without a preflight we never answer, and
    // we also reject any foreign Origin outright.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, "Cross-origin requests are not allowed.");
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "Send JSON (content-type: application/json).");
  }

  if (req.method === "GET" && path === "/api/health") {
    const now = (clock ?? { now: () => Date.now() }).now();
    return json(res, 200, {
      ok: true,
      fake: config.fakeMode,
      fakeReason: config.fakeReason,
      model: llm.name,
      search: search.name,
      timezone: tz,
      now,
      nowLabel: agent.nowLabel(),
      clockSettable: !!clock && config.allowClockOverride,
      watch: config.watchEnabled,
    });
  }

  if (req.method === "POST" && path === "/api/clock") {
    if (!clock || !config.allowClockOverride) throw new HttpError(403, "The demo clock is off (set ALLOW_CLOCK_OVERRIDE=1).");
    const body = await readJson(req);
    if (body.reset) clock.reset();
    else if (typeof body.now === "string") {
      try {
        clock.set(body.now);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    } else throw new HttpError(400, "Send {now: ISO date} or {reset: true}.");
    return json(res, 200, { now: clock.now(), nowLabel: agent.nowLabel() });
  }

  if (req.method === "GET" && path === "/api/sessions") {
    return json(res, 200, {
      sessions: agent.store.listSessions().map((s) => ({ id: s.id, title: s.title, updatedAt: s.updated_at, updatedLabel: label(s.updated_at) })),
    });
  }

  if (req.method === "POST" && path === "/api/sessions") {
    const s = agent.newSession();
    return json(res, 200, { id: s.id });
  }

  const nudgeMatch = path.match(/^\/api\/sessions\/([\w-]{1,64})\/nudge$/);
  if (req.method === "POST" && nudgeMatch) {
    // Bounded: a slow web never delays the chat; the nudge just doesn't appear.
    const r = await Promise.race([
      agent.nudge(nudgeMatch[1]!).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 12000)),
    ]);
    return json(res, 200, r ? { messageId: r.messageId, text: r.nudge.text, sources: r.nudge.sources.map((s) => ({ n: s.n, title: s.title, url: s.url, domain: s.domain, date: s.publishedDate, official: s.official })) } : { nudge: null });
  }

  const msgMatch = path.match(/^\/api\/sessions\/([\w-]{1,64})\/messages$/);
  if (req.method === "GET" && msgMatch) {
    const rows = agent.store.sessionMessages(msgMatch[1]!);
    return json(res, 200, {
      messages: rows.map((m) => {
        const meta = JSON.parse(m.meta) as Record<string, unknown>;
        return { id: m.id, role: m.role, content: m.content, at: m.created_at, atLabel: label(m.created_at), sources: meta.sources ?? [], warnings: meta.warnings ?? [], intent: meta.intent, timings: meta.timings };
      }),
    });
  }

  if (req.method === "POST" && path === "/api/chat") {
    const body = await readJson(req);
    const text = typeof body.text === "string" ? body.text : "";
    const sessionId = typeof body.sessionId === "string" && /^[\w-]{1,64}$/.test(body.sessionId) ? body.sessionId : agent.newSession().id;
    if (!text.trim()) throw new HttpError(400, "Say something first.");
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort(); // the user closed the tab or pressed stop
    });
    // Never break out early: on abort the agent stops the model quickly and still saves the partial answer.
    for await (const ev of agent.chat(sessionId, text, abort.signal)) {
      if (!res.destroyed) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
    res.end();
    return;
  }

  if (req.method === "GET" && !path.startsWith("/api/")) {
    const file = normalize(join(PUBLIC, path === "/" ? "index.html" : path));
    if (!file.startsWith(PUBLIC)) throw new HttpError(404, "Not found");
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(data);
      return;
    } catch {
      throw new HttpError(404, "Not found");
    }
  }
  throw new HttpError(404, "Not found");
}

const server = createServer((req, res) => {
  handle(req, res).catch((e: unknown) => {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) json(res, status, { error: e instanceof HttpError ? e.message : "Something went wrong on the server." });
    else res.end();
  });
});

server.listen(config.port, config.host, () => {
  console.log(`minimi-agent running at http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`);
  console.log(`  model: ${llm.name}`);
  console.log(`  search: ${search.name}   timezone: ${tz}   now: ${agent.nowLabel()}`);
  if (config.fakeMode) console.log(`  FAKE MODE (${config.fakeReason}): offline fixtures, demo clock enabled. Add keys to .env for real answers.`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    agent.idle().finally(() => {
      agent.store.close();
      process.exit(0);
    });
  });
}
