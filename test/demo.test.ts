// The hosted demo (DEMO_MODE=1): per-visitor isolation behind a signed cookie, the persisted budget,
// per-visitor and per-IP limits, abuse caps, and that demo-off is the single-user app as before.
// Offline: fake model and fake web, a real HTTP server on a random port, a throwaway data folder.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type App, createApp } from "../src/app.ts";
import { LedgerMeter } from "../src/demo/budget.ts";
import { type DemoConfig, loadDemoConfig } from "../src/demo/config.ts";
import { signVisitor, verifyVisitor } from "../src/demo/cookie.ts";
import { TokenBuckets } from "../src/demo/limits.ts";
import { DemoRegistry } from "../src/demo/registry.ts";
import { VisitorPool } from "../src/demo/visitors.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { BudgetExceededError } from "../src/usage.ts";

process.env.FAKE_MODE = "1";
process.env.LOGO_FETCH = "0";
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const dirs: string[] = [];
const servers: Array<{ server: Server; app: App }> = [];

function baseConfig(dbPath = ":memory:"): Config {
  return { ...loadConfig(), dbPath, fakeMode: true, fakeReason: "FAKE_MODE=1", searchProvider: "fake", logoFetch: false };
}

function demoConfig(over: Partial<DemoConfig> = {}): DemoConfig {
  const dataDir = mkdtempSync(join(tmpdir(), "minimi-demo-test-"));
  dirs.push(dataDir);
  return { ...loadDemoConfig({ DEMO_MODE: "1", DEMO_COOKIE_SECRET: SECRET })!, dataDir, ...over };
}

async function start(demo: DemoConfig | null, config = baseConfig()) {
  const app = createApp(config, demo);
  const server = createServer(app.handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push({ server, app });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { app, base, server };
}

async function stop(s: { app: App; server: Server }) {
  await new Promise<void>((r) => s.server.close(() => r()));
  await s.app.close();
  servers.splice(servers.findIndex((x) => x.server === s.server), 1);
}

after(async () => {
  for (const s of [...servers]) await stop(s);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A browser: keeps its cookies, can claim to come from an IP (only honoured with DEMO_TRUST_PROXY=1). */
function browser(base: string, ip?: string) {
  const jar = new Map<string, string>();
  const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (ip) headers["x-forwarded-for"] = ip;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(base + path, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const eq = kv!.indexOf("=");
      jar.set(kv!.slice(0, eq), kv!.slice(eq + 1));
    }
    return res;
  };
  return {
    jar,
    call,
    json: async (path: string, body?: unknown) => {
      const r = await call(path, { body });
      return { status: r.status, headers: r.headers, data: (await r.json()) as Record<string, any> };
    },
    /** Sends a chat message; returns the stream's events (or the HTTP error). */
    chat: async (text: string, sessionId?: string) => {
      const r = await call("/api/chat", { body: { text, sessionId } });
      if (!r.headers.get("content-type")?.startsWith("text/event-stream")) return { status: r.status, headers: r.headers, error: (await r.json()) as Record<string, any>, events: [] as any[] };
      const raw = await r.text();
      const events = raw.split("\n\n").filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, "")));
      return { status: r.status, headers: r.headers, error: null, events };
    },
  };
}

const answerText = (events: any[]) => events.filter((e) => e.type === "delta").map((e) => e.text).join("");

test("demo config: refuses to start without a strong cookie secret; off unless DEMO_MODE=1", () => {
  assert.equal(loadDemoConfig({}), null);
  assert.equal(loadDemoConfig({ DEMO_MODE: "0", DEMO_COOKIE_SECRET: SECRET }), null);
  assert.throws(() => loadDemoConfig({ DEMO_MODE: "1" }), /DEMO_COOKIE_SECRET/);
  assert.throws(() => loadDemoConfig({ DEMO_MODE: "1", DEMO_COOKIE_SECRET: "short" }), /Refusing to start/);
  assert.throws(() => loadDemoConfig({ DEMO_MODE: "1", DEMO_COOKIE_SECRET: SECRET, DEMO_BUDGET_USD: "lots" }), /DEMO_BUDGET_USD/);
  const d = loadDemoConfig({ DEMO_MODE: "1", DEMO_COOKIE_SECRET: SECRET })!;
  assert.equal(d.budgetUsd, 18);
  assert.equal(d.maxVisitors, 500);
  assert.equal(d.msgsPerVisitorPerDay, 40);
  assert.equal(d.maxMessageChars, 2000);
  assert.equal(d.accessCode, "");
});

