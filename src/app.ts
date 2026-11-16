// The HTTP app (node:http, no framework): static UI + a JSON API + one streaming endpoint.
// The chat stream is Server-Sent-Events framing over a POST response, read with fetch() in the page.
//
// Two modes share the same routes. Single-user (default): one agent, one SQLite file, exactly the app
// that "lives on your Mac". Hosted demo (DEMO_MODE=1, src/demo/): every visitor gets their own agent
// and database behind a signed cookie, with a persisted global budget, per-visitor and per-IP limits
// and security headers. Each route asks `ctx()` for the caller's agent; that is the only fork.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent } from "./agent.ts";
import { type Config, loadConfig } from "./config.ts";
import { BUDGET_USED_UP, LedgerMeter } from "./demo/budget.ts";
import { type DemoConfig, loadDemoConfig } from "./demo/config.ts";
import {
  ACCESS_COOKIE,
  VISITOR_COOKIE,
  accessToken,
  checkAccess,
  codeMatches,
  cookieHeader,
  newVisitorId,
  parseCookies,
  signVisitor,
  verifyVisitor,
} from "./demo/cookie.ts";
import { TokenBuckets } from "./demo/limits.ts";
import { DemoRegistry } from "./demo/registry.ts";
import { type Visitor, VisitorPool } from "./demo/visitors.ts";
import { buildModels, createAgent } from "./index.ts";
import { LogoService, cleanDomain, monogram } from "./logo.ts";
import { BudgetExceededError, UsageMeter } from "./usage.ts";
import { type FakeClock, SystemClock, addDays, civilDateOf, formatLocal, isoDate, startOfDay } from "./time.ts";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".txt": "text/plain; charset=utf-8" };
const MAX_BODY = 64 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** A stable machine-readable reason (demo limits), sent as `code` next to `error`. */
    readonly code?: string,
    /** Seconds; sent as Retry-After. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, maxBody: number): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBody) throw new HttpError(413, "Message too large.");
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    throw new HttpError(400, "Body must be JSON.");
  }
}

/** The caller's agent and clock (one for everybody in single-user mode, one per visitor in the demo). */
interface Ctx {
  agent: Agent;
  clock: FakeClock | null;
  clockSettable: boolean;
  visitor?: Visitor;
}

export interface App {
  handle(req: IncomingMessage, res: ServerResponse): void;
  close(): Promise<void>;
  config: Config;
  demo: DemoConfig | null;
  /** Lines printed at start-up. */
  startupLines(): string[];
  /** Demo internals, for tests and ops tooling. */
  demoState?: { registry: DemoRegistry; pool: VisitorPool; meter: LedgerMeter; load: { streams: number } };
}

export function createApp(config: Config = loadConfig(), demo: DemoConfig | null = loadDemoConfig()): App {
  return demo ? createDemoApp(config, demo) : createSingleUserApp(config);
}

// ---------------------------------------------------------------------------------------------
// Routes shared by both modes.

interface Mode {
  config: Config;
  maxBody: number;
  logos: LogoService;
  /** The caller's context; with create=false a demo visitor who has no data yet gets null. */
  ctx(req: IncomingMessage, create: boolean): Ctx | null;
  health(ctx: Ctx | null): Record<string, unknown>;
  /** Demo only: checks and bookkeeping around a chat stream. */
  chat?: DemoChat;
  /** Demo only: may a nudge (which can spend) run now? */
  nudgeAllowed?(): boolean;
  streamStarted?(v: Visitor | undefined): void;
  streamEnded?(v: Visitor | undefined): void;
  clockChanged?(ctx: Ctx, fixed: number | null): void;
  extra?(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}

interface DemoChat {
  /** Throws an HttpError when this message may not start; returns how to undo the daily count. */
  admit(req: IncomingMessage, text: string): { ctx: Ctx; refund(): void; budgetLeft: boolean };
  timeoutMs: number;
  errorEvent(message: string): Record<string, unknown>;
}

async function route(m: Mode, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const tz = m.config.timezone;

  if (req.method === "POST") {
    // Cross-site protection: a page on another site must not be able to spend your API budget or move the
    // clock. Browsers cannot send application/json cross-origin without a preflight we never answer, and
    // we also reject any foreign Origin outright.
    const origin = req.headers.origin;
    let originHost: string | null = null;
    try {
      originHost = origin ? new URL(origin).host : null;
    } catch {
      originHost = "invalid";
    }
    if (originHost !== null && originHost !== req.headers.host) throw new HttpError(403, "Cross-origin requests are not allowed.");
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "Send JSON (content-type: application/json).");
  }

