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
  /** Web searches the answer model may run on its own per turn, only when the planned searches found nothing. */
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
  return {
    port: Number(env("PORT", "3000")),
    host: env("HOST", "127.0.0.1"),
    dbPath: env("DB_PATH", "data/minimi.db"),
    timezone: env("USER_TIMEZONE", "Asia/Kolkata"),
    fixedNow: env("MINIMI_NOW"),
    allowClockOverride: fakeMode || env("ALLOW_CLOCK_OVERRIDE") === "1",
    fakeMode,
    fakeReason,
    anthropicKey,
    answerModel: env("ANSWER_MODEL", "claude-opus-5-5"),
    fastModel: env("FAST_MODEL", "claude-haiku-5-5"),
    answerEffort: (env("ANSWER_EFFORT", "medium") as Effort),
    fastSpeed: env("FAST_OUTPUT") === "1",
    searchProvider,
    searchModel: env("SEARCH_MODEL", "claude-haiku-5-5"),
    tavilyKey,
    maxSpendUsd: cap ? Number(cap) : null,
    answerMaxSearches: Math.max(0, Math.min(5, Number(env("ANSWER_MAX_SEARCHES", "3")))),
    watchEnabled: env("WATCH_ENABLED", "1") !== "0",
    watchAfterDays: Number(env("WATCH_AFTER_DAYS", "3")),
    watchMaxSearches: Number(env("WATCH_MAX_SEARCHES", "3")),
    logoFetch: env("LOGO_FETCH", "1") !== "0",
  };
}