test("cookie: signed ids verify, tampered or foreign ones don't, the previous secret still works during a rotation", () => {
  const id = "0123456789abcdef0123456789abcdef";
  const v = signVisitor(id, SECRET);
  assert.deepEqual(verifyVisitor(v, [SECRET]), { id, resign: false });
  assert.equal(verifyVisitor(v.slice(0, -1) + (v.endsWith("A") ? "B" : "A"), [SECRET]), null);
  assert.equal(verifyVisitor(`${"f".repeat(32)}.${v.split(".")[1]}`, [SECRET]), null); // someone else's id with my tag
  assert.equal(verifyVisitor(signVisitor("../../etc/passwd", SECRET), [SECRET]), null);
  assert.equal(verifyVisitor(signVisitor(id, "another-secret-another-secret-0000"), [SECRET]), null);
  assert.deepEqual(verifyVisitor(signVisitor(id, "old-secret-old-secret-old-secret-00"), [SECRET, "old-secret-old-secret-old-secret-00"]), { id, resign: true });
});

test("demo off: the single-user app as before (same health fields, no cookie), with the same security headers", async () => {
  const s = await start(null);
  const b = browser(s.base);
  const h = await b.json("/api/health");
  assert.deepEqual(Object.keys(h.data).sort(), ["clockSettable", "fake", "fakeReason", "model", "now", "nowLabel", "ok", "search", "timezone", "watch"].sort());
  assert.equal(h.headers.get("set-cookie"), null);
  for (const res of [h, await b.call("/"), await b.call("/report/")]) {
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self' 'sha256-/); // the pages' inline theme script, by hash
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  }
  assert.equal((await b.call("/api/demo/status")).status, 404);
  const r = await b.chat("x".repeat(3000)); // no demo length cap (the agent's own 4,000 applies)
  assert.equal(r.status, 200);
  assert.ok(r.events.some((e) => e.type === "done"));
  assert.equal(b.jar.size, 0);
  await stop(s);
});

test("isolation: two visitors never see each other's sessions, messages, memory or clock", async () => {
  const demo = demoConfig();
  const s = await start(demo);
  const alice = browser(s.base);
  const bob = browser(s.base);
  await alice.call("/"); // gets a cookie
  await bob.call("/");
  assert.ok(alice.jar.get("minimi_visitor") && bob.jar.get("minimi_visitor"));
  assert.notEqual(alice.jar.get("minimi_visitor"), bob.jar.get("minimi_visitor"));

  const a = await alice.chat("What does Postgres hosting cost on Supabase, Neon and Railway?");
  const sid = a.events.find((e) => e.type === "turn").sessionId as string;
  assert.ok(a.events.some((e) => e.type === "done"));

  assert.equal((await alice.json("/api/sessions")).data.sessions.length, 1);
  assert.deepEqual((await bob.json("/api/sessions")).data.sessions, []);
  assert.deepEqual((await bob.json(`/api/sessions/${sid}/messages`)).data.messages, []);
  // Bob reusing Alice's session id lands in his own memory: no history, no recall of her question.
  const b = await bob.chat("What did I ask about Postgres hosting?", sid);
  assert.doesNotMatch(answerText(b.events), /Supabase, Neon and Railway\?/);
  assert.equal((await alice.json(`/api/sessions/${sid}/messages`)).data.messages.length, 2);
  assert.equal((await bob.json(`/api/sessions/${sid}/messages`)).data.messages.length, 2);

  // Clocks are per visitor.
  const set = await alice.json("/api/clock", { now: "2026-11-18T10:00:00+05:30" });
  assert.equal(set.status, 200);
  assert.equal((await alice.json("/api/health")).data.now, Date.parse("2026-11-18T10:00:00+05:30"));
  assert.notEqual((await bob.json("/api/health")).data.now, Date.parse("2026-11-18T10:00:00+05:30"));

  const files = readdirSync(join(demo.dataDir, "visitors")).filter((f) => f.endsWith(".db"));
  assert.equal(files.length, 2);
  await stop(s);

  // After a restart Alice keeps her memory and her clock.
  const s2 = await start(demo);
  const alice2 = browser(s2.base);
  for (const [k, v] of alice.jar) alice2.jar.set(k, v);
  assert.equal((await alice2.json("/api/sessions")).data.sessions.length, 1);
  assert.equal((await alice2.json("/api/health")).data.now, Date.parse("2026-11-18T10:00:00+05:30"));
  await stop(s2);
});

