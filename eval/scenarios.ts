// Multi-day conversations replayed against a fake clock. Each step sets "now", sends a message
// (or opens a new chat for the nudge), and checks what the agent did: intent, searches, memory,
// the diff table, honesty when nothing is found. Checks marked `offlineOnly` depend on the
// fixture web (where prices change on known dates) and are skipped in live runs.

import { Agent, type AgentEvent } from "../src/agent.ts";
import { moneyIn, parseValue, questionMultipliers } from "../src/claims.ts";
import { Store } from "../src/db.ts";
import { FakeLLM } from "../src/llm/fake.ts";
import type { LLM } from "../src/llm/types.ts";
import { FakeSearch } from "../src/search/fake.ts";
import type { SearchProvider } from "../src/search/types.ts";
import { FakeClock } from "../src/time.ts";

export interface TurnResult {
  text: string;
  intent?: string;
  via?: string;
  sources: Array<{ n: number; url: string; date?: string }>;
  warnings: string[];
  searches: number;
  firstStatusMs?: number | null;
  firstTokenMs: number | null;
  firstModelTokenMs?: number | null;
  totalMs: number;
  nudge?: string | null;
  userMessageId?: number;
  /** Prices the grounding guard could not match and showed as "(unverified)": honest, reported, not failures. */
  unverified: string[];
}

export interface Check {
  name: string;
  offlineOnly?: boolean;
  ok: (r: TurnResult, ctx: { store: Store; question: string }) => boolean;
}

export interface Step {
  at: string; // ISO with zone
  session: string; // a label; the same label = the same chat
  say?: string;
  /** Open a fresh chat and run the "right moment" watchlist check instead of sending a message. */
  openNewChat?: boolean;
  checks: Check[];
}

export interface Scenario {
  name: string;
  about: string;
  steps: Step[];
}

const has = (s: string) => (r: TurnResult) => r.text.toLowerCase().includes(s.toLowerCase());
const intent = (i: string): Check => ({ name: `intent is ${i}`, ok: (r) => r.intent === i });
const noSearch: Check = { name: "no web search", ok: (r) => r.searches === 0 };
const tableRow = (what: string, status: string): Check => ({
  name: `table: ${what} -> ${status}`,
  offlineOnly: true,
  ok: (r) => r.text.split("\n").some((l) => l.startsWith("|") && l.includes(what) && l.includes(status)),
});
/**
 * The promise is "no price is shown as fact without a source", checked independently of the guard:
 * every price in the answer is either marked "(unverified)" or its amount is in what was gathered for
 * this turn (search results logged in the store, the code-rendered table, or a sourced amount times a
 * number from the question/line or 12). A price the guard flagged but that reached the user unmarked
 * fails too. Honestly flagged prices are counted (TurnResult.unverified) and reported, not failed.
 */
