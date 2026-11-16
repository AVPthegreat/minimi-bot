// All runtime settings in one place, read once from the environment (.env is loaded if present).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/** The project's .env (next to package.json), whatever directory the process was started from. */
const ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));
export const envFileFound = existsSync(ENV_FILE);
/** Variable names (never values) defined in .env, for the "why am I in fake mode?" message. */
let envFileNames: string[] = [];
let envFileBytes = 0;
if (envFileFound) {
  envFileBytes = readFileSync(ENV_FILE).length;
  envFileNames = Object.keys(parseEnv(readFileSync(ENV_FILE, "utf8")));
  // Values from the file fill variables that are unset or empty in the environment; a non-empty
  // value already in the environment wins (so `FAKE_MODE=1 npm run dev` works as expected).
  for (const [k, v] of Object.entries(parseEnv(readFileSync(ENV_FILE, "utf8")))) {
    if (!process.env[k]) process.env[k] = v;
  }
}

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

export type Effort = "low" | "medium" | "high";
const EFFORTS: readonly Effort[] = ["low", "medium", "high"];

/** The machine's own time zone (what "today" means for the person running it), e.g. "Europe/Berlin". */
export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** An IANA zone name the runtime knows, or a clear error naming the variable. */
function checkedTimezone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw new Error(`USER_TIMEZONE must be an IANA time zone like "Asia/Kolkata" or "Europe/Berlin" (got "${tz}")`);
  }
}

function spendCap(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`MAX_SPEND_USD must be a number of dollars, 0 or more (got "${raw}")`);
  return n;
}

/** A whole number in [min, max], or a clear error naming the variable (never a silent NaN). */
function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name, String(fallback));
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max} (got "${raw}")`);
  return n;
}

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  timezone: string;
  /** Fixed "now" (ISO 8601) for demos and evals; empty = the real clock. */
  fixedNow: string;
  /** Lets the UI move the clock (demo of multi-day memory). Always on in fake mode. */
  allowClockOverride: boolean;
  fakeMode: boolean;
  /** Why fake mode is on, shown in the UI. */
  fakeReason: string;
  anthropicKey: string;
  answerModel: string;
  fastModel: string;
  answerEffort: Effort;
  fastSpeed: boolean;
  searchProvider: "tavily" | "anthropic" | "fake";
  /** Model that runs Anthropic's server-side web_search when that provider is used. */
  searchModel: string;
  tavilyKey: string;
  /** Hard cap on Anthropic spend per process, in USD (empty = no cap). */
  maxSpendUsd: number | null;
  /** Follow-up web searches the answer model may run itself per turn, after the planned round (the agent loop's bound). */
  answerMaxSearches: number;
  watchEnabled: boolean;
  watchAfterDays: number;
  watchMaxSearches: number;
  /** Fetch site logos for the UI (server-side, cached); off = generated letter tiles only. */
  logoFetch: boolean;
}

export function loadConfig(): Config {
  const anthropicKey = env("ANTHROPIC_API_KEY");
  const tavilyKey = env("TAVILY_API_KEY");
  const forcedFake = env("FAKE_MODE") === "1";
  // Only the Anthropic key is required: without a Tavily key, search runs on Anthropic's web_search tool.
  const fakeMode = forcedFake || !anthropicKey;
  const fakeReason = forcedFake ? "FAKE_MODE=1" : !anthropicKey ? `missing ANTHROPIC_API_KEY (.env ${envFileFound ? `found (${envFileBytes} bytes); it sets: ${envFileNames.join(", ") || "no variables (expected lines like NAME=value)"}` : "not found"})` : "";
  const wanted = env("SEARCH_PROVIDER", "auto");
  if (!["auto", "tavily", "anthropic"].includes(wanted)) throw new Error(`SEARCH_PROVIDER must be auto, tavily or anthropic (got "${wanted}")`);
  if (wanted === "tavily" && !tavilyKey && !fakeMode) throw new Error("SEARCH_PROVIDER=tavily needs TAVILY_API_KEY");
  const searchProvider = fakeMode ? "fake" : wanted === "auto" ? (tavilyKey ? "tavily" : "anthropic") : (wanted as "tavily" | "anthropic");
  const cap = env("MAX_SPEND_USD");
  const effort = env("ANSWER_EFFORT", "medium");
  if (!EFFORTS.includes(effort as Effort)) throw new Error(`ANSWER_EFFORT must be low, medium or high (got "${effort}")`);
  return {
    port: intEnv("PORT", 3000, 0, 65535),
    host: env("HOST", "127.0.0.1"),
    dbPath: env("DB_PATH", "data/minimi.db"),
    // The person's zone decides what "today" and "last Tuesday" mean: the system's, unless USER_TIMEZONE says otherwise.
    timezone: checkedTimezone(env("USER_TIMEZONE", systemTimezone())),
    fixedNow: env("MINIMI_NOW"),
    allowClockOverride: fakeMode || env("ALLOW_CLOCK_OVERRIDE") === "1",
    fakeMode,
    fakeReason,
    anthropicKey,
    answerModel: env("ANSWER_MODEL", "claude-opus-5-5"),
    fastModel: env("FAST_MODEL", "claude-haiku-5-5"),
    answerEffort: effort as Effort,
    fastSpeed: env("FAST_OUTPUT") === "1",
    searchProvider,
    searchModel: env("SEARCH_MODEL", "claude-haiku-5-5"),
    tavilyKey,
    maxSpendUsd: cap ? spendCap(cap) : null,
    answerMaxSearches: Math.min(5, intEnv("ANSWER_MAX_SEARCHES", 3, 0, Number.MAX_SAFE_INTEGER)),
    watchEnabled: env("WATCH_ENABLED", "1") !== "0",
    watchAfterDays: intEnv("WATCH_AFTER_DAYS", 3, 0, 3650),
    watchMaxSearches: intEnv("WATCH_MAX_SEARCHES", 3, 0, 20),
    logoFetch: env("LOGO_FETCH", "1") !== "0",
  };
}