  if (m.extra && (await m.extra(req, res, url))) return;

  if (req.method === "GET" && path === "/api/health") return json(res, 200, m.health(m.ctx(req, false)));

  if (req.method === "GET" && path === "/api/logo") {
    // Always an image: the site's own logo when we have one, else a generated letter tile.
    const domain = cleanDomain(url.searchParams.get("domain"));
    if (!domain) throw new HttpError(400, "Give a plain domain, like ?domain=neon.com.");
    const logo = (await m.logos.get(domain)) ?? monogram(domain);
    const svg = logo.type === "image/svg+xml";
    res.writeHead(200, {
      "content-type": logo.type,
      "cache-control": `public, max-age=${svg ? 3600 : 604800}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    });
    res.end(logo.body);
    return;
  }

  if (req.method === "POST" && path === "/api/clock") {
    const ctx = m.ctx(req, true)!;
    const clock = ctx.clock;
    if (!clock || !ctx.clockSettable) throw new HttpError(403, "The demo clock is off (set ALLOW_CLOCK_OVERRIDE=1).");
    const body = await readJson(req, m.maxBody);
    if (body.reset) clock.reset();
    else if (typeof body.now === "string") {
      try {
        clock.set(body.now);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    } else throw new HttpError(400, "Send {now: ISO date} or {reset: true}.");
    m.clockChanged?.(ctx, body.reset ? null : clock.now());
    return json(res, 200, { now: clock.now(), nowLabel: ctx.agent.nowLabel() });
  }

  const label = (ctx: Ctx, ms: number) => formatLocal(ms, tz, ctx.clock?.now() ?? Date.now());

  if (req.method === "GET" && path === "/api/sessions") {
    const ctx = m.ctx(req, false);
    if (!ctx) return json(res, 200, { sessions: [] });
    return json(res, 200, {
      sessions: ctx.agent.store.listSessions().map((s) => ({ id: s.id, title: s.title, updatedAt: s.updated_at, updatedLabel: label(ctx, s.updated_at) })),
    });
  }

  if (req.method === "POST" && path === "/api/sessions") {
    const s = m.ctx(req, true)!.agent.newSession();
    return json(res, 200, { id: s.id });
  }

  const nudgeMatch = path.match(/^\/api\/sessions\/([\w-]{1,64})\/nudge$/);
  if (req.method === "POST" && nudgeMatch) {
    const ctx = m.ctx(req, false);
    if (!ctx || (m.nudgeAllowed && !m.nudgeAllowed())) return json(res, 200, { nudge: null });
    m.streamStarted?.(ctx.visitor);
    try {
      // Bounded: a slow web never delays the chat; the nudge just doesn't appear.
      const r = await Promise.race([
        ctx.agent.nudge(nudgeMatch[1]!).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 12000)),
      ]);
      return json(res, 200, r ? { messageId: r.messageId, text: r.nudge.text, sources: r.nudge.sources.map((s) => ({ n: s.n, title: s.title, url: s.url, domain: s.domain, date: s.publishedDate, official: s.official })) } : { nudge: null });
    } finally {
      m.streamEnded?.(ctx.visitor);
    }
  }

  const msgMatch = path.match(/^\/api\/sessions\/([\w-]{1,64})\/messages$/);
  if (req.method === "GET" && msgMatch) {
    const ctx = m.ctx(req, false);
    const rows = ctx ? ctx.agent.store.sessionMessages(msgMatch[1]!) : [];
    return json(res, 200, {
      messages: rows.map((r) => {
        const meta = JSON.parse(r.meta) as Record<string, unknown>;
        return { id: r.id, role: r.role, content: r.content, at: r.created_at, atLabel: label(ctx!, r.created_at), sources: meta.sources ?? [], warnings: meta.warnings ?? [], intent: meta.intent, timings: meta.timings };
      }),
    });
  }

  if (req.method === "POST" && path === "/api/chat") {
    const body = await readJson(req, m.maxBody);
    const text = typeof body.text === "string" ? body.text : "";
    if (m.chat) return demoChat(m, m.chat, req, res, body, text);
    const agent = m.ctx(req, true)!.agent;
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

function handler(m: Mode, before?: (req: IncomingMessage, res: ServerResponse) => boolean) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const run = async () => {
      if (before && !before(req, res)) return;
      await route(m, req, res);
    };
    run().catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) {
        if (e instanceof HttpError && e.retryAfter) res.setHeader("retry-after", String(e.retryAfter));
        const body: Record<string, unknown> = { error: e instanceof HttpError ? e.message : "Something went wrong on the server." };
        if (e instanceof HttpError && e.code) body.code = e.code;
        if (e instanceof HttpError && e.retryAfter) body.retryAfter = e.retryAfter;
        json(res, status, body);
      } else res.end();
    });
  };
}

// ---------------------------------------------------------------------------------------------
// Single-user mode: today's app, unchanged.

function createSingleUserApp(config: Config): App {
  const { agent, clock, llm, search } = createAgent(config);
  const logos = new LogoService({
    dir: config.dbPath === ":memory:" ? null : join(dirname(config.dbPath), "logos"),
    enabled: config.logoFetch,
    fallback: "https://icons.duckduckgo.com/ip3/{domain}.ico",
  });
  const ctx: Ctx = { agent, clock, clockSettable: !!clock && config.allowClockOverride };
  const mode: Mode = {
    config,
    maxBody: MAX_BODY,
    logos,
    ctx: () => ctx,
    health: () => ({
      ok: true,
      fake: config.fakeMode,
      fakeReason: config.fakeReason,
      model: llm.name,
      search: search.name,
      timezone: config.timezone,
      now: (clock ?? { now: () => Date.now() }).now(),
      nowLabel: agent.nowLabel(),
      clockSettable: ctx.clockSettable,
      watch: config.watchEnabled,
    }),
  };
  return {
    handle: handler(mode),
    config,
    demo: null,
    async close() {
      await agent.idle();
      agent.store.close();
    },
    startupLines: () => [
      `  model: ${llm.name}`,
      `  search: ${search.name}   timezone: ${config.timezone}   now: ${agent.nowLabel()}`,
      ...(config.fakeMode ? [`  FAKE MODE (${config.fakeReason}): offline fixtures, demo clock enabled. Add keys to .env for real answers.`] : []),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Hosted demo mode.

const LOCAL_HINT = " The full app runs on your own machine in fake mode, no key needed: clone the repo, then run npm install and npm run dev.";

/** SHA-256 hashes of index.html's inline scripts, so the CSP can allow exactly those and nothing else. */
function inlineScriptHashes(): string[] {
  try {
    const html = readFileSync(join(PUBLIC, "index.html"), "utf8");
    return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((mm) => `'sha256-${createHash("sha256").update(mm[1] ?? "").digest("base64")}'`);
  } catch {
    return [];
  }
}

function page(title: string, body: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)} · minimi</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 16px}h1{font-size:1.4rem}input,button{font:inherit;padding:.4rem .6rem}code{font-size:.9em}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}

function htmlPage(res: ServerResponse, status: number, title: string, body: string, retryAfter?: number): void {
  const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
  if (retryAfter) headers["retry-after"] = String(retryAfter);
  res.writeHead(status, headers);
  res.end(page(title, body));
}

function createDemoApp(config: Config, demo: DemoConfig): App {
  const tz = config.timezone;
  const registry = new DemoRegistry(join(demo.dataDir, "demo.db"));
  const meter = new LedgerMeter(registry, demo.budgetUsd);
  const publicError = (e: Error): string => {
    if (e instanceof BudgetExceededError) return BUDGET_USED_UP;
    console.error("demo: model error:", e.message);
    return "The model service had a problem. Please try again in a moment.";
  };
  const pool = new VisitorPool({ config, registry, meter, dir: join(demo.dataDir, "visitors"), maxOpen: demo.openVisitors, publicError });
  const logos = new LogoService({ dir: join(demo.dataDir, "logos"), enabled: config.logoFetch, fallback: "https://icons.duckduckgo.com/ip3/{domain}.ico" });
  // Model and search names for /api/health (no key is needed to build a description).
  const names = buildModels(config, new SystemClock(), new UsageMeter(null));
  const secrets = [demo.cookieSecret, demo.cookieSecretPrevious].filter(Boolean);
  const ipMessages = new TokenBuckets(demo.ipMsgsPerMin, demo.ipMsgsPerMin);
  const ipRequests = new TokenBuckets(demo.ipRequestsPerMin, demo.ipRequestsPerMin);
  const load = { streams: 0 }; // answers and nudges running now

  const csp = [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes().join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  // Per request: who is this (set by `before`, read by `ctx`). WeakMap so nothing leaks between requests.
  const who = new WeakMap<IncomingMessage, { id: string; https: boolean }>();

  const clientIp = (req: IncomingMessage): string => {
    if (demo.trustProxy) {
      // Our proxy (Caddy) appends the address it saw: the LAST entry is the one we can trust.
      const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const last = xff[xff.length - 1];
      if (last) return last;
    }
    return req.socket.remoteAddress ?? "unknown";
  };
  const isHttps = (req: IncomingMessage) => demo.cookieSecure || (demo.trustProxy && String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim() === "https");
  const today = () => isoDate(Date.now(), tz);
  const secondsToTomorrow = () => {
    const next = startOfDay(addDays(civilDateOf(Date.now(), tz), 1), tz);
    return Math.max(1, Math.ceil((next - Date.now()) / 1000));
  };

  function ctxFor(id: string): Ctx {
    const visitor = pool.get(id);
    return { agent: visitor.agent, clock: visitor.clock, clockSettable: true, visitor };
  }

  const mode: Mode = {
    config,
    maxBody: demo.maxBodyBytes,
    logos,
    ctx(req, create) {
      const w = who.get(req);
      if (!w) throw new HttpError(500, "no visitor");
      if (!registry.exists(w.id)) {
        if (!create) return null;
        if (registry.register(w.id, Date.now(), demo.maxVisitors) === "full") {
          throw new HttpError(503, "The demo is full right now. Please try again later." + LOCAL_HINT, "demo_full", 3600);
        }
      }
      return ctxFor(w.id);
    },
    health(ctx) {
      const now = ctx?.clock?.now() ?? Date.now();
      const w = ctx?.visitor;
      return {
        ok: true,
        fake: config.fakeMode,
        fakeReason: "hosted demo, offline test web",
        model: names.llm.name,
        search: names.search.name,
        timezone: tz,
        now,
        nowLabel: ctx ? ctx.agent.nowLabel() : `${formatLocal(now, tz)} (${tz})`,
        clockSettable: true,
        watch: config.watchEnabled,
        demo: {
          maxMessageChars: demo.maxMessageChars,
          messagesPerDay: demo.msgsPerVisitorPerDay,
          messagesLeftToday: demo.msgsPerVisitorPerDay - (w ? registry.messagesToday(w.id, today()) : 0),
          budgetUsedUp: meter.spentUsd() >= demo.budgetUsd,
          ttlDays: demo.ttlDays,
        },
      };
    },
    nudgeAllowed: () => load.streams < demo.maxStreamsGlobal && meter.canStart(load.streams, demo.turnReserveUsd),
    streamStarted(v) {
      load.streams++;
      if (v) v.active++;
    },
    streamEnded(v) {
      load.streams--;
      if (v) v.active--;
    },
    clockChanged(ctx, fixed) {
      if (ctx.visitor) registry.setClock(ctx.visitor.id, fixed);
    },
    async extra(req, res, url) {
      if (req.method === "GET" && url.pathname === "/api/demo/status") {
        json(res, 200, {
          mode: "demo",
          fake: config.fakeMode,
          budgetUsedPct: meter.usedPct(),
          budgetUsedUp: meter.spentUsd() >= demo.budgetUsd,
          visitors: registry.count(),
          maxVisitors: demo.maxVisitors,
          openVisitors: pool.size,
          streams: load.streams,
        });
        return true;
      }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const w = who.get(req)!;
        if (!registry.exists(w.id) && registry.count() >= demo.maxVisitors) {
          htmlPage(res, 503, "The demo is full", `<p>Every demo seat is taken right now. Please try again later.</p><p>${LOCAL_HINT.trim()}</p>`, 3600);
          return true;
        }
      }
      return false;
    },
    chat: {
      timeoutMs: demo.streamTimeoutMs,
      errorEvent: (message) => ({ type: "error", code: "demo_budget", final: true, message: message + LOCAL_HINT }),
      admit(req, text) {
        const w = who.get(req)!;
        if (!text.trim()) throw new HttpError(400, "Say something first.");
        if (text.length > demo.maxMessageChars) {
          throw new HttpError(400, `Please keep messages under ${demo.maxMessageChars.toLocaleString("en-US")} characters in the demo.`, "too_long");
        }
        const wait = ipMessages.take(clientIp(req));
        if (wait) throw new HttpError(429, `Too many messages from your network. Try again in ${wait} s.`, "rate_limited", wait);
        const open = pool.peek(w.id);
        if (open && open.active > 0) throw new HttpError(429, "Wait for the current answer to finish (or stop it) first.", "busy", 3);
        if (load.streams >= demo.maxStreamsGlobal) throw new HttpError(503, "The demo is busy answering others. Try again in a few seconds.", "busy_global", 5);
        const ctx = mode.ctx(req, true)!;
        const day = today();
        if (!registry.takeMessage(w.id, day, demo.msgsPerVisitorPerDay)) {
          const retry = secondsToTomorrow();
          throw new HttpError(429, `You've used today's ${demo.msgsPerVisitorPerDay} demo messages. They reset at midnight (${tz}).`, "daily_limit", retry);
        }
        return { ctx, refund: () => registry.returnMessage(w.id, day), budgetLeft: meter.canStart(load.streams, demo.turnReserveUsd) };
      },
    },
  };

  /** Security headers, access code and the visitor cookie. Returns false when it already answered. */
  function before(req: IncomingMessage, res: ServerResponse): boolean {
    res.setHeader("content-security-policy", csp);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("cross-origin-opener-policy", "same-origin");
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
    const https = isHttps(req);
    if (https) res.setHeader("strict-transport-security", "max-age=31536000");

    const url = new URL(req.url ?? "/", "http://localhost");
    const ip = clientIp(req);
    const wait = ipRequests.take(ip);
    if (wait) throw new HttpError(429, `Too many requests. Try again in ${wait} s.`, "rate_limited", wait);

    const cookies = parseCookies(req.headers.cookie);
    const setCookies: string[] = [];
    const maxAge = demo.ttlDays * 86400;

    if (demo.accessCode) {
      const given = url.searchParams.get("code");
      if (given !== null && req.method === "GET" && !url.pathname.startsWith("/api/")) {
        if (codeMatches(given, demo.accessCode)) {
          url.searchParams.delete("code");
          res.writeHead(303, {
            location: url.pathname + (url.search || ""),
            "set-cookie": cookieHeader(ACCESS_COOKIE, accessToken(demo.accessCode, demo.cookieSecret), { maxAgeSec: maxAge, secure: https }),
            "cache-control": "no-store",
          });
          res.end();
          return false;
        }
      }
      if (!checkAccess(cookies[ACCESS_COOKIE], demo.accessCode, secrets)) {
        if (url.pathname.startsWith("/api/")) throw new HttpError(401, "This demo needs an access code. Open the link you were given.", "access_required");
        const wrong = given !== null ? `<p role="alert">That code didn't work.</p>` : "";
        htmlPage(res, 401, "Access code needed", `<p>This hosted demo of minimi is open to invited reviewers.</p>${wrong}<form method="get" action="/"><label for="code">Access code</label><br><input id="code" name="code" autocomplete="off" required> <button type="submit">Open the demo</button></form>`);
        return false;
      }
    }

    const v = verifyVisitor(cookies[VISITOR_COOKIE], secrets);
    const id = v?.id ?? newVisitorId();
    if (!v || v.resign) setCookies.push(cookieHeader(VISITOR_COOKIE, signVisitor(id, demo.cookieSecret), { maxAgeSec: maxAge, secure: https }));
    if (setCookies.length) res.setHeader("set-cookie", setCookies);
    who.set(req, { id, https });
    registry.touch(id, Date.now());
    return true;
  }

