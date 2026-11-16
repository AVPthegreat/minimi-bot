// Settings from the environment: sane defaults, and a clear error instead of a silently broken value.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadConfig, systemTimezone } from "../src/config.ts";

const KEYS = ["USER_TIMEZONE", "ANSWER_EFFORT", "PORT", "ANSWER_MAX_SEARCHES", "MAX_SPEND_USD", "WATCH_AFTER_DAYS", "WATCH_MAX_SEARCHES"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
process.env.FAKE_MODE = "1";

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function withEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return loadConfig();
}

test("config: the time zone defaults to the system's own zone, and USER_TIMEZONE overrides it", () => {
  assert.equal(withEnv({ USER_TIMEZONE: undefined }).timezone, systemTimezone());
  assert.equal(systemTimezone(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(withEnv({ USER_TIMEZONE: "" }).timezone, systemTimezone(), "an empty value (as in .env.example) means the system zone");
  assert.equal(withEnv({ USER_TIMEZONE: "Europe/Berlin" }).timezone, "Europe/Berlin");
  assert.throws(() => withEnv({ USER_TIMEZONE: "Mars/Olympus" }), /USER_TIMEZONE must be an IANA time zone/);
});

test("config: ANSWER_EFFORT must be low, medium or high", () => {
  assert.equal(withEnv({ ANSWER_EFFORT: undefined }).answerEffort, "medium");
  assert.equal(withEnv({ ANSWER_EFFORT: "high" }).answerEffort, "high");
  assert.throws(() => withEnv({ ANSWER_EFFORT: "max" }), /ANSWER_EFFORT must be low, medium or high \(got "max"\)/);
});

test("config: PORT and the other numbers are checked, never NaN", () => {
  assert.equal(withEnv({ PORT: undefined }).port, 3000);
  assert.equal(withEnv({ PORT: "8080" }).port, 8080);
  assert.throws(() => withEnv({ PORT: "eighty" }), /PORT must be a whole number from 0 to 65535 \(got "eighty"\)/);
  assert.throws(() => withEnv({ PORT: "70000" }), /PORT must be a whole number/);
  delete process.env.PORT;
  assert.equal(withEnv({ ANSWER_MAX_SEARCHES: "9" }).answerMaxSearches, 5, "the loop bound is capped at 5");
  assert.equal(withEnv({ ANSWER_MAX_SEARCHES: "0" }).answerMaxSearches, 0);
  assert.throws(() => withEnv({ ANSWER_MAX_SEARCHES: "lots" }), /ANSWER_MAX_SEARCHES must be a whole number/);
  delete process.env.ANSWER_MAX_SEARCHES;
  assert.throws(() => withEnv({ MAX_SPEND_USD: "five" }), /MAX_SPEND_USD must be a number/);
  assert.equal(withEnv({ MAX_SPEND_USD: "2.5" }).maxSpendUsd, 2.5);
  delete process.env.MAX_SPEND_USD;
  assert.throws(() => withEnv({ WATCH_AFTER_DAYS: "soon" }), /WATCH_AFTER_DAYS must be a whole number/);
});