test("cookie tamper: a forged or edited cookie gets a fresh empty visitor, never the original's data", async () => {
  const s = await start(demoConfig());
  const alice = browser(s.base);
  await alice.chat("Supabase pricing?");
  const real = alice.jar.get("minimi_visitor")!;
  const [id, sig] = real.split(".");
  const mallory = browser(s.base);
  for (const forged of [`${id}.${sig!.slice(0, -2)}xx`, `${id}.`, id!, `${id}.${signVisitor(id!, "guess-guess-guess-guess-guess-guess").split(".")[1]}`]) {
    mallory.jar.set("minimi_visitor", forged);
    const r = await mallory.json("/api/sessions");
    assert.deepEqual(r.data.sessions, [], forged);
    const issued = mallory.jar.get("minimi_visitor")!;
    assert.notEqual(issued.split(".")[0], id, "a new id is issued");
  }
  assert.equal((await alice.json("/api/sessions")).data.sessions.length, 1);
  await stop(s);
});

test("budget: the ledger persists across restarts and blocks chats with a typed event once used up", async () => {
  const demo = demoConfig({ budgetUsd: 1, turnReserveUsd: 0 });
  // Spend is metered with the usual prices and written through at once.
  const reg = new DemoRegistry(join(demo.dataDir, "demo.db"));
  const meter = new LedgerMeter(reg, 1);
  meter.add("claude-opus-5-5", { input_tokens: 100_000, output_tokens: 10_000 }); // $0.40 + $0.20
  reg.close();
  const reg2 = new DemoRegistry(join(demo.dataDir, "demo.db"));
  assert.ok(Math.abs(reg2.ledger().spent_usd - 0.6) < 1e-9);
  const meter2 = new LedgerMeter(reg2, 1);
  meter2.check(); // under budget
  meter2.add("claude-opus-5-5", { output_tokens: 20_000 }); // +$0.40 = $1.00
  assert.throws(() => meter2.check(), BudgetExceededError);
  reg2.close();

  const s = await start(demo);
  const b = browser(s.base);
  const st = await b.json("/api/demo/status");
  assert.equal(st.data.budgetUsedPct, 100);
  assert.equal(st.data.budgetUsedUp, true);
  assert.equal(JSON.stringify(st.data).includes(SECRET), false);
  const r = await b.chat("Supabase pricing?");
  assert.equal(r.status, 200);
  assert.deepEqual(r.events.map((e) => e.type), ["error"]);
  assert.equal(r.events[0].code, "demo_budget");
  assert.equal(r.events[0].final, true);
  assert.match(r.events[0].message, /budget is used up.*npm run dev/s);
  assert.equal((await b.json("/api/health")).data.demo.budgetUsedUp, true);
  // A refused message doesn't count against the visitor's day.
  assert.equal((await b.json("/api/health")).data.demo.messagesLeftToday, 40);
  await stop(s);
});

