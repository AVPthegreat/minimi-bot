# minimi bot: Low-Level Design

Companion to [HLD.md](HLD.md). This document goes module by module: purpose, public interface, and the algorithms
step by step, as implemented on branch `docs/hld-lld`. Paths are relative to the repository root.

Contents:
1. [Module map](#1-module-map)
2. [Modules and algorithms](#2-modules-and-algorithms)
3. [SQLite schema](#3-sqlite-schema)
4. [Stream events](#4-stream-events)
5. [Errors and how they surface](#5-errors-and-how-they-surface)
6. [Configuration](#6-configuration)
7. [Front-end module map](#7-front-end-module-map)
8. [Test map](#8-test-map)

---

## 1. Module map

| File | Lines (approx.) | Depends on |
|---|---:|---|
| `src/server.ts` | 30 | `app.ts` |
| `src/app.ts` | 620 | `index.ts`, `demo/*`, `logo.ts`, `usage.ts`, `time.ts` |
| `src/index.ts` | 90 | `agent.ts`, `db.ts`, `llm/*`, `search/*`, `usage.ts`, `time.ts` |
| `src/agent.ts` | 190 | `turn/*`, `db.ts`, `planner.ts`, `recheck.ts`, `watch.ts`, `timeparse.ts` |
| `src/turn/*` | 640 | `route.ts` (routing + planned round), `handlers/{chat,recall,verify,updates,search}.ts`, `answer.ts` (loop + guard), `context.ts` (`Turn`), `progress.ts`, `types.ts` |
| `src/router.ts` | 135 | `llm/types.ts` |
| `src/planner.ts` | 100 | `router.ts` |
| `src/timeparse.ts`, `src/time.ts` | 260, 130 | none |
| `src/memory.ts` | 100 | `db.ts`, `time.ts`, `router.ts` |
| `src/claims.ts` | 420 | `db.ts` (types) |
| `src/grounding.ts` | 80 | none (the checker is injected) |
| `src/recheck.ts`, `src/watch.ts` | 110, 95 | `claims.ts`, `db.ts`, `search/rank.ts`, `planner.ts` |
| `src/search/*` | 370 | `usage.ts` (Anthropic search only) |
| `src/llm/*` | 570 | `@anthropic-ai/sdk`, `claims.ts`, `router.ts` (fake) |
| `src/usage.ts` | 65 | none |
| `src/logo.ts`, `src/brand.ts` | 290, 50 | `node:https`, `node:dns`, `search/rank.ts` |
| `src/demo/*` | 520 | `usage.ts`, `index.ts`, `node:sqlite`, `node:crypto` |

---

## 2. Modules and algorithms

### 2.1 `src/index.ts`: assembly

- `createAgent(config = loadConfig()): Built` builds the clock (a `FakeClock` when `MINIMI_NOW` is set or the clock
  is settable, else `SystemClock`), a `UsageMeter(MAX_SPEND_USD)`, and calls `buildAgent`.
- `buildModels(config, clock, meter)` returns `FakeLLM` + `FakeSearch` in fake mode, else `AnthropicLLM` and either
  `TavilySearch` or `AnthropicWebSearch` (`SEARCH_PROVIDER=auto` picks Tavily when its key exists). The SDK client
  is created with `maxRetries: 2`.
- `buildAgent(config, {clock, meter, dbPath, publicError?})` opens a `Store` and constructs the `Agent`. The demo
  calls it once per visitor.

### 2.2 `src/agent.ts` and `src/turn/*`: the turn

`Agent.chat` is the shared lifecycle only; everything that differs per intent is a handler. Per-turn state lives in
one `Turn` object (`src/turn/context.ts`) that the stages read and fill; each stage is an async generator of
`AgentEvent`, composed with `yield*`.

| Stage | File | Does |
|---|---|---|
| Lifecycle | `src/agent.ts` `Agent.chat` | store the message, build the `Turn`, run the stages below, log searches, persist, `remember` (claims in the background), `done` |
| Route | `src/turn/route.ts` `routeTurn` | rules, the planned (speculative) round started at once, router model, cancellation |
| Dispatch | `src/turn/handlers/index.ts` `HANDLERS: Record<Intent, IntentHandler>` | `{ web: boolean; gather(t: Turn) }` per intent |
| Handlers | `handlers/chat.ts`, `recall.ts`, `verify.ts`, `updates.ts`, `search.ts` | gather evidence into the `Turn` (memory, re-check table, search runs, sources) and code-rendered lines |
| Answer | `src/turn/answer.ts` `answer(t, web)` | the bounded tool loop and the grounding guard |

Public interface:

```ts
class Agent {
  constructor(deps: AgentDeps)            // store, llm, search, clock, timezone, watch?, maxSelfSearches?, meter?, publicError?
  get store(): Store
  nowLabel(): string                      // "Mon 16 Nov 2026, 14:05 (Asia/Kolkata)"
  newSession(): SessionRow
  chat(sessionId: string, text: string, signal?: AbortSignal): AsyncGenerator<AgentEvent>
  nudge(sessionId: string, signal?: AbortSignal): Promise<{ messageId: number; nudge: Nudge } | null>
  idle(): Promise<void>                   // waits for background claim extraction
}
```

Constants: `HISTORY_TURNS = 8`, `MAX_INPUT = 4000`, `MAX_STORED_CLAIMS = 15`, `MAX_CLAIMS_PER_SUBJECT = 3` (agent.ts);
`SPECULATIVE_ROUTER_TIMEOUT_MS = 1500` (route.ts); `MAX_VERIFY_CLAIMS = 12`, `MAX_VERIFY_SEARCHES = 5` (verify.ts);
`SELF_SEARCH_RESULTS = 5` (answer.ts).

One turn step by step (steps 1-3 and 9-16 are `Agent.chat`; 4-7 `routeTurn`; 8 the handler; 10-13 `answer`):

1. Trim and cut the text to 4,000 characters; empty gives an `error` event and returns.
2. Create the session if unknown; `addMessage(user)`; `touchSession` (title = first 80 characters); emit `turn`.
3. `parseTimeRefs(text, now, tz)`; load history (last 8 messages before this one; drop leading assistant messages
   so the conversation starts with a user turn).
4. `rulesRoute(text, hasTimeRef, hasHistory, rest)`. `undecided` is true when the rules return `null` or `search`.
5. If undecided: `specQuery` is the rules' own question (a new question inside a follow-up) or the first 300
   characters of the text. `subjects = planSubjects(...)`. `planned` = the speculative query plus
   `subjectQueries(subjects, rest)`, each with `maxResults: 5`. `runQueries` starts them under an abort controller
   joined with the request signal. Emit the status line and one `search: running` per query.
6. `route(llm, input, {timeoutMs: spec ? 1500 : 4000})`. If the intent is not `search`, abort the speculative
   searches, drop queued `search` events (so no step finishes after its `cancelled`), and emit `cancelled` steps.
7. `updateMessageMeta(user, {intent})`. `extra` = router queries, only when code found no subjects and only those
   not equal to the speculative query (`sameQuery` normalises case and punctuation). Emit `route`.
8. `HANDLERS[intent].gather(turn)` gathers evidence (inside a try; a failure adds a note for the model instead of failing the turn):
   - `recall` (`recallMemory`, also the first step of `verify`): `recall(store, ...)`; emit code lines: the notes (date reading) and
     `You asked on <when>: "<question>"` per turn.
   - `verify` / `updates` (shared `recheck(turn, claims, maxQueries)` in `verify.ts`): claims are `dedupeClaims(memory claims, 12)` or `dueClaims(store, now, watch, true)`.
     With claims: status "Re-checking N facts about K subjects from <then>"; `recheckClaims` with
     `maxQueries` 5 (verify) or `WATCH_MAX_SEARCHES` (updates) and `newsSinceDays` = days since the oldest
     `checked_at` (at least 1). Render `summarizeDiff` + `renderDiffTable` (+ a "(N more facts checked: ...)" line
     when `rowsToShow` hid rows). Without claims: small talk gets a code-only reply (`answeredByCode`), a factual
     earlier turn is searched again (`verify-freeform`), `updates` says nothing is tracked yet.
   - `search`: run `extra` queries (maxResults 6 when `highStakes`, `sinceDays` from the router), await the
     speculative and extra runs through `drain`, then
     `rankSources(runs, subjects or router queries, now, max(8, 2 × subjects + 2), {coverEachQuery: subjects.length > 0})`.
9. If every run failed: `warning` and (for search) a note "do not state current facts". Log every run with
   `store.logSearch`. Emit `sources`.
10. The tool budget: `ANSWER_MAX_SEARCHES` (default 3) when the handler is `web` (search, verify, updates), else 0
    (chat and recall never search). A non-integer bound counts as 0.
11. Build the guard: `new GroundingGuard((line, before) => priceChecker(evidence(), {multipliers, names: names()})(line, shown + before))`.
    `evidence()` is recomputed per line (sources can grow during the stream): every source (`text` = title +
    snippet, `about` = site name + title + query), the diff table, and earlier answers as `pastOnly` evidence unless
    the intent is `recall`. `names()` = planned subjects, capitalised product words of the question, memory claim
    subjects and question words, diff subjects, source site names.
12. The agent loop (`answer`): each round calls `llm.streamAnswer` with `maxSelfSearches` = searches left and
    `rounds` = the earlier tool rounds (`sources` stays the planned round's, so the first message is stable).
    `text` goes through `guard.push`; `tool_call` events are collected. No calls, no budget left, or an abort: the
    answer is done. Otherwise check the spend meter (`deps.meter.check()`; if the cap is reached, append "(I stopped
    searching here: the spend cap is reached.)" and stop), then run up to `left` calls in parallel with
    `runQueries(..., purpose "self-search", maxResults 5)` through `drain` (a `Searching again: <q>` status and a
    `search` step per call, closed by `onRun`). Calls beyond the budget get the result `search budget for this
    turn is used up`. Each run is ranked (`rankSources`) and its pages appended to `turn.sources` with the next
    numbers (a URL already there keeps its number); emit `sources`; push the `ToolRound {text, calls, results,
    state}` and loop. `used` grows by at least 1 per round, so the loop makes at most `budget + 1` model calls.
    On an exception (not an abort): a short failure line through the guard and an `error` event with
    `publicError(e)` or the message.
13. `guard.end()` releases the held tail. Log the loop's searches (`self-search`). Emit one `warning` per flagged price.
14. Save the assistant message with meta `{intent, via, replyTo, sources, warnings, notes, timings, aborted}`.
    If a re-check ran and the turn was not stopped: `saveRecheck`.
15. Background (not stopped, intent `search` or a freeform `verify`, sources and text present): `extractClaims`,
    then mark values that the guard flagged as `"<value> (unverified)"` with no source, `canonicalSubject` to the
    planned names, `fairCap(15, 3 per subject)`, `addClaims`.
16. Emit `done` with `Timings {routeMs, evidenceMs, firstStatusMs, firstTokenMs, firstModelTokenMs, totalMs}`.

Helpers: `Updates` is a small queue with a wake promise; `drain(p, updates)` is an async generator that yields
queued progress events while awaiting `p`, then returns `p`'s value (used with `yield*`). This is how parallel
search completions become stream events in order (`src/turn/progress.ts`). `turnsForClaims` (`handlers/updates.ts`) maps tracked claims back to their original
questions (via `rootClaim` and `questionFor`, at most 3) for "anything new?". `publicSource` adds a 160-character
quote line for the source card.

### 2.3 `src/router.ts`: intent routing rules

`rulesRoute(text, hasTimeRef, hasHistory, rest)` returns a plan without `via`, or `null`. Order matters:

| Step | Rule | Result |
|---|---|---|
| 1 | `CHITCHAT` (greeting, thanks, "who made you", "what can you do", up to 20 trailing characters), `MATH` (numbers with `% of`, `+ - * / x × ÷ ^`, "times", "plus"...), `DEFINE` ("what does X mean", one lowercase word) | `chat` |
| 2 | `UPDATES` ("anything new?", "what's changed?") and no "in/about/with/for <word>" | `updates` |
| 3 | `VERIFY` matches and `ownQuestion(text)` finds a separate new question | `search` on that question; `highStakes` if it mentions price, cost, $, fee or plan |
| 4 | `VERIFY` and the message points back: a time reference, `PAST_POINTER` ("I asked", "you said", "earlier", "last time"...), or history plus a pronoun (that, it, this, those, them) | `verify`, `memoryQuery = stopwordsTopic(rest)` |
| 5 | `RECALL` ("what did I ask", "remind me what", "what did you recommend"...) | `recall` |
| 6 | otherwise | `null` (the model decides) |

`ownQuestion(text)` splits on quotes and sentence ends, strips leading "then/and/also/so/plus", and returns the
first part that is not itself a follow-up, recall or pointer phrase, ends with "?" or starts with "compare", and
has at least two topic words. This fixed a live bug where "What does X cost? Is that still correct?" was routed as a
re-check of the previous answer.

`route(llm, input, {timeoutMs})`: rules first (`via: "rules"`); else `llm.route` under `withTimeout`; queries are
trimmed, de-duplicated and capped at `MAX_QUERIES = 5`; a `search` plan with no query gets the text
(`via: "model"`). Any error or timeout gives `fallbackRoute(text)`: `chat` when the text has at most 3 words and no
"?", else `search` with the text (`via: "fallback"`).

`stopwordsTopic(text)` keeps letters, digits, `+` and `-`, drops one-letter words and a fixed stop list of
question, time and follow-up words.

### 2.4 `src/planner.ts`: product extraction

- `NAME` = 1-3 capitalised words (`[A-Z][\w.+&-]*`), `SEP` = comma (optionally with and/or), "and", "or", "vs",
  "versus". `LIST_RE = NAME (SEP NAME)+`.
- `planSubjects(text)`: for each list match, split on `SEP`, drop leading words in `NOT_NAMES` (sentence openers,
  weekdays, months: "Compare Supabase" becomes "Supabase"), strip trailing punctuation, de-duplicate
  case-insensitively. Returns 2-5 names (`MAX_SUBJECTS`) or `[]`.
  Example: "What does Postgres hosting cost on Supabase, Neon and Railway?" gives `["Supabase", "Neon", "Railway"]`
  ("Postgres" and "What" are not part of the list because the list needs separators between names).
- `subjectQueries(subjects, text)`: if the text is about money (price, cost, fee, plan, cheap, expensive, per seat,
  or a currency sign) each query is `"<subject> pricing"`; otherwise `"<subject> <up to 4 topic words>"` with
  subject words removed.
- `canonicalSubject(claim, subjects)`: files a claim under the searched name. Exact match keeps the planned
  spelling; a shortened name ("Zoho" for "Zoho CRM") takes the planned name; a longer name ("HubSpot Sales Hub" for
  "HubSpot") moves the extra words into the attribute ("Sales Hub Starter plan price").
- `fairCap(items, max, perSubject)`: round-robin across subjects so every product of a shortlist is kept, then
  returns the kept items in the caller's order.

### 2.5 `src/search/*`: providers, fan-out and ranking

Interface (`types.ts`):

```ts
interface SearchProvider { readonly name: string; search(query: string, opts?: SearchOptions): Promise<SearchResult[]> }
interface SearchOptions { maxResults?: number; sinceDays?: number; depth?: "basic" | "deep"; signal?: AbortSignal }
interface SearchResult { title: string; url: string; snippet: string; publishedDate?: string; score?: number }
```

Providers:

| Provider | Call | Notes |
|---|---|---|
| `TavilySearch` | `POST https://api.tavily.com/search`, 8 s timeout joined with the caller's signal | `deep` maps to `search_depth: advanced`; `sinceDays` switches to the news index with `days`; snippets cut to 1,200 characters. |
| `AnthropicWebSearch` | One `messages.create` on `SEARCH_MODEL` with the web_search version `webSearchTool(SEARCH_MODEL)` picks (`web_search_20260209` on Fable, Mythos and Opus/Sonnet 4.6+, `web_search_20250305` on other models such as the default Haiku), `max_uses: 1`, effort low, 30 s timeout, 1 retry | `meter.check()` first. Results come from `web_search_tool_result` blocks (deduplicated by URL; an error object instead of a list counts as a failure). Snippets are the citations' verbatim `cited_text`, plus the model's quoted bullets for URLs the search returned (a bullet naming an unknown URL is ignored), plus the whole text block when it contains a money amount. Quoted results rank first (score 0.9 minus 0.05 per position); title-only ones get score 0.3. |
| `FakeSearch` | `fixtures/world.json` filtered by the injected clock (`from` ≤ now < `to`) | Token overlap ≥ 0.6 of query words; `sinceDays` filters by `published`; logs every query for assertions. |

`runQueries(provider, queries, signal, onRun?, onStart?)`: `Promise.all` over the queries; each call is wrapped so
one failure becomes a `QueryRun` with `error` and no results. `onRun(run, done, total)` fires as each finishes.
Latency is the slowest search, not the sum.

`rankSources(runs, subjects, nowMs, limit = 8, {coverEachQuery})`:

1. Key each result by URL without query, fragment and trailing slash.
2. Score = provider score (default 0.5) + `1 / (position + 2)`.
3. Vendor page (`isOfficialFor(url, subjects)`: a host label equals or starts with the subject's first word, at least
   3 characters): +0.8 with an official path (`/pricing`, `/plans`, `/changelog`, `/release-notes`, `/releases`,
   `/docs`, `/blog`, `/news`, `/press`), +0.5 otherwise. A third-party official path: +0.1.
4. Freshness: up to +0.5, falling linearly to 0 over 365 days of age.
5. The same URL from two queries keeps the higher score + 0.2.
6. Sort by score. With `coverEachQuery`, first take the best-scoring page of every run (one per product), then fill
   to `limit` by score, and keep score order. Number the result `n = 1..`.

### 2.6 `src/claims.ts`: values, diff and the price checker

Values:

- `parseValue(v)` reads the first amount with optional currency before (`$ € £ ₹`, `USD EUR GBP INR Rs`) or after,
  thousands separators, and `k`/`m` suffixes. "Free" is amount 0. Returns `{amount, currency, text}`.
- `sameValue(a, b)`: compare as numbers when both are money (or bare numbers, or one of each): currencies must agree
  when both are known, amounts within 0.5%. Everything else compares as normalised text, so "2 GB" vs "2 TB" or a
  version change is a change.
- `sameUnit(a, b)`: unit words as sets, with filler ignored (a, per, each, the, of, every) and synonyms folded (mo,
  monthly → month; user, users, licence → seat; plural s removed). Same when one set contains the other ("per month"
  vs "per month per workspace").

Diff (`diffClaim(old, fresh)`):

| Case | Status | Note |
|---|---|---|
| `fresh` is null | `unverified` | "no current source found" |
| value differs (after removing "(unverified)" from the old value), and wording is not merely longer (`sameWording`), or both units known and different | `changed` | |
| same value, old value had "(unverified)" | `unchanged` | "was unverified, now confirmed"; the table shows **Unchanged, now confirmed** |
| same value | `unchanged` | |

`renderDiffTable(rows, thenLabel, nowLabel)` writes `| What | Then (<then>) | Now (<now>) | Status |` with pipes
escaped, `[n]` after the new value and "not found" when there is none. `summarizeDiff` never says "Nothing ...
has changed" unless every row is verified and unchanged; all unverified gives "I couldn't verify any of the N
facts"; otherwise "Since <then>: **K changed**, U unchanged, V I couldn't verify."

Price checker (`priceChecker(evidence, {multipliers, names})`), used by the guard:

1. `MONEY_RE` finds amounts: symbol before, code before (`USD 5`, `Rs. 499`), code after (`5 USD`), thousands
   groups in Western or Indian form (`₹1,49,999`), decimals, `k`/`m`. A bare number is not a price.
2. Evidence mentions: for every amount in every evidence doc, context = words since the previous amount plus up to
   6 words after ("$0.30 per million requests"), plus the doc's `about` words. Words are lowercased, stemmed
   (plural `s`, `ies`), stop words and numbers removed.
3. Answer mentions: context = the amount's own clause (cut at `, ; : ( )`, and, but, while, whereas, vs, `**`) plus
   up to 6 words after; a table row is one context. Citations `[n]` right after the amount (to the end of the cell
   or sentence) are recorded. `past` is true when "was, were, used to be, previously, from, then, earlier, before"
   precedes it, or "then/before/earlier/previously" follows within 3 words.
4. Product of a mention: the product names (from `names`) in its own clause; if none, the names in the latest
   sentence before it that names any (same line, then earlier lines, then the text already shown).
5. A mention is supported when some evidence amount has the same amount (within 0.005), compatible currency, is not
   `pastOnly` unless the mention is `past`, and:
   - its context shares a product word with the mention's product, or
   - neither names a product and their context words overlap (or the mention has no context), or
   - the mention cites `[n]` and source `n` states that amount and does not name only another product.
6. Otherwise it may be a total: some supported price in the same line, or a sourced price for the same product,
   times a factor equals it within 0.5%. Factors: plain numbers in the line (2 to 100,000, optionally "seats",
   "users", "months"), numbers in the user's question (`questionMultipliers`), and 12 (a year).
7. Everything else is returned as unsupported.

`grammarClaims(text)` is a tiny fact grammar ("Neon: the Launch plan costs $19 per month.") used by the fake model
and the fixture web.

### 2.7 `src/grounding.ts`: the streaming guard

State: `line` (the unfinished unit), `emitted` (characters of `line` already sent), `done` (last 4,000 characters of
finished text, for "the product named earlier"), `flagged`.

`push(text)`:

1. Append to `line`.
2. While a boundary exists, `finish` the unit up to it and continue with the rest. A boundary is a newline, or
   outside a table a sentence end: `.`, `!` or `?` (not the dot of "Rs.") optionally followed by citations
   `[n]`, followed by whitespace. So "$0.30" is never cut at its dot. A table row (`|` first) ends only at a newline.
3. For the unfinished rest: send everything before the first price-start character (a currency sign, a digit, or a
   code `USD EUR GBP INR Rs`); hold the rest. Text without numbers therefore streams with no delay.

`finish(unit)`: if the held part has no price start, release it. Otherwise call `check(unit, before)`; for each
unsupported price insert ` (unverified)` right after it (or right after its number, when the currency code was
already sent), and record it in `flagged`. `end()` finishes whatever is held.

The check runs on the whole unit, including the part already sent, so context words before the price count.

### 2.8 `src/time.ts` and `src/timeparse.ts`: time-phrase resolution

`time.ts`: `Clock` (`now(): number`), `SystemClock`, `FakeClock` (`set`, `reset`), `CivilDate {y, m, d}`,
`civilDateOf(ms, tz)` via `Intl.DateTimeFormat.formatToParts` (cached per zone), `startOfDay(c, tz)` (guess at UTC
midnight, subtract the zone offset, re-check the offset once: DST-safe), `addDays`, `weekdayIndex` (Monday = 0),
`daysBetween`, `formatCivil` ("Tue 10 Nov", year added when it differs), `formatLocal` ("Tue 10 Nov, 14:05").

`parseTimeRefs(text, nowMs, tz)` returns `{refs: TimeRef[], rest}`. `TimeRef = {phrase, candidates: TimeRange[],
assumption?}`; a `TimeRange` is `[start, end)` in epoch ms with a label. Rules run in a fixed order and a span
already matched by an earlier (more specific) rule is skipped:

| Order | Phrase | Resolution |
|---|---|---|
| 1 | `2026-11-03` | that local day |
| 2 | "3 November", "3rd Nov 2026", "the 3rd of November" | the most recent such date on or before today (else last year); lowercase "may" is the verb, ignored |
| 3 | "November 3", "Nov 3rd, 2026" | same |
| 4 | "yesterday/today/this morning, afternoon, evening, night", "last night", "tonight" | the day narrowed to local hours: morning 5-12, afternoon 12-17, evening 17-24, night 20-28 (runs past midnight) |
| 5 | "on the 3rd", "the 21st" (not "the 2nd tier/plan/place...") | the most recent such day in this or the previous two months |
| 6 | "day before yesterday" | today − 2 |
| 7 | "yesterday" | today − 1 |
| 8 | "today", "earlier today", "this morning" ... | today |
| 9 | "N days/weeks/months ago" (digits or words, "a couple", "a few") | days: that day; weeks: ± 3 days around 7N days ago; months: ± 7 days around 30N days ago |
| 10 | "last week", "last weekend" | Monday to Sunday of the previous week; Saturday and Sunday of it |
| 11 | "this week" | this Monday to today |
| 12 | "last month", "this month" | the previous calendar month; the 1st to today |
| 13 | weekday with optional last/past/this/on/previous (full names only; "Monday.com" excluded) | see below |

Weekday rule: `back` = days since the most recent such weekday. "this X" is the X of the current week. If today is
that weekday, the candidates are a week ago, then today, with an assumption line. "last X" where the recent X falls
in the current week (on or after this Monday) is ambiguous: candidates are that day and the one a week earlier, with
an assumption. Example: on Wed 18 Nov, "last Tuesday" gives Tue 17 Nov then Tue 10 Nov. Otherwise one candidate.

**IST vs UTC day edges.** All day boundaries are local midnights in `USER_TIMEZONE`, computed by `startOfDay`, never
UTC days. With `Asia/Kolkata` (UTC+5:30), "today" said at 00:45 IST on Tue 17 Nov is
`[17 Nov 00:00 IST, 18 Nov 00:00 IST)` = `[16 Nov 18:30 UTC, 17 Nov 18:30 UTC)`, even though UTC still says 16 Nov.
The eval scenario `time-phrases-late-night` seeds a question at 23:40 IST on 16 Nov (18:10 UTC) and one at 00:20 IST
on 17 Nov (18:50 UTC): the same UTC day, different local days. At 00:45 IST it checks that "yesterday evening"
(Mon 16 Nov, 17:00 to 24:00 IST) quotes the 23:40 question, and that "today" returns only the 00:20 question.
`test/timeparse.test.ts` "ranges follow the user's timezone, not UTC" covers the same edge. The demo's daily
message cap also resets at local midnight (`today()` in `createDemoApp` uses `isoDate(Date.now(), tz)`).

`rest` is the text with matched phrases removed, used as the topic for routing and recall.

### 2.9 `src/memory.ts`: recall lookup

`recall(store, {refs, query, currentMessageId, sessionId, tz, nowMs, limit = 3})` returns
`{turns: PastTurn[], rangeLabel?, notes: string[]}`.

1. `terms = topicTerms(query)`: lowercased topic words, no pure numbers, at most 8.
2. With time references: choose the ref that is not "today/this morning/tonight" (in "Today, check what I asked
   last Tuesday", the earlier time is the one asked about). For each candidate range in order:
   - user messages in `[start, end)`, excluding the current one and earlier recall questions (`isContentTurn`);
     none: try the next candidate;
   - with terms: FTS5 hits inside the window. No hits and another candidate remains: try it (this is how "last
     Tuesday" picks the Tuesday that has a matching conversation). No hits on the last candidate: keep all messages of
     the window and add "On <day> you didn't ask about ...; here is what you did ask then.";
   - prepend the date line `**Last Tuesday = Tue 10 Nov.**` plus the assumption sentence when ambiguous ("I used
     ..." for the first reading, "You asked about this on ..., so I used that day." for a later one).
3. Nothing in any window: a date line (single candidate), then the closest FTS5 match from any date ("I have no
   conversation about this on X. The closest match is from Y, so I used that.") or "I have no record of a
   conversation on X."
4. Without time references: FTS5 over all user messages; else the previous user question in this session; else
   "I couldn't find an earlier conversation ...".

`toPastTurn` joins the question with its answer (`Store.answerTo`: the next assistant message in the session),
strips old `[n]` markers so they are never re-linked to new sources, and loads the answer's claims.

FTS details (`Store.searchUserMessages`): each term is wrapped in double quotes with inner quotes removed, joined by
`OR`, ranked by `bm25(messages_fts)` then newest first, limited to user messages in the window.

### 2.10 `src/recheck.ts`: re-check and the then/now diff

- `planRecheckQueries(claims, {maxQueries, newsSinceDays?})`: group claims by subject (first `maxQueries`
  subjects). Per subject one `recheck` query: subject + up to 3 attribute names without the word "price" +
  "pricing" when any attribute is a price, cost or fee (`depth: deep`, 4 results). With `newsSinceDays`, one
  `news-since` query per subject: `"<subject> news launch pricing update"` (`depth: basic`, 3 results,
  `sinceDays`).
- `dedupeClaims(claims, max)`: one claim per subject + attribute (case-insensitive), then `fairCap`.
- `recheckClaims(deps, claims, opts)`: run the queries; `rankSources(runs, subjects, now, 12)`;
  `llm.recheck({claims, sources})`. If that throws, every claim is `null` (never a guess). Each claim gets
  `diffClaim` with the found value, unit, source number and the source's date.
- `saveRecheck(store, outcome, messageId, sessionId, now)`: for every claim with a found value, insert a new claim
  version (`supersedes_id` = the old claim, unit falls back to the old one, source URL and date from the cited
  source); then `markRechecked` on all claims checked.

`AnthropicLLM.recheck` rejects a result whose `source_n` is not one of the given sources; `found=false` or an empty
value is `null`.

### 2.11 `src/watch.ts`: due-ness, caps, nudge de-duplication

- `WatchConfig {enabled, afterDays, maxSearches}` from `WATCH_ENABLED`, `WATCH_AFTER_DAYS` (3),
  `WATCH_MAX_SEARCHES` (3).
- `Store.watchCandidates(olderThan, limit)`: chain heads only (no claim supersedes them), whose
  `max(checked_at, rechecked_at)` is older than the cutoff, one per subject + attribute (the newest head), newest
  first, at most 60.
- `dueClaims(store, now, cfg, force)`: cutoff = `now − afterDays` (or `now + 1` when forced by "anything new?").
  Keep candidates of the first `maxSearches` distinct subjects, at most `MAX_FACTS_PER_SUBJECT = 8` facts each. All
  due facts of a chosen subject are included because they share its one search; leaving one out made the next new
  chat search the same subject again (live run 2).
- `rowsToShow(rows, max = 6)`: changed, then unverified, then unchanged; original order within each group.
- `checkWatchlist(deps, sessionId, now, cfg, signal?)` writes nothing; it returns `{nudge, commit(shown)}` or `null`:
  1. Off, nothing due, or `signal` aborted (before or after the searches): `null`.
  2. `recheckClaims` with `maxQueries = maxSearches`, no news queries, and the signal, which reaches every search
     and the re-check model call (no model call at all once aborted).
  3. `nudge`: `null` when nothing changed (silence), else one line for the first change, for example:
     `**Heads-up:** something you asked about on Tue 10 Nov has changed. Neon Launch plan price: $19 per month then, **$25 per month** now [1] (source dated 2026-11-12). (1 more change: ask me "anything new?")`
  4. `commit(shown)`: unchanged facts always become new versions and are marked checked. With `shown`, the
     announced change also becomes the new version and every checked fact is marked checked (the line names the
     other changes; "anything new?" reports them). Without `shown`, no change is saved and changed facts are not
     marked checked, so they stay due.
- `Agent.nudge(sessionId, signal?)`: only for an existing, empty session. After the check: aborted means `null`
  with nothing written; otherwise `shown` = a change was found and the session is still empty, then `commit(shown)`
  and, if shown, the line is stored as the first assistant message (`meta.intent = "nudge"`; the session stays
  untitled, hidden from the sidebar until the user writes). node:sqlite is synchronous, so the emptiness check,
  the commit and the insert run as one step.

A change is therefore saved exactly when the user is shown it. "Never twice": the announced change is now the chain
head, so the next check compares against the new value. "Never lost": a nudge dropped because the user typed first,
or cancelled, leaves the old value as the head and the fact due, so the next new chat announces the change and
"anything new?" (which compares against the head) reports it.

### 2.12 `src/llm/*`: the model port

```ts
interface LLM {
  readonly name: string;
  route(input: RouteInput): Promise<Omit<RoutePlan, "via">>;
  streamAnswer(input: AnswerInput): AsyncIterable<AnswerEvent>;      // text | tool_call | round_state (one round of the loop)
  extractClaims(input: { question; answer; sources }): Promise<NewClaim[]>;
  recheck(input: { claims; sources }): Promise<Array<RecheckResult | null>>;
}
```

`AnthropicLLM` (`anthropic.ts`):

| Job | Model | Settings |
|---|---|---|
| `route` | `FAST_MODEL` | JSON schema output (`ROUTER_SCHEMA`: intent chat/recall/verify/search, queries, since_days 0-365, memory_query, high_stakes), effort low, 4 s, 1 retry, 1,024 tokens |
| `extractClaims` | `FAST_MODEL` | `EXTRACT_SCHEMA`, 20 s, 4,096 tokens; at most 24 claims; `source_n` mapped to a source URL and date |
| `recheck` | `FAST_MODEL` | `RECHECK_SCHEMA`, 15 s, 4,096 tokens |
| `streamAnswer` | `ANSWER_MODEL` | `beta.messages.stream`, 16,000 max tokens, system prompt cached (`ephemeral`), effort low for chat/recall else `ANSWER_EFFORT`, a client tool `web_search` (`{query}`; the agent runs it) defined when `maxSelfSearches > 0` or earlier rounds exist, `tool_choice: none` once the budget is 0, earlier rounds replayed as assistant `tool_use` + user `tool_result` messages (`renderRounds`, `renderToolResult`), server-side fallback beta, optional `speed: fast` |

Stream mapping: `text_delta` gives `text`; a `tool_use` block's JSON input gives `tool_call {id, query}` at its end;
when the stop reason is `tool_use`, `round_state` carries the assistant content blocks so the next round replays them
exactly. Stop reasons `refusal` and `max_tokens` append one closing line. Every call runs `meter.check()` first and
`meter.add()` after.

`prompts.ts` holds every prompt. System prompts are fixed strings (a byte-stable, cacheable prefix); everything per
turn goes into the user turn as tagged sections: `<now>`, `<high_stakes>`, `<memory>`, `<comparison>`, `<shown>`,
`<notes>`, `<sources>`, `<question>`. `defang()` replaces any tag-like text from pages that names one of these
sections (or `system`, `instructions`, `facts`) with `[tag removed]`.

`FakeLLM` (`fake.ts`) is deterministic: routes with the same rules, writes only facts it can read with
`grammarClaims`, and copies live behaviours that hid bugs: given a search budget it calls `web_search` for gaps (nothing found, or a
named product no source covers), does not repeat
notes, paraphrases earlier questions, and with `slowRouter` its router always fails.

### 2.13 `src/usage.ts` and `src/demo/budget.ts`: spend meter and budget

`UsageMeter(limitUsd | null)`: `add(model, usage)` prices input, output, cache write (1.25×), cache read (0.1×) and
web searches ($0.01 each), and counts calls and searches per model. `check()` throws `BudgetExceededError` when
`costUsd ≥ limitUsd`. It is called before every paid request (`AnthropicLLM.json`, `streamAnswer`,
`AnthropicWebSearch.search`). The check is before the call, so one call can overshoot the cap by its own cost.

`LedgerMeter extends UsageMeter` (demo): the in-memory limit is off; `add` writes the delta of cost, calls and
searches to the `ledger` row at once; `check()` reads the ledger and throws with `BUDGET_USED_UP`;
`canStart(running, reserve)` requires `spent + (running + 1) × reserve ≤ budget`; `usedPct()` for status.
`npm run demo:budget [-- --reset]` shows or resets the ledger (`src/demo/budget-cli.ts`).

### 2.14 `src/app.ts` and `src/demo/*`: HTTP and the demo visitor lifecycle

Routes (shared by both modes):

| Method, path | Purpose |
|---|---|
| `GET /api/health` | Mode, fake reason, model and search names, timezone, now, clock settable, watch on; `demo` limits in demo mode (fake reason "hosted demo, offline test web" only when the demo runs in fake mode; never the server's `.env` details) |
| `GET /api/logo?domain=` | Logo image or letter tile |
| `POST /api/clock` `{now}` or `{reset: true}` | Move the demo clock (fake mode, `ALLOW_CLOCK_OVERRIDE=1`, or the visitor's own clock in the demo) |
| `GET /api/sessions` | Titled sessions, newest first (max 100) |
| `POST /api/sessions` | New session id |
| `POST /api/sessions/:id/nudge` | The right-moment check under one `AbortController`: aborted after 12 s (`NUDGE_TIMEOUT_MS`), when the client goes away, or (demo) by the visitor's next message; an aborted nudge writes nothing and answers `{nudge: null}` |
| `GET /api/sessions/:id/messages` | Messages with sources, warnings, intent, timings |
| `POST /api/chat` `{sessionId?, text}` | SSE stream of `AgentEvent` |
| `GET /api/demo/status` | Demo only: fake or not, model and search provider, budget used, visitors, open visitors, streams |
| `GET /<path>` | Static files from `public/`; a path without an extension serves `<path>/index.html` |

Session ids must match `[\w-]{1,64}`. Every POST passes the Origin and content-type checks before routing.
Both modes send the same security headers (`securityHeaders` in `src/app.ts`): a CSP for our own origin (`default-src 'self'`,
inline scripts only by the SHA-256 of the theme snippet in `index.html` and `report/index.html`, `style-src 'self' 'unsafe-inline'`,
`img-src 'self' data:`, `font-src 'self'`, `frame-ancestors 'none'`), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy:
no-referrer`, COOP, `Permissions-Policy`, and HSTS in the demo behind HTTPS.

Visitor lifecycle (demo):

1. **Request arrives.** `before()` sets headers, takes one token from the per-IP request bucket, enforces the
   access code if set (`?code=` sets an HMAC access cookie and redirects with 303 to a same-site path), then
   verifies `minimi_visitor`. No valid cookie: a new 128-bit id. The cookie is re-issued on page loads (sliding TTL)
   and when signed with the previous secret. `registry.touch` updates `last_seen` at most once a minute.
2. **First write.** Read-only routes return empty results for an unknown visitor (`ctx(req, false)` is `null`).
   A write calls `registry.register`, which refuses with `demo_full` at `DEMO_MAX_VISITORS`.
3. **Open.** `VisitorPool.get(id)` returns the open visitor and moves it to the most-recent end of the `Map`, or
   builds one: `FakeClock` from the saved `clock_ms`, `buildAgent` with `DATA_DIR/visitors/<id>.db` and the shared
   `LedgerMeter`.
4. **LRU.** After opening, `evictIdle` walks from the least-recent end and closes idle visitors (`active == 0`)
   until at most `DEMO_OPEN_VISITORS` are open. Closing waits for `agent.idle()` (background claim extraction) before
   closing the database.
5. **Chat admission** (`admit`): non-empty text, at most `DEMO_MAX_MESSAGE_CHARS`, a per-IP message token, the
   visitor not already streaming, fewer than `DEMO_MAX_STREAMS` streams, then `registry.takeMessage` (an atomic
   `UPDATE ... WHERE msgs_today < limit` that resets on a new day). If the budget cannot cover the reserve, the
   message is refunded and a final `demo_budget` error event is sent. The stream is aborted after
   `DEMO_STREAM_TIMEOUT_MS`.
6. **Sweep.** At start and every hour (or every TTL if shorter): `registry.expired(now − TTL)` (500 at a time);
   `pool.remove` skips busy visitors, closes, deletes `<id>.db`, `-wal`, `-shm` and the registry row; any visitor
   file the registry does not know is deleted. Idle token buckets are pruned.

`TokenBuckets(capacity, perMinute, maxKeys = 50,000)`: continuous refill; `take` returns 0 or the seconds to wait;
the `Map` is kept in least-recently-used order and the oldest key is dropped when full.

`src/server.ts` adds socket limits in demo mode: `requestTimeout` 30 s, `headersTimeout` 15 s, `keepAliveTimeout`
5 s, `maxConnections` 512, `maxHeaderSize` 16 KB.

### 2.15 `src/logo.ts` and `src/brand.ts`: logo pipeline

`GET /api/logo?domain=neon.com`:

1. `cleanDomain`: lowercase, strip a trailing dot, must match a hostname pattern (4-253 characters, labels of
   letters, digits and hyphens, a 2-63 letter TLD), not an IP, not `.local .localhost .internal .lan .home.arpa
   .test .invalid .example`. Else 400.
2. `LogoService.get(domain)`: memory cache (500 entries, hit TTL 7 days, miss TTL 1 day), then disk cache
   (`<domain>.img` re-sniffed on read, `<domain>.none` for a miss, same TTLs by file mtime), then a fetch
   (deduplicated per domain, at most 6 in parallel). `LOGO_FETCH=0` skips fetching.
3. `fetchLogo`: GET `https://<domain>/` (300 KB cap); read `<link rel="icon|apple-touch-icon">` (`iconLinks`:
   apple-touch-icon first, then larger `sizes`; SVG and `data:` skipped); try the best 3. Then `/favicon.ico`. Then
   `https://icons.duckduckgo.com/ip3/<domain>.ico`.
4. Every fetch (`httpsFetcher`, 4 s total): https only, default port, no credentials, no IP literal, at most 3
   redirects (each hop re-checked), the DNS lookup replaced by `publicOnlyLookup` which rejects the host if any
   address is loopback, private, link-local, CGNAT, documentation, multicast, IPv4-mapped private or other
   non-public ranges. Bodies over the cap are aborted.
5. `sniffImage`: PNG, ICO, GIF, JPEG or WebP by magic bytes; anything else (SVG, HTML) is refused.
6. Response: the image, or `monogram(domain)` (an SVG letter tile with a colour from the domain's hash), with
   `nosniff` and `content-security-policy: default-src 'none'; style-src 'unsafe-inline'`; cached 7 days (1 hour
   for the tile).

`BrandBook` picks the domain to show on a search step: the first word of the query looked up in learned domains,
then a seed list of about 30 products; after a search, a result on the subject's own site teaches the book that
domain (cleared after 500 entries). It never uses the top result from another site.

---

## 3. SQLite schema

From `src/db.ts` `SCHEMA` (per user). Pragmas: `journal_mode = WAL`, `foreign_keys = ON`.

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                       -- UUID
  title TEXT NOT NULL DEFAULT '',            -- first 80 chars of the first user message; '' = hidden
  created_at INTEGER NOT NULL,               -- epoch ms
  updated_at INTEGER NOT NULL
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,               -- epoch ms, UTC
  meta TEXT NOT NULL DEFAULT '{}'            -- JSON: intent, via, replyTo, sources, warnings, notes, timings, aborted
);
CREATE INDEX messages_time    ON messages(role, created_at);
CREATE INDEX messages_session ON messages(session_id, id);
CREATE INDEX searches_message ON searches(message_id);
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content, content='messages', content_rowid='id', tokenize='porter unicode61'
);
-- triggers messages_ai (after insert) and messages_au (after update of content) keep messages_fts in sync
CREATE TABLE searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id),   -- the user message
  query TEXT NOT NULL,
  provider TEXT NOT NULL,                    -- tavily | anthropic-web-search | fake (self-search rows use the same provider)
  purpose TEXT NOT NULL,                     -- speculative | answer | recheck | news-since | verify-freeform | self-search
  results TEXT NOT NULL,                     -- JSON results, or {"error": "..."}
  fetched_at INTEGER NOT NULL
);
CREATE TABLE claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER REFERENCES messages(id),            -- the answer; NULL for a background watchlist re-check
  session_id TEXT NOT NULL,
  subject TEXT NOT NULL,                     -- "Neon"
  attribute TEXT NOT NULL,                   -- "Launch plan price"
  value TEXT NOT NULL,                       -- "$19", or "$19 (unverified)"
  unit TEXT,                                 -- "per month"
  source_url TEXT,
  source_date TEXT,                          -- ISO date of the source
  checked_at INTEGER NOT NULL,               -- when this version was stated or confirmed
  rechecked_at INTEGER,                      -- last re-check attempt, even if not confirmed
  supersedes_id INTEGER REFERENCES claims(id)            -- the previous version of the same fact
);
CREATE INDEX claims_supersedes ON claims(supersedes_id);
CREATE INDEX claims_message    ON claims(message_id);
CREATE INDEX claims_subject    ON claims(subject COLLATE NOCASE);
```

Main queries: `userMessagesBetween` uses `messages_time`; `sessionMessages` and `recentMessages` use
`messages_session`; `searchUserMessages` joins `messages_fts`; `watchCandidates` uses `claims_supersedes` and
`claims_subject` with two correlated sub-queries; `rootClaim` walks `supersedes_id` up to 50 steps.
`searchesFor` uses `searches_message`.

Demo registry (`src/demo/registry.ts`, `DATA_DIR/demo.db`), pragmas `WAL`, `synchronous = FULL`,
`busy_timeout = 2000`:

```sql
CREATE TABLE visitors (
  id TEXT PRIMARY KEY,                       -- 32 hex chars
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,                -- written at most once a minute
  day TEXT NOT NULL DEFAULT '',              -- local date of msgs_today (USER_TIMEZONE)
  msgs_today INTEGER NOT NULL DEFAULT 0,
  clock_ms INTEGER                           -- the visitor's demo clock; NULL = real time
);
CREATE INDEX visitors_seen ON visitors(last_seen);
CREATE TABLE ledger (
  id INTEGER PRIMARY KEY CHECK (id = 1),     -- exactly one row
  spent_usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  web_searches INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
```

---

## 4. Stream events

Framing: `data: <one JSON object>\n\n` per event, `content-type: text/event-stream`. Types from `AgentEvent`
(`src/agent.ts`). Example turn for a comparison:

```json
{"type":"turn","sessionId":"6f0c…","userMessageId":41,"at":1763372700000,"atLabel":"Tue 17 Nov, 15:15"}
{"type":"status","text":"Searching the web for Supabase, Neon, Railway (4 searches in parallel)"}
{"type":"search","query":"What does Postgres hosting cost on Supabase, Neon and Railway?","state":"running"}
{"type":"search","query":"Supabase pricing","state":"running","domain":"supabase.com"}
{"type":"route","intent":"search","via":"model","queries":["What does Postgres hosting cost on Supabase, Neon and Railway?","Supabase pricing","Neon pricing","Railway pricing"]}
{"type":"search","query":"Neon pricing","state":"done","results":5,"domain":"neon.com"}
{"type":"status","text":"5 results for \"Neon pricing\" (2 of 4 searches done)"}
{"type":"sources","sources":[{"n":1,"title":"Pricing | Supabase","url":"https://supabase.com/pricing","domain":"supabase.com","date":"2026-10-01","official":true,"quote":"Supabase: the Pro plan costs $25 per month."}]}
{"type":"delta","text":"Supabase Pro is $25 per month [1]."}
{"type":"warning","text":"I couldn't match $14 to a current source. Treat it as unverified."}
{"type":"done","assistantMessageId":42,"at":1763372719000,"atLabel":"Tue 17 Nov, 15:15","timings":{"routeMs":1502,"evidenceMs":3120,"firstStatusMs":1,"firstTokenMs":5480,"firstModelTokenMs":5480,"totalMs":12010}}
```

| Type | Fields | Notes |
|---|---|---|
| `turn` | `sessionId`, `userMessageId`, `at`, `atLabel` | Always first. |
| `status` | `text` | Human progress. The UI hides the "(N of M searches done)" lines because steps show them. |
| `search` | `query`, `state` (`running`, `done`, `failed`, `cancelled`), `results?`, `domain?` | `domain` drives the step's logo. Searches of the answer model's own loop have no per-search end; the UI closes them on `done`. |
| `route` | `intent`, `via` (`rules`, `model`, `fallback`), `queries` | Sets the badge. |
| `sources` | `sources: PublicSource[]` | `{n, title, url, domain, date?, official, quote?}`. Sent again when sources are added. |
| `delta` | `text` | Code-rendered lines arrive as one delta ending in a blank line. |
| `warning` | `text` | Search failure or an unverified price. |
| `error` | `message`, demo adds `code: "demo_budget"`, `final` | `final: true` means the turn was refused before it started (no `done` follows). |
| `done` | `assistantMessageId`, `at`, `atLabel`, `timings` | Always last for an admitted turn, even after an error or abort. |

Verify turn, code-rendered delta (before the model writes):

```json
{"type":"delta","text":"**Last Tuesday = Tue 10 Nov.**\n\nYou asked on Tue 10 Nov, 14:05: \"What does Postgres hosting cost on Supabase, Neon and Railway?\"\n\n"}
{"type":"delta","text":"Since Tue 10 Nov: **1 changed**, 2 unchanged.\n\n| What | Then (Tue 10 Nov) | Now (Wed 18 Nov) | Status |\n|---|---|---|---|\n| Neon: Launch plan price | $19 per month | $25 per month [2] | **Changed** |\n…\n\n"}
```

Demo budget refusal (the only frame of the response):

```json
{"type":"error","code":"demo_budget","final":true,"message":"The demo budget is used up, so this hosted demo has stopped answering. The full app runs on your own machine in fake mode, no key needed: clone the repo, then run npm install and npm run dev."}
```

---

## 5. Errors and how they surface

Server side (`HttpError(status, message, code?, retryAfter?)` in `src/app.ts`; JSON body `{error, code?, retryAfter?}`,
plus a `Retry-After` header):

| Status | Code | Cause |
|---|---|---|
| 400 | | Empty message, body not JSON, bad clock value, bad logo domain |
| 400 | `too_long` | Demo message over `DEMO_MAX_MESSAGE_CHARS` |
| 401 | `access_required` | Demo access code missing (API); HTML form for pages |
| 403 | | Foreign `Origin`; clock not settable |
| 404 | | Unknown route or file |
| 413 | | Body over the cap (64 KB, demo 16 KB) |
| 415 | | POST without `application/json` |
| 429 | `rate_limited`, `daily_limit`, `busy` | Per-IP bucket; per-visitor daily cap (retry at local midnight); one answer per visitor (a running nudge is not an answer: the message cancels it) |
| 503 | `demo_full`, `busy_global` | Visitor cap; global stream cap |
| 500 | | Anything else: logged on the server, body "Something went wrong on the server." |

In-stream (`AgentEvent`): `warning` for failed searches and unverified prices; `error` when the model fails
(the partial text is kept and a line says so); the demo maps budget errors to `code: "demo_budget"` and hides
provider messages behind "The model service had a problem."

Client side (`public/js/api.js` `ApiError(kind, message, status, code)`):

| Kind | When | UI (`public/js/chat.js`) |
|---|---|---|
| `network` | `fetch` threw | Answer card error with Retry; page banner "Can't reach the minimi server" |
| `http` | Non-2xx response | The server's message; Retry only for 5xx or 429, never for `too_long`, `daily_limit`, `demo_full`, `access_required` |
| `cut` | Stream ended without `done` or a `final` error | "The connection dropped before the answer finished. What arrived is kept." with Retry |
| `agent` | An `error` event | "The answer stopped early: ..." with Retry, plus how to raise `MAX_SPEND_USD` on a spend cap; a demo `code` is shown plainly without Retry |
| `AbortError` | Stop pressed | Card marked stopped; the server saves the partial answer |

Unverified prices render as a warning chip on the number (`markdown.js`); warnings render under the answer. A
failed nudge is silent. `chat.js` cancels its nudge request when the user opens another chat, and shows a nudge the
server returned even if the user has started typing (the server returns one only if it stored it first).

---

## 6. Configuration

Read once in `src/config.ts` `loadConfig` (values from `.env` fill only unset or empty variables) and
`src/demo/config.ts` `loadDemoConfig` (a bad value refuses to start).

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | empty | Without it the app runs in fake mode |
| `TAVILY_API_KEY` | empty | Enables Tavily search |
| `FAKE_MODE` | off | `1` forces fake model, fixture web and a settable clock |
| `SEARCH_PROVIDER` | `auto` | `auto`, `tavily` or `anthropic`; `auto` = Tavily when its key exists |
| `ANSWER_MODEL` | `claude-opus-5-5` | Streams answers |
| `FAST_MODEL` | `claude-haiku-5-5` | Routing, extraction, re-check reading |
| `SEARCH_MODEL` | `claude-haiku-5-5` | Runs Claude `web_search` calls |
| `ANSWER_EFFORT` | `medium` | Effort for web answers (chat and recall always use `low`); must be low, medium or high |
| `FAST_OUTPUT` | off | `1` = `speed: fast` on the **answer** model |
| `ANSWER_MAX_SEARCHES` | 3 | Bound of the agent loop: follow-up searches the answer model may run per turn after the planned round (whole number, capped at 5) |
| `MAX_SPEND_USD` | none | Per-process spend cap (ignored in demo mode) |
| `WATCH_ENABLED` | 1 | `0` turns nudges off |
| `WATCH_AFTER_DAYS` | 3 | Age before a fact is due |
| `WATCH_MAX_SEARCHES` | 3 | Subjects per watchlist check and per "anything new?" |
| `USER_TIMEZONE` | the system zone (`Intl`) | Display and day boundaries; an unknown zone refuses to start |
| `MINIMI_NOW` | empty | Fixed "now" (ISO 8601) |
| `ALLOW_CLOCK_OVERRIDE` | off | `1` lets the UI move the clock with real keys (always on in fake mode) |
| `LOGO_FETCH` | 1 | `0` = letter tiles only, no network |
| `PORT`, `HOST` | 3000, `127.0.0.1` | Listen address |
| `DB_PATH` | `data/minimi.db` | Single-user database; logos cached in `logos/` next to it |
| `DEMO_MODE` | off | `1` = hosted demo |
| `DEMO_COOKIE_SECRET` | required in demo | 32+ characters |
| `DEMO_COOKIE_SECRET_PREVIOUS` | empty | Rotation |
| `DEMO_COOKIE_SECURE` | off | Always set `Secure` |
| `DATA_DIR` | `data/demo` | `demo.db`, `visitors/`, `logos/` |
| `DEMO_MAX_VISITORS` | 500 | Visitor cap |
| `DEMO_TTL_DAYS` | 7 | Delete after this long unseen |
| `DEMO_OPEN_VISITORS` | 200 | LRU size |
| `DEMO_BUDGET_USD` | 18 | Global hard budget |
| `DEMO_TURN_RESERVE_USD` | 0.25 | Reserve per running answer |
| `DEMO_MSGS_PER_VISITOR_PER_DAY` | 40 | Daily cap |
| `DEMO_IP_MSGS_PER_MIN` | 10 | Chat messages per IP |
| `DEMO_IP_REQUESTS_PER_MIN` | 240 | All requests per IP |
| `DEMO_MAX_MESSAGE_CHARS` | 2000 | Message cap (max 4000, the agent's own cap) |
| `DEMO_MAX_BODY_BYTES` | 16384 | Body cap |
| `DEMO_MAX_STREAMS` | 8 | Answers and nudges at once |
| `DEMO_STREAM_TIMEOUT_MS` | 120000 | Answer timeout |
| `DEMO_TRUST_PROXY` | off | Trust the last `X-Forwarded-For` entry and `X-Forwarded-Proto` |
| `DEMO_ACCESS_CODE` | empty | Invite code on first visit |
| `EVAL_LIVE`, `EVAL_ONLY`, `EVAL_VERBOSE`, `EVAL_RESULTS` | off | Eval: live models, one scenario, print answers, write result files |

---

## 7. Front-end module map

No framework and no build step: `public/index.html` loads `js/main.js` as an ES module. Data flows one way:
`api.js` → `chat.js` (controller) → `state.js` (store) → `render/*` (views).

| File | Role |
|---|---|
| `js/main.js` | Wiring: finds elements, subscribes views to the store, loads health and sessions, opens the session in the URL hash or a new chat |
| `js/api.js` | All server calls; `createSSEParser` (chunk boundaries, CRLF, broken frames skipped); `streamChat` async generator; `ApiError` with `retryable` |
| `js/state.js` | `createStore`: `get`, `set(patch)` (notifies with the changed keys), `subscribe`. State: health, serverError, online, sessions, sessionId, busy, sidebarOpen |
| `js/chat.js` | `createConversation`: new chat (then `checkNudge`), open session, send (maps each event type to a view call), stop, follow-scroll, follow-ups |
| `js/markdown.js` | Escape everything, then add own tags: paragraphs, lists, tables (then/now table gets status badges and a struck-out old value), `[n]` links to listed http(s) sources only, an "unverified" chip, date-reading and quote blocks |
| `js/dom.js` | `h(tag, attrs, ...children)`: text as text; `html:` only for static icons and `markdown.js` output; `copyText` |
| `js/time.js` | Dates in the agent's timezone relative to the agent's clock: sidebar groups, short times, clock input round trip |
| `js/theme.js` | Light or dark: follows the system until the user picks; remembered in `localStorage` |
| `js/icons.js` | Static inline SVG strings |
| `js/report.js` | The `/report` page from `report/data.json`: headline numbers, score timeline (SVG with a table alternative), runs, scenarios, latency |
| `render/message.js` | User bubble; assistant card (intent badge, steps, status, body re-rendered per animation frame, sources, warnings, footer with timing, "watching", copy); nudge style |
| `render/steps.js` | One row per search (logo, query, spinner then check and count); folds into "Searched N sites" when the answer starts; cancelled steps handled |
| `render/sources.js` | Source list: logo, site, date, bold title, grey quote, "Official" mark; numbers match `[n]` |
| `render/logo.js` | Logo tile from `/api/logo` |
| `render/sidebar.js` | Sessions grouped Today, Yesterday, This week, Earlier; status chip |
| `render/home.js` | Empty-chat home with four quick actions (send now or fill the composer) |
| `render/composer.js` | Auto-growing input; Enter sends, Shift+Enter new line; Send becomes Stop while busy |
| `render/followups.js` | Next-step chips by intent (each a real question the router handles) |
| `render/banner.js` | Server down or browser offline, with a retry |
| `render/demo.js` | Demo notice: what is private, the limits, and what to do when the budget is used up |
| `css/tokens.css`, `layout.css`, `components.css`, `markdown.css`, `report.css` | Design tokens (WCAG AA ratios noted), layout to 360 px, components, answer styles, report page |

---

## 8. Test map

`npm test` runs `node --test test/*.test.ts` (134 tests, all passing; `npm run report` records the count in `public/report/data.json` and flags a stale README). `npm run eval` runs the same
scenarios with a readable report (131 checks).

| File | Covers |
|---|---|
| `test/nudge-lifecycle.test.ts` | A nudge dropped because the user typed first does not lose the change (next new chat announces it, once; "anything new?" reports it); a cancelled nudge passes its signal to searches and the model and writes nothing |
| `test/agent.test.ts` | Every eval scenario as a test; messages and searches stored with time; `searches_message` index used, also on a database made before it; all searches failing (no invented prices); stop saves a partial answer and no claims; memory across sessions; FTS input with quotes and operators; empty and oversized input; "today" plus an earlier time; a nudge never lands between a question and its answer |
| `test/router.test.ts` | Rules for small talk, recall, verify, "anything new"; deferring to the model; topic extraction; slow router falls back to search; model plans de-duplicated and capped at 5 |
| `test/precision.test.ts` | `ownQuestion` routing; per-product search for a new question after small talk; small-talk re-check needs no search; price checker clause and citation rules; totals; number formats (`$5.00`, `5 USD`, `USD 5`, `₹499`, `Rs. 499`, `₹1,49,999`); "Unchanged, now confirmed"; the eval's independent price check; arithmetic and definitions need no search; `defang` |
| `test/livegaps.test.ts` | Regressions from live runs: planner subjects; fan-out before a slow router; the tool is offered but unused when the planned sources cover every product; guard marks unsourced prices; source titles name products; invented price tracked as unverified; progress order; code-rendered "Last Tuesday = ..."; all 5 CRMs re-checked; canonical subjects and fair cap; "anything new?" bounds; "$50," parsing and plurals; search-model bullets as snippets; watchlist does not re-search after a nudge |
| `test/loop.test.ts` | Speculative search within the router budget; cancellation when no search is needed; agent loop: follow-up pages become cited, grounded sources; a missed product is searched again in one tool call; bounded (budgets 3, 1, 0; 3 searches; the 4th call refused); the spend cap stops searching; zero searches for chat, recall and arithmetic; stale copied price flagged; "nothing changed" never claimed with unverified facts; Anthropic search makes one call per query in parallel |
| `test/claims.test.ts` | Value comparison; diff statuses; table rendering and pipe escaping; price guard basics; fixture grammar; non-money values compared as text; amount, currency and product checks; honest summary |
| `test/timeparse.test.ts` | Yesterday, today, day before; weekdays incl. ambiguous "last Tuesday" and same-weekday; explicit dates both orders; dates later this year mean last year; invalid dates; relative spans; timezone (not UTC) ranges; ordinary words and "Monday.com" are not dates; parts of a day incl. last night past midnight; "on the 3rd" vs "the 2nd tier" |
| `test/ui-stream.test.ts` | Search step events for searches, re-checks and cancellations; brand book; logo domain validation, public-address checks at connect time, image sniffing, icon link order, caching and fallback order, `LOGO_FETCH=0` |
| `test/web.test.ts` | One rule picks the web_search version for answers and searches; Markdown escaping and safe links; citations only to listed sources; then/now table rendering; date and quote blocks and unverified chips; SSE parser edge cases; `retryable` rules; sidebar date groups and clock input in the agent's timezone |
| `test/config.test.ts` | Time zone defaults to the system zone, `USER_TIMEZONE` overrides, unknown zones refused; `ANSWER_EFFORT`, `PORT` and the other numbers validated (no NaN) |
| `test/demo.test.ts` | Single-user `/api/chat` refuses an empty message before creating a session; demo config refuses weak secrets; cookie signing and rotation; demo off equals the single-user app; visitor isolation; tampered cookies; ledger persistence and the typed budget event; daily cap; per-IP limits and proxy trust; length, body and header caps with no internals in errors; demo full; one answer per visitor and the global cap; access code; TTL sweep keeps busy visitors; typing cancels a running nudge (no 429, nothing written, change still reported); health and status name the real search provider; single-user mode sends the same security headers |
| `eval/scenarios.ts` | 12 scenarios: `postgres-last-tuesday`, `crm-shortlist-monday`, `what-did-i-ask-on-3-nov`, `right-moment-nudge`, `fast-paths-and-follow-ups`, `time-phrases-late-night`, `recall-precision-same-day`, `small-talk-and-own-question`, `no-search-needed`, `grounding-formats`, `prompt-injection-in-results`, `watchlist-nothing-changed` |