  // The TTL sweep: at start and then every hour.
  const sweep = () => {
    pool.sweep(Date.now() - demo.ttlDays * 86400_000).catch((e) => console.error("demo: sweep failed:", e));
    ipMessages.prune();
    ipRequests.prune();
  };
  sweep();
  const timer = setInterval(sweep, Math.min(3600_000, demo.ttlDays * 86400_000));
  timer.unref();

  const h = handler(mode, before);
  return {
    handle: h,
    config,
    demo,
    demoState: { registry, pool, meter, load },
    async close() {
      clearInterval(timer);
      await pool.closeAll();
      registry.close();
    },
    startupLines: () => [
      `  HOSTED DEMO MODE: per-visitor memory in ${join(demo.dataDir, "visitors")}, budget $${demo.budgetUsd} (${meter.usedPct()}% used)`,
      `  model: ${names.llm.name}   search: ${names.search.name}   timezone: ${tz}`,
      `  limits: ${demo.maxVisitors} visitors, ${demo.msgsPerVisitorPerDay} msgs/visitor/day, ${demo.ipMsgsPerMin} msgs/IP/min, ${demo.maxStreamsGlobal} answers at once`,
      ...(config.fakeMode ? [`  FAKE MODE (${config.fakeReason}): offline fixtures.`] : []),
      ...(demo.accessCode ? ["  access code required on first visit (DEMO_ACCESS_CODE)"] : []),
    ],
  };
}

async function demoChat(m: Mode, chat: DemoChat, req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>, text: string): Promise<void> {
  const { ctx, refund, budgetLeft } = chat.admit(req, text);
  const agent = ctx.agent;
  if (!budgetLeft) {
    refund();
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
    res.end(`data: ${JSON.stringify(chat.errorEvent(BUDGET_USED_UP))}\n\n`);
    return;
  }
  const sessionId = typeof body.sessionId === "string" && /^[\w-]{1,64}$/.test(body.sessionId) ? body.sessionId : agent.newSession().id;
  m.streamStarted?.(ctx.visitor);
  try {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const timeout = setTimeout(() => abort.abort(), chat.timeoutMs);
    try {
      for await (const ev of agent.chat(sessionId, text, abort.signal)) {
        const out = ev.type === "error" && ev.message === BUDGET_USED_UP ? { ...chat.errorEvent(ev.message), final: false } : ev;
        if (!res.destroyed) res.write(`data: ${JSON.stringify(out)}\n\n`);
      }
    } finally {
      clearTimeout(timeout);
    }
    res.end();
  } finally {
    m.streamEnded?.(ctx.visitor);
  }
}
