// Hosted demo settings (DEMO_MODE=1). Off by default: without DEMO_MODE the app is the single-user one.
// Read once at start; a bad value refuses to start rather than running a public endpoint half-configured.

export interface DemoConfig {
  dataDir: string;
  /** HMAC key for the visitor cookie (32+ characters). */
  cookieSecret: string;
  /** The previous key during a rotation: still accepted, cookies are re-signed with the new one. */
  cookieSecretPrevious: string;
  /** Force the Secure cookie flag (it is also set when a trusted proxy says the request was https). */
  cookieSecure: boolean;
  maxVisitors: number;
  ttlDays: number;
  /** Visitors kept open in memory (agent + SQLite handle); older ones are closed. */
  openVisitors: number;
  budgetUsd: number;
  /** Held back per running answer when deciding whether a new message may start (overshoot guard). */
  turnReserveUsd: number;
  msgsPerVisitorPerDay: number;
  ipMsgsPerMin: number;
  ipRequestsPerMin: number;
  maxMessageChars: number;
  maxBodyBytes: number;
  maxStreamsGlobal: number;
  streamTimeoutMs: number;
  trustProxy: boolean;
  accessCode: string;
}

type Env = Record<string, string | undefined>;

function str(env: Env, name: string, fallback = ""): string {
  const v = env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

function num(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = str(env, name);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number from ${min} to ${max} (got "${raw}")`);
  return n;
}

export function demoEnabled(env: Env = process.env): boolean {
  return str(env, "DEMO_MODE") === "1";
}

/** The demo settings, or null when DEMO_MODE is not 1. Throws (refuse to start) on a missing or weak secret. */
export function loadDemoConfig(env: Env = process.env): DemoConfig | null {
  if (!demoEnabled(env)) return null;
  const cookieSecret = str(env, "DEMO_COOKIE_SECRET");
  if (cookieSecret.length < 32) {
    throw new Error("DEMO_MODE=1 needs DEMO_COOKIE_SECRET (32+ random characters, e.g. `openssl rand -hex 32`). Refusing to start.");
  }
  const previous = str(env, "DEMO_COOKIE_SECRET_PREVIOUS");
  if (previous && previous.length < 32) throw new Error("DEMO_COOKIE_SECRET_PREVIOUS must also be 32+ characters.");
  return {
    dataDir: str(env, "DATA_DIR", "data/demo"),
    cookieSecret,
    cookieSecretPrevious: previous,
    cookieSecure: str(env, "DEMO_COOKIE_SECURE") === "1",
    maxVisitors: num(env, "DEMO_MAX_VISITORS", 500, 1, 1_000_000),
    ttlDays: num(env, "DEMO_TTL_DAYS", 7, 0.0001, 365),
    openVisitors: num(env, "DEMO_OPEN_VISITORS", 200, 1, 10_000),
    budgetUsd: num(env, "DEMO_BUDGET_USD", 18, 0, 1_000_000),
    turnReserveUsd: num(env, "DEMO_TURN_RESERVE_USD", 0.25, 0, 100),
    msgsPerVisitorPerDay: num(env, "DEMO_MSGS_PER_VISITOR_PER_DAY", 40, 1, 100_000),
    ipMsgsPerMin: num(env, "DEMO_IP_MSGS_PER_MIN", 10, 1, 10_000),
    ipRequestsPerMin: num(env, "DEMO_IP_REQUESTS_PER_MIN", 240, 1, 100_000),
    maxMessageChars: num(env, "DEMO_MAX_MESSAGE_CHARS", 2000, 1, 4000),
    maxBodyBytes: num(env, "DEMO_MAX_BODY_BYTES", 16 * 1024, 1024, 64 * 1024),
    maxStreamsGlobal: num(env, "DEMO_MAX_STREAMS", 8, 1, 1000),
    streamTimeoutMs: num(env, "DEMO_STREAM_TIMEOUT_MS", 120_000, 1000, 600_000),
    trustProxy: str(env, "DEMO_TRUST_PROXY") === "1",
    accessCode: str(env, "DEMO_ACCESS_CODE"),
  };
}
