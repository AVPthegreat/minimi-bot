# Explaining this agent (for interviews)

Plain-language notes on every important decision, so you can defend each one. File names are where to point.

## The one-sentence pitch

It's a web-search chat agent that treats **time and memory as data**: every message is stored with when it was
said, every fact it tells you is stored as a checkable row, so "what did I ask on 3 November, is it still correct?"
becomes a precise lookup plus a re-check of exactly those facts, with a then/now table.

## How a message flows (src/agent.ts)

1. **Save it with the time** (SQLite, `src/db.ts`). Time is stored in UTC and shown in your timezone (default Asia/Kolkata).
2. **Resolve time words in code** (`src/timeparse.ts`): "yesterday", "on Monday", "last Tuesday", "3 November",
   "two weeks ago". No AI here: it's instant, testable, and can't hallucinate a date.
3. **Route** (`src/router.ts`): cheap rules first ("hi", "what did I ask", "still correct?", "anything new?"), and only
   if the rules aren't sure, a small fast model (Haiku) decides: chat, recall, verify, or search, and writes the search
   queries. If that model is slow (4 s) or fails, a fallback still answers.
4. **Gather evidence**:
   - chat: nothing;
   - recall: look up the earlier conversation in memory (time window + keyword search);
   - search: run 1-5 queries **in parallel**, rank official and recent pages first (`src/search/rank.ts`);
   - verify: find the earlier answer, load its stored facts ("claims"), search for exactly those facts in parallel,
     have the small model read the current values, and **compare in code** (`src/recheck.ts`, `src/claims.ts`).
5. **Stream the answer** from the big model (Opus), citing sources as [1], [2] with dates.
6. **Price guard**: every price in the answer must appear in the sources; if not, the UI shows a warning.
7. **Save**, then in the background extract the answer's facts into the claims table for future re-checks.

## Every important decision, in plain words

- **Why route instead of always searching?** Most messages that mention the past don't need the web, and "hi"
  shouldn't cost a search. Routing makes those instant and free. The obvious cases are caught by rules with no model
  call at all.
- **Why store "claims"?** "Has pricing changed since?" needs the old values. If you only store the old answer as text,
  you'd ask a model to compare two blobs of prose, which misses changes and invents others. With claims, it's a
  per-fact table: changed / unchanged / couldn't verify.
- **Why compare in code, not with the model?** A price either moved or didn't. Code can't misread "$19" as "$15". The
  model is only used for the fuzzy part: reading the current value off a web page.
- **Why render the table in code?** Same reason: the numbers in it are exactly the stored ones. It also streams
  before the model starts, so the user sees the key result immediately.
- **Why "couldn't verify" instead of keeping the old value?** Silently carrying forward old data is how an assistant
  becomes confidently wrong. Saying "couldn't verify" is honest.
- **Why deterministic time parsing?** Dates are where LLMs slip (off-by-one weekdays, timezones). Code is exact and
  unit-tested, including the timezone edge (2 am in India is still yesterday in UTC).
- **How does it handle "last Tuesday" when it's ambiguous?** It keeps both readings, checks which day actually has a
  matching conversation, uses that one, and says so in the answer.
- **Why SQLite + FTS5 and not a vector database?** Questions about the past are mostly "when" plus a few keywords.
  A time window plus keyword ranking is exact, explainable, needs no extra service, and ships inside Node 22. Vectors
  would help with paraphrases; that's in "another week".
- **Why no LangChain / agent framework?** The control flow is the product. Plain SDK calls keep every prompt and every
  step visible, testable, and easy to defend. About 2.7k lines total.
- **Why two models?** The small one (Haiku 5.5) does quick structured jobs (routing, extracting facts, reading
  values) in a fraction of a second at very low cost. The big one (Opus 5.5) writes what the user reads.
- **Which search provider and why?** Behind an interface (`src/search/types.ts`). Tavily is the default when its key
  exists: one fast HTTP call returns clean snippets and dates. Otherwise it uses Anthropic's own server-side
  `web_search` tool, which needs only the Anthropic key but costs a model call per query (slower). Swapping
  providers is one file.
- **Why the "right moment" nudge?** That's minimi's product idea: speak up only when it matters. On a new chat the
  agent quietly re-checks a few old facts (bounded: max 3 searches, skipped if checked recently). If something
  changed, one line; if not, silence. It never repeats the same change.
- **Why fakes?** The model, search and clock are all injectable. Tests replay a whole week of conversations in
  milliseconds, offline, the same every time. That's how we prove memory and time behaviour.
- **Safety and cost:** spend cap (`MAX_SPEND_USD`), input size limits, the server listens on localhost only, FTS
  queries are quoted so user text can't inject search syntax, keys only in `.env`.

## 10 likely interview questions

1. **Walk me through what happens when I ask "Last Tuesday I asked about Postgres hosting, has pricing changed?"**
   Rules route it to verify with no model call. "Last Tuesday" becomes two candidate days; memory finds the
   conversation on one of them; its stored facts (e.g. Neon Launch $19) are re-searched in parallel; the small
   model reads today's values; code builds the table; Opus writes 2-4 sentences on what changed, with sources.
2. **How do you make it fast?** Rules skip the router for common cases; searches run in parallel; the answer streams;
   claim extraction happens after the answer; the verify table shows before the model starts; small talk and
   recall never search.
3. **How do you stop it inventing prices?** Prompt rule plus a check: every price in the answer is matched against
   the sources and memory; unmatched ones are flagged. Tables come from code.
4. **What if search is down?** Each query fails independently; if all fail, the user is told the answer isn't
   backed by fresh sources, and the model is told not to state current facts.
5. **Why not just put the whole chat history in the context?** It grows forever, costs more every turn, and the model
   still has to guess dates. Indexed memory with timestamps answers "what did I ask on X" exactly.
6. **What's the weakest part?** Keyword recall misses paraphrases, and re-checks read snippets, not full pages.
   Both are first in "another week".
7. **How would it scale to many users?** Add a user id to sessions and claims; SQLite per user (it's a desktop agent)
   or Postgres server-side; the watchlist becomes a scheduled job.
8. **How do you test an agent?** Unit tests for the deterministic parts (time, diff, routing rules) and scripted
   multi-day conversations on a fake clock and a fixture web where prices change on known dates. Same scripts can
   run live with a spend cap.
9. **What did you choose not to build?** A vector DB, an agent framework, a fancy UI, multi-step autonomous
   browsing. Each adds latency or opacity without helping the core: right answers, remembered over time.
10. **How does this fit minimi?** minimi wants an assistant that catches what matters and pings at the right moment.
    Claims are "things to keep an eye on"; the watchlist re-checks them and speaks only when something changed.

## 60-second video script

"This is my chat agent with one tool: web search. I built it around one idea: time and memory are data.
Every message is saved with when you said it, and every fact the agent tells you, like a price, is saved as a row.
Watch: on the 10th I ask what Postgres hosting costs. It routes the question, runs three searches in parallel, and
streams an answer with dated sources. Now I move the clock to the 18th and ask: 'Last Tuesday I asked about Postgres
hosting, has pricing changed?' It works out that 'last Tuesday' could mean two days, finds the one where I actually
asked, re-checks exactly those prices, and shows a then-and-now table built by code, so the numbers can't be
misquoted. Neon dropped from 19 to 15 dollars. And if I just open a new chat, it re-checks old facts quietly and
tells me only if something changed, one line, never twice. That's minimi's 'right moment' idea. Under the hood:
rules and a small model for routing, Opus for answers, SQLite with full-text search for memory, a price checker
for honesty, and an offline eval that replays a whole week in milliseconds."