test("per-visitor daily cap: typed 429 with Retry-After once today's messages are used", async () => {
  const s = await start(demoConfig({ msgsPerVisitorPerDay: 2 }));
  const b = browser(s.base);
  assert.equal((await b.chat("hello")).status, 200);
  assert.equal((await b.chat("hi again")).status, 200);
  assert.equal((await b.json("/api/health")).data.demo.messagesLeftToday, 0);
  const r = await b.chat("one more");
  assert.equal(r.status, 429);
  assert.equal(r.error!.code, "daily_limit");
  assert.ok(Number(r.headers.get("retry-after")) > 0);
  assert.equal((await browser(s.base).chat("someone else")).status, 200); // other visitors unaffected
  await stop(s);
});

test("per-IP rate limit: shared across visitors from one address; X-Forwarded-For only with DEMO_TRUST_PROXY=1", async () => {
  const s = await start(demoConfig({ ipMsgsPerMin: 2 }));
  const one = browser(s.base, "203.0.113.7");
  const two = browser(s.base, "198.51.100.9"); // spoofed header, not trusted: same socket address
  assert.equal((await one.chat("hello")).status, 200);
  assert.equal((await two.chat("hello")).status, 200);
  const r = await one.chat("hello");
  assert.equal(r.status, 429);
  assert.equal(r.error!.code, "rate_limited");
  assert.ok(Number(r.headers.get("retry-after")) >= 1);
  await stop(s);

  const t = await start(demoConfig({ ipMsgsPerMin: 1, trustProxy: true }));
  assert.equal((await browser(t.base, "203.0.113.7").chat("hello")).status, 200);
  assert.equal((await browser(t.base, "198.51.100.9").chat("hello")).status, 200);
  assert.equal((await browser(t.base, "10.0.0.1, 203.0.113.7").chat("hello")).status, 429, "the proxy-appended last entry counts");
  await stop(t);

  const bucket = new TokenBuckets(2, 2);
  assert.equal(bucket.take("ip", 0), 0);
  assert.equal(bucket.take("ip", 0), 0);
  assert.equal(bucket.take("ip", 0), 30);
  assert.equal(bucket.take("ip", 30_000), 0);
});

test("abuse caps: message length, body size, security headers, no internals in errors", async () => {
  const s = await start(demoConfig());
  const b = browser(s.base);
  const long = await b.chat("x".repeat(2001));
  assert.equal(long.status, 400);
  assert.equal(long.error!.code, "too_long");
  assert.equal((await b.chat("x".repeat(2000))).status, 200);
  const big = await b.call("/api/chat", { body: { text: "hi", pad: "x".repeat(20_000) } });
  assert.equal(big.status, 413);
  const page = await b.call("/");
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'sha256-/); // the inline theme script, by hash
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  const cookie = page.headers.getSetCookie().join("") || (await browser(s.base).call("/")).headers.getSetCookie().join("");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Secure/); // plain http here
  const behindHttps = await start(demoConfig({ trustProxy: true }));
  const sc = (await fetch(behindHttps.base + "/", { headers: { "x-forwarded-proto": "https" } })).headers.getSetCookie().join("");
  assert.match(sc, /; Secure/);
  await stop(behindHttps);
  const health = await b.json("/api/health");
  assert.equal(JSON.stringify(health.data).includes("ANTHROPIC"), false);
  const notFound = await b.json("/api/nope");
  assert.deepEqual(Object.keys(notFound.data), ["error"]);
  assert.equal((await b.call("/../../package.json")).status, 404);
  await stop(s);
});

