# Design

**Goal:** a web-search chat agent that answers fast, gets facts right, and remembers what you asked and when, so
"what did I ask on 3 November, is it still correct?" works. Memory and time are first-class data, not chat history.

## How it works

```
message ─► save with timestamp ─► time resolver (code) ─► router: rules, else small model (4 s timeout, rules fallback)
                                                             │
     chat ── no tools ───────────────────────────────────────┤
     recall ── SQLite: time window + FTS5 topic match ───────┤
     search ── 1-5 queries in parallel ─► rank (official, fresh) ┤
     verify ── recall ─► stored claims ─► targeted searches + "news since" in parallel
               ─► small model reads current values ─► diff in code ─► table ─────┤
                                                             ▼
             stream answer (large model, cites [n] with dates) ─► price guard ─► save
                                                             └─► extract claims (background) ─► watchlist
```

**Memory** is one SQLite file (`node:sqlite`, FTS5): `sessions`, `messages` (UTC ms timestamps, shown in the user's
zone), `searches` (query, provider, results, time), and `claims`: checkable facts pulled from answers
(subject, attribute, value, unit, source URL and date, checked_at, `supersedes_id` for re-checks). Claims are what
make "has pricing changed since?" a precise operation instead of a vibe: we re-check *those facts*, not the topic.

**Time** is resolved by deterministic code against an injectable clock, in the user's timezone: "yesterday",
"on Monday", "on 3 November", "two weeks ago", "last week". Ambiguity is data, not a guess: "last Tuesday" said on a
Wednesday yields two candidate days; memory picks the one with a matching conversation and the answer says so
("could mean 17 or 10 Nov; you asked on 10 Nov, so I used that").

**Getting it right.** Sources are ranked toward official pages and recent dates; the answer model must cite `[n]` and
date anything that changes, and may only state prices found in sources or memory. That rule is *checked*: every
price in the answer is matched against the evidence and unmatched ones are flagged in the UI. The then/now table is
rendered by code from stored values, so a model can't misquote a number in it. Unverifiable facts say "couldn't
verify", never carry the old value forward. Search failure is reported, not papered over.

**The right moment.** Every stated fact is tracked. When you open a new chat, the agent re-checks up to 3 subjects
whose facts are older than 3 days (cached: a fact checked recently is skipped). If one changed, the chat opens with
one line ("Neon Launch plan: $19 then, $15 now, source dated 14 Nov"); otherwise it stays silent. The same change is
never announced twice; others wait for "anything new?". An assistant that pings "no news" gets ignored. Optional
(`WATCH_ENABLED`), bounded (`WATCH_MAX_SEARCHES`), and the check never delays the chat (12 s cap, off the request path).

## Key decisions

| Decision | Why | Rejected |
|---|---|---|
| Route first (rules, then a small model) | Small talk and memory questions need no search: instant, free. Rules catch the obvious cases with zero model calls | Always-search: slower, costlier, and pollutes recall answers with web noise |
| Claims as rows, diff in code | "Still correct?" becomes per-fact re-checks with an exact changed/unchanged/unverified table | Re-asking the question and letting the model compare prose: misses changes, invents some |
| SQLite FTS5 + time windows | Questions about the past are keyed by *when* and keywords; BM25 inside a window is exact and explainable | Vector DB: an extra service and embeddings for a problem that is mostly time filtering |
| Plain Anthropic SDK, ~2.7k lines of TypeScript | Every step is visible and testable; parallelism and timeouts are explicit | LangChain/agent frameworks: hidden prompts and control flow, harder to defend |
| Search behind an interface | Tavily: one fast call with snippets and dates. Anthropic `web_search`: needs only the Anthropic key | Scraping pages ourselves: slow, brittle |
| Fakes for model, search and clock | The whole multi-day eval runs offline in `npm test`, deterministic | Testing only against the live web: flaky and unrepeatable |

Models: `claude-opus-5-5` writes answers (streamed; effort `low` for chat/recall, `medium` for web; server-side refusal
fallback on); `claude-haiku-5-5` routes, extracts claims and reads re-checked values with JSON-schema outputs.

## Latency budget (target, search turn)

Rules route 0 ms, or model route ~0.5 s · searches in parallel ~1 s (Tavily) / ~3-6 s (Anthropic web_search: one
model call per query) · first answer token ~1 s later · claim extraction after the answer, off the critical path.
Chat and recall: first token in ~1 s (no search). Verify: the code-rendered table streams before the model starts.
Measured numbers per turn are in the UI and in `npm run eval:live`.

## Evaluation

`eval/scenarios.ts` replays multi-day conversations on a fake clock against a fixture web whose prices change on
known dates: Postgres hosting asked Tue 10 Nov, "last Tuesday... changed?" on Wed 18 Nov; a 5-CRM shortlist on Monday
re-checked on Thursday (price change + a launch); "what did I ask on 3 November, still correct?"; nudge timing (silent
when too soon, one nudge, never twice); fast paths. 48 checks, all in `npm test`. `eval:live` runs the same scripts on
real models with a spend cap and skips only the checks that depend on fixture prices.

## With another week

1. Fetch and read the official page for each re-checked claim (not just snippets) and require two agreeing sources
   for high-stakes numbers. 2. A real background scheduler (macOS launch agent) so nudges arrive at a good moment
   instead of on chat open, plus "stop tracking this". 3. Embeddings as a second recall signal for paraphrases
   ("database host" vs "Postgres hosting"). 4. A live eval set graded by a judge model, run nightly, with latency
   percentiles. 5. Conversation summaries for long sessions; user-level settings (timezone from the browser).
