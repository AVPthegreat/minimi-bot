// Site logos for the UI (search steps, source pills), served from our own origin so the browser never
// calls a third party. The server fetches the icon once per domain, checks it, caches it (memory +
// disk) and falls back to a generated monogram, so an <img> always gets a valid picture.
//
// Order: the site's own icon links (apple-touch-icon / largest <link rel=icon>), then /favicon.ico,
// then a public favicon service. Safety: hostnames only (no IP literals, no ports), https only,
// every DNS answer must be a public address (checked at connect time, so DNS rebinding can't slip
// through), at most 3 redirects, a timeout, a size cap, and only real raster images (sniffed from
// the bytes; SVG is refused because it can carry script).

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";

export interface Logo {
  type: string;
  body: Buffer;
}

export interface Fetched {
  status: number;
  type: string;
  body: Buffer;
  url: string;
}

/** Fetches a URL (https, public addresses only); null on any failure. Injectable for tests. */
export type Fetcher = (url: string, opts: { maxBytes: number; accept: string }) => Promise<Fetched | null>;

const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL_SUFFIX = /\.(?:local|localhost|internal|lan|home\.arpa|test|invalid|example)$/;

/** A plain public hostname like "neon.com" (lowercase); null for anything else. */
export function cleanDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const d = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_RE.test(d) || LOCAL_SUFFIX.test(d) || isIP(d)) return null;
  return d;
}

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 127], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  PRIVATE.addSubnet(net, bits, "ipv6");
}

/** True only for addresses on the public internet (no loopback, private, link-local, CGNAT, multicast...). */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !PRIVATE.check(ip, "ipv4");
  if (family === 6) {
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]!);
    return !PRIVATE.check(ip, "ipv6");
  }
  return false;
}