test("demo full: new visitors get a friendly page or a typed 503, existing ones carry on", async () => {
  const s = await start(demoConfig({ maxVisitors: 1 }));
  const first = browser(s.base);
  assert.equal((await first.chat("hello")).status, 200);
  const late = browser(s.base);
  const page = await late.call("/");
  assert.equal(page.status, 503);
  assert.match(await page.text(), /demo is full/i);
  const r = await late.chat("hello");
  assert.equal(r.status, 503);
  assert.equal(r.error!.code, "demo_full");
  assert.equal((await late.json("/api/sessions", {})).data.code, "demo_full");
  assert.deepEqual((await late.json("/api/sessions")).data.sessions, []); // reading creates nothing
  assert.equal((await first.call("/")).status, 200);
  assert.equal((await first.chat("still here")).status, 200);
  assert.equal((await late.json("/api/demo/status")).data.visitors, 1);
  await stop(s);
});

test("one answer at a time per visitor, and a global cap on answers at once", async () => {
  const s = await start(demoConfig({ maxStreamsGlobal: 2 }));
  const state = s.app.demoState!;
  const a = browser(s.base);
  const b = browser(s.base);
  await a.json("/api/sessions", {});
  await b.json("/api/sessions", {});
  const aliceId = a.jar.get("minimi_visitor")!.split(".")[0]!;
  // Alice has an answer running (the fake model is too quick to catch one mid-flight, so mark it).
  state.pool.peek(aliceId)!.active = 1;
  state.load.streams = 1;
  const same = await a.chat("again");
  assert.equal(same.status, 429);
  assert.equal(same.error!.code, "busy");
  assert.equal((await b.chat("hello")).status, 200, "Bob is not blocked by Alice's answer");
  state.load.streams = 2; // the server is at its global cap
  const other = await b.chat("hello");
  assert.equal(other.status, 503);
  assert.equal(other.error!.code, "busy_global");
  assert.equal(Number(other.headers.get("retry-after")), 5);
  state.pool.peek(aliceId)!.active = 0;
  state.load.streams = 0;
  assert.equal((await a.chat("hello")).status, 200);
  assert.equal(state.load.streams, 0, "a finished answer frees its slot");
  await stop(s);
});

test("access code (optional): first visit needs ?code=, then the cookie is enough", async () => {
  const s = await start(demoConfig({ accessCode: "open-sesame" }));
  const b = browser(s.base);
  assert.equal((await b.call("/")).status, 401);
  assert.equal((await b.json("/api/health")).data.code, "access_required");
  assert.equal((await b.call("/?code=wrong")).status, 401);
  const ok = await b.call("/?code=open-sesame");
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/");
  assert.equal((await b.call("/")).status, 200);
  assert.equal((await b.chat("hello")).status, 200);
  const sneaky = await browser(s.base).call("/.//evil.example/?code=open-sesame");
  assert.equal(sneaky.status, 303);
  assert.match(sneaky.headers.get("location")!, /^\/(?![/\\])/, "no open redirect");
  await stop(s);
});

test("TTL sweep: visitors not seen for DEMO_TTL_DAYS are deleted with their files; busy ones are kept", async () => {
  const demo = demoConfig();
  const reg = new DemoRegistry(join(demo.dataDir, "demo.db"));
  const pool = new VisitorPool({ config: baseConfig(), registry: reg, meter: new LedgerMeter(reg, 18), dir: join(demo.dataDir, "visitors"), maxOpen: 2, publicError: (e) => e.message });
  const ids = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
  for (const id of ids) {
    reg.register(id, 1000, 10);
    pool.get(id).agent.newSession();
  }
  assert.equal(pool.size, 2, "LRU closes the oldest idle visitor");
  pool.get(ids[2]!).active = 1;
  reg.touch(ids[1]!, Date.now());
  const removed = await pool.sweep(Date.now() - 86400_000);
  assert.equal(removed, 1); // a: old and idle. b: seen recently. c: old but busy.
  assert.equal(existsSync(pool.pathFor(ids[0]!)), false);
  assert.equal(existsSync(pool.pathFor(ids[1]!)), true);
  assert.equal(reg.exists(ids[0]!), false);
  assert.equal(reg.exists(ids[2]!), true);
  assert.throws(() => pool.pathFor("../x"), /bad visitor id/);
  pool.get(ids[2]!).active = 0;
  await pool.closeAll();
  reg.close();
});

