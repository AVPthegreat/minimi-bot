// All runtime settings in one place, read once from the environment (.env is loaded if present).
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

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
  searchProvider: "tavily" | "fake";
  tavilyKey: string;
  watchEnabled: boolean;
  watchAfterDays: number;
  watchMaxSearches: number;
}

export function loadConfig(): Config {
  const anthropicKey = env("ANTHROPIC_API_KEY");
  const tavilyKey = env("TAVILY_API_KEY");
  const forcedFake = env("FAKE_MODE") === "1";
  const missing = [!anthropicKey && "ANTHROPIC_API_KEY", !tavilyKey && "TAVILY_API_KEY"].filter(Boolean);
  const fakeMode = forcedFake || missing.length > 0;
  const fakeReason = forcedFake ? "FAKE_MODE=1" : missing.length ? `missing ${missing.join(", ")}` : "";
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
    searchProvider: fakeMode ? "fake" : "tavily",
    tavilyKey,
    watchEnabled: env("WATCH_ENABLED", "1") !== "0",
    watchAfterDays: Number(env("WATCH_AFTER_DAYS", "3")),
    watchMaxSearches: Number(env("WATCH_MAX_SEARCHES", "3")),
  };
}