/** A dns.lookup replacement for https.request that refuses a host if any of its addresses is not public. */
export function publicOnlyLookup(resolve: typeof dnsLookup = dnsLookup) {
  return (hostname: string, options: { all?: boolean }, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => {
    resolve(hostname, { all: true }, (err, addrs) => {
      if (err) return cb(err, "");
      const list = addrs as LookupAddress[];
      if (!list.length || list.some((a) => !isPublicAddress(a.address))) return cb(new Error(`refused: ${hostname} is not a public host`), "");
      if (options?.all) cb(null, list);
      else cb(null, list[0]!.address, list[0]!.family);
    });
  };
}

/** The real fetcher: https only, default port, public addresses, 3 redirects, timeout, size cap. */
export function httpsFetcher(timeoutMs = 4000): Fetcher {
  const lookup = publicOnlyLookup();
  const once = (url: URL, maxBytes: number, accept: string, signal: AbortSignal) =>
    new Promise<{ status: number; type: string; location?: string; body: Buffer }>((resolve, reject) => {
      const req = request(url, { method: "GET", lookup: lookup as never, signal, headers: { accept, "user-agent": "minimi-logo/1.0" } }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, type: "", location: res.headers.location, body: Buffer.alloc(0) });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(new Error("too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
  return async (raw, { maxBytes, accept }) => {
    const signal = AbortSignal.timeout(timeoutMs);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    for (let hop = 0; hop <= 3; hop++) {
      if (url.protocol !== "https:" || url.port !== "" || url.username || isIP(url.hostname.replace(/^\[|\]$/g, ""))) return null;
      try {
        const r = await once(url, maxBytes, accept, signal);
        if (r.location) {
          url = new URL(r.location, url);
          continue;
        }
        return { status: r.status, type: r.type, body: r.body, url: url.href };
      } catch {
        return null;
      }
    }
    return null;
  };
}

/** The image type from its first bytes; null if it is not a raster image we serve. */
export function sniffImage(b: Buffer): string | null {
  if (b.length < 16) return null;
  if (b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "image/x-icon";
  if (b.toString("latin1", 0, 3) === "GIF") return "image/gif";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Icon URLs a page declares, best first (apple-touch-icon, then the largest icon); SVG is skipped. */
export function iconLinks(html: string, base: string): string[] {
  const found: Array<{ href: string; score: number }> = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(1).find((x) => x !== undefined) ?? "";
    const rel = attr("rel").toLowerCase();
    const href = attr("href").replace(/&amp;/g, "&");
    if (!href || !/\bicon\b|apple-touch-icon/.test(rel)) continue;
    if (/svg/i.test(attr("type")) || /\.svg(?:$|\?)/i.test(href) || /^data:/i.test(href)) continue;
    const size = Math.max(0, ...(attr("sizes").match(/\d+/g) ?? []).map(Number));
    const score = (rel.includes("apple-touch-icon") ? 1000 : 0) + (size || 16);
    try {
      found.push({ href: new URL(href, base).href, score });
    } catch {
      /* a broken href is skipped */
    }
  }
  return [...new Set(found.sort((a, b) => b.score - a.score).map((f) => f.href))];
}

const PALETTE = ["#6d28d9", "#be185d", "#0e7490", "#1d4ed8", "#047857", "#b45309", "#7c3aed", "#c2410c"];

/** A generated letter tile: always valid, nothing fetched. The domain was validated, so the letter is [a-z0-9]. */
export function monogram(domain: string): Logo {
  const letter = (domain.replace(/^www\./, "")[0] ?? "?").toUpperCase();
  let h = 0;
  for (const ch of domain) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const color = PALETTE[h % PALETTE.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${color}"/><text x="32" y="43" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="30" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text></svg>`;
  return { type: "image/svg+xml", body: Buffer.from(svg) };
}

export interface LogoServiceOptions {
  /** Disk cache folder (null = memory only). */
  dir: string | null;
  /** Off = monograms only, no network (LOGO_FETCH=0). */
  enabled: boolean;
  fetcher?: Fetcher;
  /** Public fallback service; `{domain}` is replaced. */
  fallback?: string;
  now?: () => number;
}

const MAX_LOGO_BYTES = 200 * 1024;
const MAX_PAGE_BYTES = 300 * 1024;
const HIT_TTL_MS = 7 * 86400_000;
const MISS_TTL_MS = 86400_000;
const MEMORY_ENTRIES = 500;
const MAX_PARALLEL = 6;

export class LogoService {
  private readonly memory = new Map<string, { logo: Logo | null; at: number }>();
  private readonly inflight = new Map<string, Promise<Logo | null>>();
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly opts: LogoServiceOptions) {
    this.fetcher = opts.fetcher ?? httpsFetcher();
    this.now = opts.now ?? Date.now;
    if (opts.dir) mkdirSync(opts.dir, { recursive: true });
  }

  /** The site's logo, or null when it has none we can use (the caller then serves `monogram`). */
  async get(domain: string): Promise<Logo | null> {
    const mem = this.memory.get(domain);
    if (mem && this.now() - mem.at < (mem.logo ? HIT_TTL_MS : MISS_TTL_MS)) return mem.logo;
    const disk = this.readDisk(domain);
    if (disk !== undefined) return this.remember(domain, disk);
    if (!this.opts.enabled) return null;
    let p = this.inflight.get(domain);
    if (!p) {
      p = this.limited(() => this.fetchLogo(domain))
        .catch(() => null)
        .then((logo) => {
          this.writeDisk(domain, logo);
          return this.remember(domain, logo);
        })
        .finally(() => this.inflight.delete(domain));
      this.inflight.set(domain, p);
    }
    return p;
  }

  private async fetchLogo(domain: string): Promise<Logo | null> {
    const image = async (url: string): Promise<Logo | null> => {
      const r = await this.fetcher(url, { maxBytes: MAX_LOGO_BYTES, accept: "image/*" });
      if (!r || r.status !== 200) return null;
      const type = sniffImage(r.body);
      return type ? { type, body: r.body } : null;
    };
    const page = await this.fetcher(`https://${domain}/`, { maxBytes: MAX_PAGE_BYTES, accept: "text/html" });
    if (page && page.status === 200 && /html/i.test(page.type)) {
      for (const href of iconLinks(page.body.toString("utf8"), page.url).slice(0, 3)) {
        const logo = await image(href);
        if (logo) return logo;
      }
    }
    const ico = await image(`https://${domain}/favicon.ico`);
    if (ico) return ico;
    return this.opts.fallback ? image(this.opts.fallback.replace("{domain}", encodeURIComponent(domain))) : null;
  }

  private async limited<T>(job: () => Promise<T>): Promise<T> {
    while (this.running >= MAX_PARALLEL) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await job();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private remember(domain: string, logo: Logo | null): Logo | null {
    this.memory.delete(domain);
    this.memory.set(domain, { logo, at: this.now() });
    if (this.memory.size > MEMORY_ENTRIES) this.memory.delete(this.memory.keys().next().value!);
    return logo;
  }

  /** undefined = not cached (or expired); null = cached "no logo". */
  private readDisk(domain: string): Logo | null | undefined {
    if (!this.opts.dir) return undefined;
    for (const [file, hit] of [[`${domain}.img`, true], [`${domain}.none`, false]] as const) {
      try {
        const path = join(this.opts.dir, file);
        if (this.now() - statSync(path).mtimeMs > (hit ? HIT_TTL_MS : MISS_TTL_MS)) continue;
        if (!hit) return null;
        const body = readFileSync(path);
        const type = sniffImage(body);
        return type ? { type, body } : undefined;
      } catch {
        /* not cached */
      }
    }
    return undefined;
  }

  private writeDisk(domain: string, logo: Logo | null): void {
    if (!this.opts.dir) return;
    try {
      writeFileSync(join(this.opts.dir, `${domain}.${logo ? "img" : "none"}`), logo ? logo.body : "");
    } catch {
      /* the memory cache still works */
    }
  }
}