test("typing wins over a running nudge: the nudge is cancelled (nothing written, nothing lost) and the message is served", async () => {
  const s = await start(demoConfig());
  const state = s.app.demoState!;
  const a = browser(s.base);
  await a.json("/api/clock", { now: "2026-11-10T10:00:00+05:30" });
  await a.chat("What does Postgres hosting cost on Supabase, Neon and Railway?");
  assert.equal((await a.json("/api/clock", { now: "2026-11-16T09:00:00+05:30" })).status, 200);
  const sid = (await a.json("/api/sessions", {})).data.id as string;
  const v = state.pool.peek(a.jar.get("minimi_visitor")!.split(".")[0]!)!;
  // Hold the nudge's search open until it is cancelled, the way a slow web would.
  const deps = (v.agent as unknown as { deps: { search: { name: string; search: (q: string, o?: { signal?: AbortSignal }) => Promise<unknown[]> } } }).deps;
  const real = deps.search;
  let started!: () => void;
  const searching = new Promise<void>((r) => (started = r));
  const seen: AbortSignal[] = [];
  deps.search = {
    name: real.name,
    search: (_q, o) => {
      started();
      seen.push(o!.signal!);
      return new Promise((_, reject) => o!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
  };
  const nudge = a.json(`/api/sessions/${sid}/nudge`, {});
  await Promise.race([searching, nudge.then((n) => Promise.reject(new Error(`the nudge ended without searching: ${JSON.stringify(n.data)}`)))]);
  const r = await a.chat("hi", sid);
  assert.equal(r.status, 200, "not 429 busy");
  assert.ok(r.events.some((e) => e.type === "done"));
  assert.deepEqual((await nudge).data, { nudge: null });
  assert.ok(seen.length > 0 && seen.every((x) => x.aborted), "the nudge's searches were cancelled");
  assert.deepEqual((await a.json(`/api/sessions/${sid}/messages`)).data.messages.map((m: { role: string }) => m.role), ["user", "assistant"]);
  assert.equal(v.nudges.size, 0);
  assert.equal(state.load.streams, 0);
  deps.search = real;
  // The change the cancelled nudge was checking is still reported.
  const news = await a.chat("Anything new?");
  assert.match(answerText(news.events), /\| Neon: Launch plan[^|]*\|[^\n]*Changed/);
  await stop(s);
});

test("demo health and status report the real search provider, not 'offline test web', when keys are set", async () => {
  const live = { ...baseConfig(), fakeMode: false, fakeReason: "", searchProvider: "anthropic" as const, anthropicKey: "sk-ant-test-not-used" };
  const s = await start(demoConfig(), live);
  const b = browser(s.base);
  const h = (await b.json("/api/health")).data;
  assert.equal(h.fake, false);
  assert.equal(h.fakeReason, "");
  assert.equal(h.search, "anthropic-web-search");
  const st = (await b.json("/api/demo/status")).data;
  assert.equal(st.fake, false);
  assert.equal(st.search, "anthropic-web-search");
  await stop(s);
  const offline = await start(demoConfig());
  const o = (await browser(offline.base).json("/api/health")).data;
  assert.equal(o.fake, true);
  assert.equal(o.search, "fake");
  assert.match(o.fakeReason, /offline test web/);
  await stop(offline);
});

test("single-user app: an empty message is refused with 400 before any session is created", async () => {
  const dir = mkdtempSync(join(tmpdir(), "minimi-empty-test-"));
  dirs.push(dir);
  const dbPath = join(dir, "m.db");
  const s = await start(null, baseConfig(dbPath));
  const b = browser(s.base);
  const r = await b.chat("   ");
  assert.equal(r.status, 400);
  assert.match(String(r.error?.error ?? JSON.stringify(r.error)), /Say something first/);
  const store = new Store(dbPath);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n, 0, "no empty session was created");
  store.db.close();
  await stop(s);
});
