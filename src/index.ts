// Programmatic entry point: build an agent from config (or from your own parts) and talk to it.
//
//   import { createAgent } from "./src/index.ts";
//   const { agent } = createAgent();
//   const s = agent.newSession();
//   for await (const ev of agent.chat(s.id, "Postgres hosting prices?")) if (ev.type === "delta") process.stdout.write(ev.text);

import Anthropic from "@anthropic-ai/sdk";
import { Agent } from "./agent.ts";
import { type Config, loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { AnthropicLLM } from "./llm/anthropic.ts";
import { FakeLLM } from "./llm/fake.ts";
import type { LLM } from "./llm/types.ts";
import { FakeSearch } from "./search/fake.ts";
import { AnthropicWebSearch } from "./search/anthropic.ts";
import { TavilySearch } from "./search/tavily.ts";
import { UsageMeter } from "./usage.ts";
import type { SearchProvider } from "./search/types.ts";
import { type Clock, FakeClock, SystemClock } from "./time.ts";

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
  /** Anthropic spend so far (zero in fake mode). */
  meter: UsageMeter;
}

/** The model and the search provider the config asks for (fakes when there is no key). */
export function buildModels(config: Config, clock: Clock, meter: UsageMeter): { llm: LLM; search: SearchProvider } {
  if (config.fakeMode) return { llm: new FakeLLM(), search: new FakeSearch(clock) };
  const client = new Anthropic({ apiKey: config.anthropicKey, maxRetries: 2 });
  const llm = new AnthropicLLM({
    client,
    meter,
    answerModel: config.answerModel,
    fastModel: config.fastModel,
    answerEffort: config.answerEffort,
    fastSpeed: config.fastSpeed,
  });
  const search =
    config.searchProvider === "tavily" ? new TavilySearch(config.tavilyKey) : new AnthropicWebSearch(client, config.searchModel, meter);
  return { llm, search };
}

export function createAgent(config: Config = loadConfig()): Built {
  // In fake mode the clock is settable from the UI so multi-day memory can be demonstrated.
  const clock = config.fixedNow || config.allowClockOverride ? new FakeClock(config.fixedNow || undefined) : null;
  const realClock = clock ?? new SystemClock();
  const meter = new UsageMeter(config.maxSpendUsd);
  const { llm, search } = buildModels(config, realClock, meter);
  const store = new Store(config.dbPath);
  const agent = new Agent({
    store,
    llm,
    search,
    clock: realClock,
    timezone: config.timezone,
    watch: { enabled: config.watchEnabled, afterDays: config.watchAfterDays, maxSearches: config.watchMaxSearches },
  });
  return { agent, clock, config, llm, search, meter };
}