export function pricesShownAsFactWithoutSource(r: TurnResult, store: Store, question: string): string[] {
  const evidence: string[] = [r.text.split("\n").filter((l) => l.startsWith("|")).join("\n")];
  if (r.userMessageId !== undefined) {
    const rows = store.db.prepare("SELECT results FROM searches WHERE message_id = ?").all(r.userMessageId) as Array<{ results: string }>;
    for (const row of rows) {
      const results = JSON.parse(row.results) as Array<{ title?: string; snippet?: string }> | { error: string };
      if (Array.isArray(results)) for (const x of results) evidence.push(`${x.title ?? ""}\n${x.snippet ?? ""}`);
    }
  }
  if (r.intent === "recall") {
    for (const m of store.db.prepare("SELECT content FROM messages WHERE role = 'assistant'").all() as Array<{ content: string }>) evidence.push(m.content);
  }
  const amounts = moneyIn(evidence.join("\n")).map((m) => parseValue(m).amount).filter((a): a is number => a !== null);
  const bad: string[] = [];
  for (const line of r.text.split("\n")) {
    if (line.startsWith("|") && /\| (Unchanged|\*\*Changed\*\*|Couldn't verify|Unchanged, now confirmed) \|\s*$/.test(line)) continue; // code-rendered
    const factors = [1, 12, ...questionMultipliers(question), ...questionMultipliers(line)];
    for (const m of line.matchAll(/(?:[$€£₹]\s?\d[\d,]*(?:\.\d+)?(?:\s?[km]\b)?|\b(?:USD|EUR|GBP|INR|Rs\.?)\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|INR)\b)/gi)) {
      const price = m[0].replace(/,$/, "");
      const a = parseValue(price).amount;
      if (a === null) continue;
      if (line.slice(m.index! + m[0].length).startsWith(" (unverified)")) continue;
      if (!amounts.some((e) => factors.some((n) => Math.abs(e * n - a) <= 0.005 * Math.max(1, a)))) bad.push(price);
    }
  }
  return [...new Set(bad)];
}

const noUnsupportedPrices: Check = {
  name: "no price shown as fact without a source",
  ok: (r, { store, question }) =>
    pricesShownAsFactWithoutSource(r, store, question).length === 0 && r.unverified.every((p) => r.text.includes(`${p} (unverified)`)),
};

export const SCENARIOS: Scenario[] = [
  {
    name: "postgres-last-tuesday",
    about: "Ask about Postgres hosting on Tue 10 Nov; on Wed 18 Nov ask whether pricing changed since 'last Tuesday'.",
    steps: [
      {
        at: "2026-11-10T10:00:00+05:30",
        session: "a",
        say: "What does Postgres hosting cost on Supabase, Neon and Railway?",
        checks: [
          intent("search"),
          { name: "one search per product + the speculative one, in parallel", ok: (r) => r.searches === 4 },
          { name: "cites at least 3 sources", ok: (r) => r.sources.length >= 3 },
          { name: "states Neon's price", offlineOnly: true, ok: has("$19") },
          { name: "facts stored for later re-checks", ok: (_r, { store }) => (store.db.prepare("SELECT COUNT(*) AS n FROM claims").get() as { n: number }).n >= 3 },
          noUnsupportedPrices,
        ],
      },
      {
        at: "2026-11-18T09:00:00+05:30",
        session: "b",
        say: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
        checks: [
          intent("verify"),
          { name: "routed by rules (no router model call)", ok: (r) => r.via === "rules" },
          { name: "reads 'last Tuesday' as Tue 10 Nov, says so", ok: (r) => /Tue 10 Nov/.test(r.text) && /could mean/.test(r.text) },
          { name: "quotes the earlier question", ok: has("What does Postgres hosting cost on Supabase, Neon and Railway?") },
          { name: "shows a then/now table", ok: (r) => /\| What \| Then \(Tue 10 Nov\) \| Now/.test(r.text) },
          tableRow("Neon: Launch plan", "Changed"),
          tableRow("Supabase: Pro plan", "Unchanged"),
          { name: "new Neon price $15 with a source", offlineOnly: true, ok: (r) => /\$15 per month \[\d\]/.test(r.text) },
          noUnsupportedPrices,
        ],
      },
    ],
  },
  {
    name: "crm-shortlist-monday",
    about: "Shortlist 5 CRMs on Mon 9 Nov; on Thu 12 Nov ask if any changed pricing or shipped something big since Monday.",
    steps: [
      {
        at: "2026-11-09T11:00:00+05:30",
        session: "a",
        say: "We're a 20-person sales team. Compare HubSpot, Pipedrive, Salesforce, Zoho CRM and Close pricing.",
        checks: [intent("search"), { name: "one search per CRM + the speculative one (6, in parallel)", ok: (r) => r.searches === 6 }, noUnsupportedPrices],
      },
      {
        at: "2026-11-12T15:00:00+05:30",
        session: "b",
        say: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
        checks: [
          intent("verify"),
          { name: "finds Monday's conversation", ok: has("Compare HubSpot, Pipedrive, Salesforce, Zoho CRM and Close pricing") },
          { name: "re-checks all 5 tools", ok: (r) => ["HubSpot", "Pipedrive", "Salesforce", "Zoho CRM", "Close"].every((t) => r.text.includes(`| ${t}:`)) },
          tableRow("Pipedrive: Advanced plan", "Changed"),
          tableRow("HubSpot: Sales Hub Starter plan", "Unchanged"),
          { name: "reports the HubSpot launch since Monday", offlineOnly: true, ok: has("Breeze") },
          noUnsupportedPrices,
        ],
      },
    ],
  },
  {
    name: "what-did-i-ask-on-3-nov",
    about: "Ask on 3 Nov; on 15 Nov ask what was asked on 3 Nov and whether the answer still holds; then ask about a day with no conversation.",
    steps: [
      {
        at: "2026-11-03T18:00:00+05:30",
        session: "a",
        say: "How much is the Cloudflare Workers paid plan?",
        checks: [intent("search"), { name: "states the price", offlineOnly: true, ok: has("$5") }],
      },
      {
        at: "2026-11-15T10:00:00+05:30",
        session: "b",
        say: "What did I ask you on 3 November? Is your answer still correct today?",
        checks: [
          intent("verify"),
          { name: "quotes the 3 Nov question with its date", ok: (r) => r.text.includes("How much is the Cloudflare Workers paid plan?") && r.text.includes("3 Nov") },
          tableRow("Cloudflare Workers: Paid plan", "Unchanged"),
        ],
      },
      {
        at: "2026-11-15T10:05:00+05:30",
        session: "b",
        say: "What did I ask you on 4 November?",
        checks: [
          intent("recall"),
          noSearch,
          { name: "says honestly there is nothing on 4 Nov", ok: (r) => /no (record|conversation)/i.test(r.text) && r.text.includes("4 Nov") },
        ],
      },
    ],
  },
  {
    name: "right-moment-nudge",
    about: "A new chat opens with one nudge only when a tracked fact changed; never twice for the same change; silent otherwise.",
    steps: [
      { at: "2026-11-10T10:00:00+05:30", session: "a", say: "What does Postgres hosting cost on Supabase, Neon and Railway?", checks: [intent("search")] },
      { at: "2026-11-11T09:00:00+05:30", session: "b", openNewChat: true, checks: [{ name: "too soon to re-check: silent, no searches", ok: (r) => r.nudge === null && r.searches === 0 }] },
      {
        at: "2026-11-16T09:00:00+05:30",
        session: "c",
        openNewChat: true,
        checks: [
          { name: "one nudge about the Neon change", offlineOnly: true, ok: (r) => !!r.nudge && r.nudge.includes("Neon") && r.nudge.includes("$15") && r.nudge.includes("Tue 10 Nov") },
          { name: "bounded: at most 3 searches", ok: (r) => r.searches <= 3 },
        ],
      },
      { at: "2026-11-16T09:30:00+05:30", session: "d", openNewChat: true, checks: [{ name: "same change is not announced twice, no searches", ok: (r) => r.nudge === null && r.searches === 0 }] },
    ],
  },
  {
    name: "fast-paths-and-follow-ups",
    about: "Small talk costs nothing; 'is that still correct?' right after an answer checks that answer; 'anything new?' checks the watchlist.",
    steps: [
      { at: "2026-11-10T10:00:00+05:30", session: "a", say: "hi", checks: [intent("chat"), noSearch, { name: "routed by rules", ok: (r) => r.via === "rules" }] },
      { at: "2026-11-10T10:01:00+05:30", session: "a", say: "How much is the Cloudflare Workers paid plan?", checks: [intent("search")] },
      {
        at: "2026-11-10T10:02:00+05:30",
        session: "a",
        say: "Is that still correct?",
        checks: [intent("verify"), tableRow("Cloudflare Workers: Paid plan", "Unchanged")],
      },
      {
        at: "2026-11-10T10:03:00+05:30",
        session: "a",
        say: "What does Postgres hosting cost on Supabase, Neon and Railway?",
        checks: [intent("search")],
      },
      {
        at: "2026-11-20T10:00:00+05:30",
        session: "b",
        say: "Anything new?",
        checks: [
          intent("updates"),
          tableRow("Neon: Launch plan", "Changed"),
          {
            name: "bounded: at most 3 subjects re-checked",
            ok: (r) => {
              const rows = r.text.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| What"));
              const subjects = new Set(rows.map((l) => l.slice(2).split(":")[0]!.trim().toLowerCase()));
              return subjects.size <= 3 && rows.length <= 6 && r.searches <= 6;
            },
          },
        ],
      },
    ],
  },
];

/**
 * The offline models, set up to behave like the live ones where that hid bugs (16 Nov live run): the
 * router model misses its budget, and the answer model searches on its own whenever it is given a tool.
 */
export function offlineModels(clock: FakeClock): { llm: LLM; search: SearchProvider } {
  const search = new FakeSearch(clock);
  return { llm: new FakeLLM(new FakeSearch(clock), { slowRouter: true }), search };
}

export interface StepReport {
  scenario: string;
  step: number;
  say: string;
  result: TurnResult;
  checks: Array<{ name: string; pass: boolean; skipped: boolean }>;
}

export async function runScenario(
  scenario: Scenario,
  make: (clock: FakeClock) => { llm: LLM; search: SearchProvider },
  opts: { live?: boolean; timezone?: string } = {},
): Promise<StepReport[]> {
  const clock = new FakeClock(scenario.steps[0]!.at);
  const { llm, search } = make(clock);
  let searchCount = 0;
  // Counts the searches the agent runs (one provider call per query).
  const counting: SearchProvider = {
    name: search.name,
    search: (q, o) => {
      searchCount++;
      return search.search(q, o);
    },
  };
  const store = new Store(":memory:");
  const agent = new Agent({ store, llm, search: counting, clock, timezone: opts.timezone ?? "Asia/Kolkata", watch: { enabled: true, afterDays: 3, maxSearches: 3 } });
  const sessions = new Map<string, string>();
  const reports: StepReport[] = [];

  for (const [i, step] of scenario.steps.entries()) {
    clock.set(step.at);
    if (!sessions.has(step.session)) sessions.set(step.session, agent.newSession().id);
    const sid = sessions.get(step.session)!;
    searchCount = 0;
    let result: TurnResult;
    if (step.openNewChat) {
      const n = await agent.nudge(sid);
      result = { text: n?.nudge.text ?? "", sources: [], warnings: [], searches: searchCount, firstTokenMs: null, totalMs: 0, nudge: n?.nudge.text ?? null, unverified: [] };
    } else {
      result = await collect(agent.chat(sid, step.say!));
      result.searches = searchCount;
    }
    await agent.idle();
    reports.push({
      scenario: scenario.name,
      step: i + 1,
      say: step.say ?? "(opens a new chat)",
      result,
      checks: step.checks.map((c) => {
        const skipped = !!(opts.live && c.offlineOnly);
        return { name: c.name, skipped, pass: skipped || safe(() => c.ok(result, { store, question: step.say ?? "" })) };
      }),
    });
  }
  store.close();
  return reports;
}

function safe(f: () => boolean): boolean {
  try {
    return f();
  } catch {
    return false;
  }
}

async function collect(events: AsyncGenerator<AgentEvent>): Promise<TurnResult> {
  const r: TurnResult = { text: "", sources: [], warnings: [], searches: 0, firstTokenMs: null, totalMs: 0, unverified: [] };
  for await (const ev of events) {
    if (ev.type === "delta") r.text += ev.text;
    else if (ev.type === "turn") r.userMessageId = ev.userMessageId;
    else if (ev.type === "route") {
      r.intent = ev.intent;
      r.via = ev.via;
    } else if (ev.type === "sources") r.sources = ev.sources;
    else if (ev.type === "warning") {
      r.warnings.push(ev.text);
      const flagged = /^I couldn't match (.+) to a current source/.exec(ev.text);
      if (flagged) r.unverified.push(flagged[1]!);
    }
    else if (ev.type === "done") {
      r.firstStatusMs = ev.timings.firstStatusMs;
      r.firstTokenMs = ev.timings.firstTokenMs;
      r.firstModelTokenMs = ev.timings.firstModelTokenMs;
      r.totalMs = ev.timings.totalMs;
    }
  }
  return r;
}
