// The visitor cookie: a random 128-bit id plus an HMAC-SHA256 tag, so a visitor cannot pick or guess
// someone else's id. Nothing else is in it; all state lives server-side under that id.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const VISITOR_COOKIE = "minimi_visitor";
export const ACCESS_COOKIE = "minimi_access";
const ID_RE = /^[0-9a-f]{32}$/;

export const newVisitorId = (): string => randomBytes(16).toString("hex");
export const isVisitorId = (s: string): boolean => ID_RE.test(s);

function tag(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signVisitor(id: string, secret: string): string {
  return `${id}.${tag(secret, `visitor:${id}`)}`;
}

/**
 * The visitor id if the value is well-formed and signed with the current (or, during a rotation,
 * the previous) secret; `resign` says the cookie should be re-issued with the current secret.
 */
export function verifyVisitor(value: string | undefined, secrets: string[]): { id: string; resign: boolean } | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot < 0) return null;
  const id = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!isVisitorId(id)) return null;
  for (let i = 0; i < secrets.length; i++) {
    const s = secrets[i];
    if (s && same(sig, tag(s, `visitor:${id}`))) return { id, resign: i > 0 };
  }
  return null;
}

/** Proof that this browser gave the access code (changes when the code or the secret changes). */
export function accessToken(code: string, secret: string): string {
  return tag(secret, `access:${code}`);
}

export function checkAccess(value: string | undefined, code: string, secrets: string[]): boolean {
  if (!value) return false;
  return secrets.some((s) => !!s && same(value, accessToken(code, s)));
}

export function codeMatches(given: string, code: string): boolean {
  // Compare digests so the length of the real code does not leak through timing.
  const h = (s: string) => createHmac("sha256", "minimi-access-code").update(s).digest();
  return timingSafeEqual(h(given), h(code));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      /* a malformed value is ignored */
    }
  }
  return out;
}

export function cookieHeader(name: string, value: string, opts: { maxAgeSec: number; secure: boolean }): string {
  return `${name}=${value}; Path=/; Max-Age=${Math.floor(opts.maxAgeSec)}; HttpOnly; SameSite=Lax${opts.secure ? "; Secure" : ""}`;
}
