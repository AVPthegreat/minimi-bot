// The typed events the web UI draws from (search steps with site logos), and the logo endpoint's
// safety rules. Status lines stay as they were, so older clients keep working.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { BrandBook } from "../src/brand.ts";
import { Store } from "../src/db.ts";
import { FakeLLM } from "../src/llm/fake.ts";
import { type Fetcher, LogoService, cleanDomain, iconLinks, isPublicAddress, monogram, publicOnlyLookup, sniffImage } from "../src/logo.ts";
import { FakeSearch } from "../src/search/fake.ts";
import { FakeClock } from "../src/time.ts";

async function run(agent: Agent, sid: string, text: string) {
  const events: AgentEvent[] = [];
  for await (const e of agent.chat(sid, text)) events.push(e);
  await agent.idle();
  return events;
}

function setup(llm?: FakeLLM) {
  const clock = new FakeClock("2026-11-10T10:00:00+05:30");
  const store = new Store(":memory:");
  const agent = new Agent({ store, llm: llm ?? new FakeLLM(), search: new FakeSearch(clock), clock, timezone: "Asia/Kolkata" });
  return { clock, agent };
}

const steps = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "search" ? [e] : []));

test("search steps: every planned search is announced as running, then finishes with a result count and a site", async () => {
  const { agent } = setup();
  const events = await run(agent, agent.newSession().id, "What does Postgres hosting cost on Supabase, Neon and Railway?");
  const s = steps(events);
  const running = s.filter((e) => e.state === "running");
  const done = s.filter((e) => e.state === "done");
  assert.equal(running.length, 4);
  assert.equal(done.length, 4);
  for (const d of done) {
    assert.ok(s.indexOf(running.find((r) => r.query === d.query)!) < s.indexOf(d), `${d.query} ran before it finished`);
    assert.equal(typeof d.results, "number");
  }
  // Known products show their own site's logo while still searching.
  assert.equal(running.find((r) => r.query.startsWith("Neon"))?.domain, "neon.com");
  assert.equal(done.find((r) => r.query.startsWith("Supabase"))?.domain, "supabase.com");
  // The step events come before the answer, and the old status lines are still sent.
  const kinds = events.map((e) => e.type);
  assert.ok(kinds.lastIndexOf("search") < kinds.indexOf("delta"));
  assert.equal(events.filter((e) => e.type === "status" && /searches done\)/.test(e.text)).length, 4);
});

test("search steps: a re-check announces its searches too", async () => {
  const { agent, clock } = setup();
  await run(agent, agent.newSession().id, "What does Postgres hosting cost on Supabase, Neon and Railway?");
  clock.set("2026-11-18T09:00:00+05:30");
  const events = await run(agent, agent.newSession().id, "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
  const s = steps(events);
  assert.ok(s.some((e) => e.state === "running"));
  assert.equal(s.filter((e) => e.state === "running").length, s.filter((e) => e.state === "done" || e.state === "failed").length);
});

test("search steps: speculative searches are marked cancelled when no search is needed, and nothing finishes after that", async () => {
  // A router that answers "chat" for a message the rules could not place.
  class ChatRouter extends FakeLLM {
    override async route() {
      return { intent: "chat" as const, searchQueries: [], sinceDays: 0, memoryQuery: "", highStakes: false };
    }
  }
  const { agent } = setup(new ChatRouter());
  const events = await run(agent, agent.newSession().id, "Write me a two-line poem about Supabase, Neon and Railway");
  const s = steps(events);
  const cancelled = s.filter((e) => e.state === "cancelled");
  assert.ok(cancelled.length >= 1);
  const lastCancel = s.indexOf(cancelled.at(-1)!);
  assert.ok(!s.slice(lastCancel).some((e) => e.state === "done" || e.state === "running"));
});

test("brand book: seeded names, learned official sites, and the top result otherwise", () => {
  const b = new BrandBook();
  assert.equal(b.domainFor("Zoho CRM pricing"), "zoho.com");
  assert.equal(b.domainFor("What does it cost?"), undefined);
  assert.equal(b.fromResults("Acmebase pricing", [{ title: "x", url: "https://blog.example.org/a", snippet: "" }, { title: "y", url: "https://www.acmebase.io/pricing", snippet: "" }]), "acmebase.io");
  assert.equal(b.domainFor("Acmebase plans"), "acmebase.io");
  assert.equal(b.fromResults("Postgres hosting", [{ title: "x", url: "https://www.example.org/a", snippet: "" }]), undefined, "no logo rather than a stranger's");
});

// ---- Logos: only public hostnames, only real images, cached, with a letter tile when there is none.

test("logo: domains are validated (no IPs, ports, local names, schemes)", () => {
  assert.equal(cleanDomain("Neon.com"), "neon.com");
  for (const bad of ["localhost", "127.0.0.1", "10.0.0.8", "[::1]", "neon.com:8080", "http://neon.com", "a", "intranet.local", "x.internal", "neon..com", "", null, 42]) {
    assert.equal(cleanDomain(bad), null, String(bad));
  }
});

test("logo: only public addresses are allowed, checked at connect time", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["104.18.1.1", "8.8.8.8", "2606:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
  // A host whose DNS answer includes a private address is refused (DNS rebinding).
  const fakeDns = ((_h: string, _o: unknown, cb: (e: Error | null, a: Array<{ address: string; family: number }>) => void) =>
    cb(null, [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }])) as never;
  const err = await new Promise<Error | null>((r) => publicOnlyLookup(fakeDns)("evil.example.com", {}, (e) => r(e)));
  assert.match(String(err?.message), /not a public host/);
});

