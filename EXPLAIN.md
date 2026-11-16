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
   queries. Meanwhile code has already started the searches: the question itself plus, for a comparison, one search
   per product it names ("Supabase, Neon and Railway" = 3 searches). If the router says "no search", they are cancelled.
4. **Gather evidence**:
   - chat: nothing;
   - recall: look up the earlier conversation in memory (time window + keyword search);
   - search: one query per product, **in parallel** (`src/planner.ts`), rank official and recent pages first and keep
     every product's best page (`src/search/rank.ts`);
   - verify: find the earlier answer, load its stored facts ("claims"), search for exactly those facts in parallel,
     have the small model read the current values, and **compare in code** (`src/recheck.ts`, `src/claims.ts`).
5. **Show progress at once**: "Searching the web for Supabase, Neon, Railway (4 searches in parallel)", then a line
   per finished search. For memory questions, code writes "Last Tuesday = Tue 10 Nov" and quotes your earlier
   question before anything else.
6. **Stream the answer** from the big model (Opus), written only from the gathered sources, citing [1], [2] with dates.
7. **Grounding guard** (`src/grounding.ts`): while the answer streams, each sentence or table row with a price is
   checked against the sources before you see it; a price no source supports is shown as "$X (unverified)".
8. **Save**, then in the background extract the answer's facts into the claims table, filed under the products
   that were searched, for future re-checks.

## Every important decision, in plain words

- **Is it a real agent or a pipeline?** Both, on purpose. The agent owns the plan: route, one search per product,
  recall, re-check run as a fast parallel pipeline. Only when those searches find nothing does the answer model get
  the web_search tool itself (max 3). A free-running loop on every turn was slow (live: 15-35 s before the first
  word) and its prices weren't tied to sources we control.
- **Doesn't routing slow things down?** When the rules can't decide, the agent starts searching for the raw
  question immediately, while the router thinks. If the router says "no search", that search is cancelled; if the
  router is slow (over 1.5 s), the agent answers from the speculative search.
- **What if there's only an Anthropic key?** Search uses Anthropic's web_search tool: one small Haiku call per
  query, each allowed exactly one search, all in parallel. (We first batched all queries into one call; the model
  then ran whatever searches it liked, one after another.)
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
  `web_search` tool, which needs only the Anthropic key but costs a small model call per query (slower, run in
  parallel). Swapping
  providers is one file.
- **Why the "right moment" nudge?** That's minimi's product idea: speak up only when it matters. On a new chat the
  agent quietly re-checks a few old facts (bounded: max 3 searches, skipped if checked recently). If something
  changed, one line; if not, silence. It never repeats the same change.
- **Why fakes?** The model, search and clock are all injectable. Tests replay a whole week of conversations in
  milliseconds, offline, the same every time. That's how we prove memory and time behaviour.
- **Safety and cost:** spend cap (`MAX_SPEND_USD`), input size limits, the server listens on localhost only, FTS
  queries are quoted so user text can't inject search syntax, keys only in `.env`.

## What the first live run taught us (16 Nov: 26 of 36 checks passed; fixed since)

The offline tests passed 48/48, but the fakes were kinder than the real models. Five real gaps, and the fix for each:
1. **Searches didn't fan out.** The small router model took longer than its 1.5 s budget, so the plan fell back to
   "search the question once", and Opus then searched on its own. Fix: code reads the products from the question and
   searches each one itself; the answer model writes only from those results.
2. **Slow first word (16-37 s).** Because Opus was searching before writing. Fix: a progress line at once, one line
   per finished search, then Opus streams straight away (no tool).
3. **"Last Tuesday" not stated.** The date was right, but Opus skipped the note. Fix: code writes "Last Tuesday =
   Tue 10 Nov" at the top.
4. **Monday's conversation "not found".** Memory found it; Opus paraphrased it and the stored facts were capped at 12
   (3 CRMs with 4 tiers each), named "HubSpot Sales Hub" etc. Fix: code quotes the question; facts are filed under
   the searched product names, max 3 per product, so all 5 get re-checked.
5. **"Anything new?" too long.** 3 subjects (bounded) but every fact of each. Fix: max 2 facts per subject, in code.
The fakes now behave like the live models (slow router, ignores notes, paraphrases, searches when it can), and
`test/livegaps.test.ts` has a test per gap.

**Second live run (30 of 36).** Three more causes, fixed: (a) search snippets often lacked the price (citations are
fragments), so the search model's quoted bullet per URL is now kept too, and "$50," / plurals / "was $19" are read
correctly; (b) a CRM whose prices were all unverified was dropped from memory, so it was never re-checked: it is now
kept, marked "(unverified)", and short names ("Zoho") are filed as "Zoho CRM"; (c) a nudge re-checked only 2 facts
per subject, the rest stayed due and the next chat searched again: now every fact of a checked subject is checked
(same search), and only the table is capped.

**Interview lines:** "Why did offline pass and live fail?" Because the fake models were too cooperative; I made the
fakes as unhelpful as the real ones and added a test per live failure. "Where does grounding live?" In code: a
streaming guard, not a prompt rule. "Who decides what to search?" The agent, in code; models only fill gaps.

## The web page (public/)

No framework and no build step: the browser loads small ES modules. `api.js` talks to the server (and reads the
stream), `state.js` holds the one store, `chat.js` runs a turn (send, stop, retry, errors), `render/*.js` draw, and
`markdown.js` turns answers into HTML only after escaping every character, so model text can never inject markup.
The page shows the agent's work because the server now sends a typed `search` event per web search (started,
finished with N results, failed, cancelled) and the product's site, so each search appears with its logo, a spinner,
then a check. Logos are fetched by our server, not the browser (`src/logo.ts`): public hosts only, real images only,
cached. The then/now table, the "Last Tuesday = Tue 10 Nov" note and "(unverified)" prices are recognised in the text
the agent's code writes, so a reloaded chat looks the same as a live one.

**Interview lines:** "Why no React?" The page is one screen with a few live parts; a store plus small render modules
is easy to read, needs no build, and `npm run dev` stays one command. "How do you stop XSS from model output?" Escape
first, then add only our own tags; links must be http(s); logos are re-served from our origin as sniffed images, and
our letter tiles (SVG) carry a no-script CSP.

## 10 likely interview questions

1. **Walk me through what happens when I ask "Last Tuesday I asked about Postgres hosting, has pricing changed?"**
   Rules route it to verify with no model call. "Last Tuesday" becomes two candidate days; memory finds the
   conversation on one of them; its stored facts (e.g. Neon Launch $19) are re-searched in parallel; the small
   model reads today's values; code builds the table; Opus writes 2-4 sentences on what changed, with sources.
2. **How do you make it fast?** Rules skip the router for common cases; searches start before routing and run in
   parallel; a progress line shows at once; the answer streams;
   claim extraction happens after the answer; the verify table shows before the model starts; small talk and
   recall never search.
3. **How do you stop it inventing prices?** In code, not just the prompt: the answer model only sees the sources the
   agent gathered, and a guard checks every price line before it is shown; an unmatched price appears as
   "(unverified)" and is never saved as a fact. Totals are allowed only as sourced price x your number. Tables come
   from code.
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
9. **What did you choose not to build?** A vector DB, an agent framework, a front-end framework or build step,
   multi-step autonomous browsing. Each adds latency or opacity without helping the core: right answers, remembered over time.
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
