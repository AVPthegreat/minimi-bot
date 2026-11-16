# Design

A web-search chat agent that remembers **what you asked and when**. Time and memory are data, not chat history:
"what did I ask on 3 November, is it still correct?" is a lookup plus a re-check of exactly the facts given then.

```
message ─► save with timestamp ─► time phrases resolved in code ─┬─► router: rules, else small model (1.5 s cap)
     search plan in code: the question + one query per subject ──┘   (started at once; cancelled if no search needed)
  chat    ─ no evidence
  recall  ─ SQLite: time window + FTS5 keywords ─► code shows "Last Tuesday = Tue 10 Nov" + the quoted question
  search  ─ one search per subject, in parallel ─► rank (official, fresh, every subject keeps its best page)
  verify  ─ recall ─► stored claims ─► per-subject + "news since" searches ─► small model reads values ─► diff in code
        ─► answer model writes only from those sources, cites [n] ─► grounding guard while streaming ─► save
        ─► extract claims under the planned subjects (background) ─► watchlist
```

**Memory.** One SQLite file (built into Node 22): sessions, messages (UTC, shown in your timezone), every search
(query, provider, results, time), and **claims**: checkable facts from answers (subject, attribute, value, unit,
source, date, re-check chain).

**Time.** "Yesterday", "on Monday", "3 November", "two weeks ago" resolve in code against an injectable clock.
"Last Tuesday" on a Wednesday gives two candidate days; memory uses the one with a matching conversation.

**The agent owns the plan.** A comparison names its subjects ("Supabase, Neon and Railway"), so code reads them
and starts one search per subject, plus the raw question, before the router model has answered; the router only adds
queries when code finds no list. With only an Anthropic key, each query is its own small Haiku call with exactly one
`web_search`, all in parallel. The answer model gets no search tool when those searches found sources: it writes only
from them. It searches itself (at most 3) only when the planned searches found nothing. (Live on 16 Nov the router
missed its 1.5 s cap, the plan collapsed to one query, and Opus searched on its own for 15-35 s.)

**Getting it right.** Official and recent pages rank first. Grounding is enforced in code while the answer streams:
a sentence or table row with a price is held until complete and checked against the gathered sources (amount,
currency, the product it belongs to: named in its clause, else the last one named, or in the source it cites); a total is accepted only as a sourced price times a number
the user gave ("20 seats x $14 [2] = $280"); an earlier answer backs a price only when stated as past ("was $19").
Snippets are the search model's verbatim citations plus its quoted bullets for URLs it returned. An unsupported
price is shown as "$X (unverified)", warned about, and tracked only as unverified, so the next re-check settles it. How a date was read, the quoted earlier question and the then/now table are rendered by code,
so they never depend on the model's wording; the summary never claims "nothing changed" unless every fact was verified.

**The right moment** (minimi's idea). Stated facts are a watchlist. A new chat quietly re-checks up to 3 subjects
(all their facts share one search each) older than 3 days; "anything new?" shows at most 6 rows, changes first. If one changed, the chat opens with one
line; if not, silence. Never twice, dropped if you start typing first, can be turned off (`WATCH_ENABLED`).

| Decision | Why | Rejected |
|---|---|---|
| Rules, then a small router, with a speculative search started in parallel | Small talk and memory questions need no web; a web question doesn't wait for routing (1.5 s cap) | Always search: slower and noisy. Router first: adds up to 4 s |
| Claims as rows, diff in code | Per-fact changed/unchanged/unverified | A model comparing prose: misses changes, invents some |
| SQLite FTS5 + time windows | Exact and explainable, no extra service | Vector DB: embeddings for a problem that is mostly *when* |
| Plain Anthropic SDK | Every prompt and step visible and testable | LangChain: hidden control flow |
| Search behind an interface, one call per query | Tavily: fast, dated snippets. **Only an Anthropic key:** one small Haiku `web_search` call per subject, in parallel, so the plan that runs is ours | One batched call: the model chose its own searches, one after another |
| Fakes for model, search and clock, made as unhelpful as the live models | The multi-day eval runs offline in `npm test` and catches what live runs caught | Only live tests: flaky and paid |

Models: `claude-opus-5-5` streams answers (effort low for chat/recall, medium for web); `claude-haiku-5-5` routes,
searches (Anthropic-only path), extracts claims and reads re-checked values (JSON schema output).

**What the user sees when** (targets, not yet measured live with this flow; `npm run eval:live` writes p50/p95 of
first status, first text and first model token to `eval/results/`). ≈0 s: "Searching the web for Supabase, Neon,
Railway (4 searches in parallel)"; then one line per finished search. Verify/recall: the date reading and the quoted
question at once, the then/now table when the re-check ends. Search answers: Opus's first token ≈1-2 s after the
slowest search (Tavily ≈1 s; Anthropic search ≈3-8 s), then tokens as they arrive (a price line waits for its end).
Live 16 Nov, before this change: 16-37 s to the first word on search turns.

**Web UI** (`public/`, plain ES modules, no framework or build step). `api.js` owns fetch, the SSE parser and typed
errors; `state.js` is one observable store; `chat.js` turns stream events into view calls (busy, stop, retry);
`render/*` only draw (messages, search steps, sources, sidebar, home, composer, banner); `markdown.js` escapes every
character before adding its own tags. The stream carries typed `search` events (query, running/done/failed/cancelled,
result count, the product's site) next to the old status lines, so older clients still work. Logos come from our own
`GET /api/logo` (`src/logo.ts`): fetched server-side over https from public addresses only (checked at connect time),
sniffed as raster images, size/time capped, cached in memory and on disk, a letter tile otherwise. Glass panels fall
back to solid under `prefers-reduced-transparency` or without `backdrop-filter`; text tokens pass AA on the worst-case aurora.

**Hosted demo** (`DEMO_MODE=1`, `src/app.ts` + `src/demo/`; off = the single-user app, same routes). Each route asks
`ctx(req)` for the caller's agent: a random 128-bit visitor id in an HMAC-signed HttpOnly cookie maps to that visitor's
own SQLite file, clock and Agent (opened lazily, LRU of 200, swept after `DEMO_TTL_DAYS`). One `LedgerMeter` (same
prices as `usage.ts`) writes every call's cost to `demo.db` and refuses paid calls at `DEMO_BUDGET_USD`; chat then sends
a typed `demo_budget` event. Per-visitor daily cap, per-IP token bucket, 1 answer per visitor / 8 globally, 2,000-char
messages, CSP and frame-ancestors none. Runbook: `deploy/README-demo.md`. Rejected: one shared memory (privacy), accounts (friction).

**Eval.** `eval/scenarios.ts` replays multi-day conversations on a fake clock against a fixture web whose prices
change on known dates: the three example questions, nudges, time phrases (late night IST, "the 3rd", "yesterday
evening"), same-day recall, small talk vs. a new question, rupees, contradicting sources, team totals, prompt
injection, nothing-changed: 131 checks offline, in `npm test`. "No price shown as fact without a source" is checked
independently of the guard; honest "(unverified)" prices are counted apart. Plus a test per live failure.

**With another week:** read full official pages and require two sources for high-stakes numbers; a macOS background
scheduler for nudges; embeddings for paraphrased recall; a nightly live eval graded by a judge model.
