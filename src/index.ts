// Programmatic entry point: build an agent from config (or from your own parts) and talk to it.
//
//   import { createAgent } from "./src/index.ts";
//   const { agent } = createAgent();
//   const s = agent.newSession();
//   for await (const ev of agent.chat(s.id, "Postgres hosting prices?")) if (ev.type === "delta") process.stdout.write(ev.text);

import { Agent } from "./agent.ts";
import { type Config, loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { AnthropicLLM } from "./llm/anthropic.ts";
import { FakeLLM } from "./llm/fake.ts";
import type { LLM } from "./llm/types.ts";
import { FakeSearch } from "./search/fake.ts";
import { TavilySearch } from "./search/tavily.ts";
import type { SearchProvider } from "./search/types.ts";
import { FakeClock, SystemClock } from "./time.ts";

export { Agent, type AgentEvent } from "./agent.ts";
export { Store } from "./db.ts";
export { FakeClock, SystemClock, type Clock } from "./time.ts";
export { FakeLLM } from "./llm/fake.ts";
export { FakeSearch } from "./search/fake.ts";
export type { LLM } from "./llm/types.ts";
export type { SearchProvider } from "./search/types.ts";

export interface Built {
  agent: Agent;
  /** A settable clock (set when MINIMI_NOW is given or fake mode is on), else null. */
  clock: FakeClock | null;
  config: Config;
  llm: LLM;
  search: SearchProvider;
}

export function createAgent(config: Config = loadConfig()): Built {
  // In fake mode the clock is settable from the UI so multi-day memory can be demonstrated.
  const clock = config.fixedNow || config.allowClockOverride ? new FakeClock(config.fixedNow || undefined) : null;
  const realClock = clock ?? new SystemClock();
  const llm: LLM = config.fakeMode
    ? new FakeLLM()
    : new AnthropicLLM({
        apiKey: config.anthropicKey,
        answerModel: config.answerModel,
        fastModel: config.fastModel,
        answerEffort: config.answerEffort,
        fastSpeed: config.fastSpeed,
      });
  const search: SearchProvider = config.fakeMode ? new FakeSearch(realClock) : new TavilySearch(config.tavilyKey);
  const store = new Store(config.dbPath);
  const agent = new Agent({
    store,
    llm,
    search,
    clock: realClock,
    timezone: config.timezone,
    watch: { enabled: config.watchEnabled, afterDays: config.watchAfterDays, maxSearches: config.watchMaxSearches },
  });
  return { agent, clock, config, llm, search };
}
