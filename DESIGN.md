# Design

A web-search chat agent that remembers **what you asked and when**. Time and memory are data, not chat history:
"what did I ask on 3 November, is it still correct?" is a lookup plus a re-check of exactly the facts given then.

```
message ─► save with timestamp ─► time phrases resolved in code ─┬─► router: rules, else small model
                                     speculative search starts ──┘   (cancelled if no search needed)
  chat    ─ no evidence
  recall  ─ SQLite: time window + FTS5 keywords
  search  ─ planned queries, parallel/batched ─► rank (official, fresh)
  verify  ─ recall ─► stored claims ─► targeted + "news since" searches ─► small model reads values ─► diff in code
        ─► answer model streams, cites [n]; may run ≤3 web searches itself if evidence falls short
        ─► price guard vs current evidence ─► save ─► extract claims (background) ─► watchlist
```

**Memory.** One SQLite file (built into Node 22): sessions, messages (UTC, shown in your timezone), every search
(query, provider, results, time), and **claims**: checkable facts from answers (subject, attribute, value, unit,
source, date, re-check chain).

**Time.** "Yesterday", "on Monday", "3 November", "two weeks ago" resolve in code against an injectable clock.
Ambiguity is resolved by data: "last Tuesday" on a Wednesday gives two candidate days; memory uses the one with a
matching conversation, and the answer says which.

**Pipeline + bounded agent loop.** The predictable work runs as a fixed pipeline, in parallel: routing, planned
searches, memory lookups, re-checks. The answer model is also an agent when it needs to be: it gets the web_search
tool with at most 3 uses, for when the prefetched sources do not answer the question. A free-running loop would be
slower and hard to test on every turn; a pure pipeline gets stuck when the planner's queries miss.

**Getting it right.** Official and recent pages rank first. Answers cite `[n]` with dates. Every price is checked
against *current* evidence (fresh sources, the model's own cited passages, the diff table), matching amount, currency
and the product it belongs to; old answers don't count, so stale prices get flagged. The then/now table is rendered
by code, and its summary counts "couldn't verify" and never claims "nothing changed" unless every fact was verified.

**The right moment** (minimi's idea). Stated facts are a watchlist. A new chat quietly re-checks up to 3 subjects
older than 3 days. If one changed, the chat opens with one line; if not, it says nothing. It never repeats itself,
it is dropped if you start typing first, and it can be turned off (`WATCH_ENABLED`).

| Decision | Why | Rejected |
|---|---|---|
| Rules, then a small router, with a speculative search started in parallel | Small talk and memory questions need no web; a web question doesn't wait for routing (1.5 s cap) | Always search: slower and noisy. Router first: adds up to 4 s |
| Claims as rows, diff in code | Per-fact changed/unchanged/unverified | A model comparing prose: misses changes, invents some |
| SQLite FTS5 + time windows | Exact and explainable, no extra service | Vector DB: embeddings for a problem that is mostly *when* |
| Plain Anthropic SDK | Every prompt and step visible and testable | LangChain: hidden control flow |
| Search behind an interface | Tavily: fast, dated snippets. **Only an Anthropic key:** Anthropic's `web_search` tool, all planned queries batched into one Haiku call | Scraping pages ourselves |
| Fakes for model, search and clock | The multi-day eval runs offline in `npm test` | Only live tests: flaky |

Models: `claude-opus-5-5` streams answers (effort low for chat/recall, medium for web); `claude-haiku-5-5` routes,
extracts claims and reads re-checked values (JSON schema output).

**Latency: targets, not yet measured** (`npm run eval:live` writes p50/p95 per question type to `eval/results/`).
Chat/recall: first token ≈1 s. Search turn: ≈1 s of search with Tavily (≈3-6 s with Anthropic search), then ≈1 s to
the first token. Verify: the code-rendered table appears before the model starts.

**Eval.** `eval/scenarios.ts` replays multi-day conversations (the three example questions, nudges, fast paths) on a
fake clock against a fixture web whose prices change on known dates: 48 checks, run offline by `npm test`.

**With another week:** read full official pages and require two sources for high-stakes numbers; a macOS background
scheduler for nudges; embeddings for paraphrased recall; a nightly live eval graded by a judge model.