test("logo: images are sniffed from their bytes; SVG and HTML are refused", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  assert.equal(sniffImage(png), "image/png");
  assert.equal(sniffImage(Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.alloc(16)])), "image/x-icon");
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(sniffImage(Buffer.from("<!doctype html><html><body>hi</body></html>")), null);
});

test("logo: icon links are read best-first, svg and data: skipped", () => {
  const html = `<link rel="icon" href="/f16.png" sizes="16x16"><link rel='apple-touch-icon' href='/apple.png'>
    <link rel="icon" type="image/svg+xml" href="/logo.svg"><link rel="icon" href="data:image/png;base64,xx"><link rel="shortcut icon" href="https://cdn.x.com/f.ico">`;
  assert.deepEqual(iconLinks(html, "https://neon.com/"), ["https://neon.com/apple.png", "https://neon.com/f16.png", "https://cdn.x.com/f.ico"]);
});

test("logo: fetched once, cached on disk, falls back in order, and remembers a miss", async () => {
  const dir = mkdtempSync(join(tmpdir(), "minimi-logo-"));
  try {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(40)]);
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      if (url === "https://neon.com/") return { status: 200, type: "text/html", body: Buffer.from('<link rel="icon" href="/i.png">'), url };
      if (url === "https://neon.com/i.png") return { status: 200, type: "image/png", body: png, url };
      if (url.includes("icons.example")) return { status: 200, type: "image/x-icon", body: Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.alloc(40)]), url };
      return null;
    };
    const opts = { dir, enabled: true, fetcher, fallback: "https://icons.example/{domain}.ico" };
    const svc = new LogoService(opts);
    const [a, b] = await Promise.all([svc.get("neon.com"), svc.get("neon.com")]);
    assert.equal(a?.type, "image/png");
    assert.equal(b, a);
    assert.equal(calls.filter((c) => c === "https://neon.com/i.png").length, 1, "concurrent requests share one fetch");
    // A fresh service (a restart) reads the disk cache: no network.
    calls.length = 0;
    assert.equal((await new LogoService(opts).get("neon.com"))?.type, "image/png");
    assert.deepEqual(calls, []);
    // No icon on the site: /favicon.ico, then the public fallback.
    assert.equal((await svc.get("railway.com"))?.type, "image/x-icon");
    assert.deepEqual(calls, ["https://railway.com/", "https://railway.com/favicon.ico", "https://icons.example/railway.com.ico"]);
    // Nothing anywhere: a remembered miss (the endpoint then serves a letter tile).
    const none = new LogoService({ dir, enabled: true, fetcher: async () => null });
    assert.equal(await none.get("nothing.dev"), null);
    calls.length = 0;
    assert.equal(await new LogoService(opts).get("nothing.dev"), null);
    assert.deepEqual(calls, [], "the miss is cached");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logo: switched off means letter tiles only, never the network", async () => {
  const svc = new LogoService({ dir: null, enabled: false, fetcher: async () => assert.fail("no network when off") });
  assert.equal(await svc.get("neon.com"), null);
  const tile = monogram("neon.com");
  assert.equal(tile.type, "image/svg+xml");
  assert.match(tile.body.toString(), />N<\/text>/);
  assert.doesNotMatch(tile.body.toString(), /script/i);
});
