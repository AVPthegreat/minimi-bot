# Design

minimi bot is a web-search chat agent that remembers **what you asked and when**, re-checks its own past answers,
and speaks first only when a change matters to you now. Depth: [HLD](docs/HLD.md), [LLD](docs/LLD.md),
[report](public/report/data.json) (`/report` in the app).

## Why a hybrid loop

A pure agent loop searches one call at a time: slow, costly, hard to test. A pure pipeline cannot follow up. So
**code plans the first round** (one search per subject a comparison names, in parallel), **then a bounded agentic
loop**: the answer model may call `web_search` itself if those sources fall short, at most `ANSWER_MAX_SEARCHES` = 3
times and within the spend meter. Every result is grounded the same way.

## Turn flow

```
message ─► saved with its time ─► time phrases → dates (code) ─► router: rules, else small model
  chat    ─► answer
  recall  ─► SQLite: time window + FTS5 ─► "Last Tuesday = Tue 10 Nov" + the quoted question
  search  ─► planned searches (parallel) ─► answer model ⇄ web_search (≤ 3) ─► grounding guard ─► stream
  verify  ─► recall ─► stored claims ─► re-search ─► small model reads values ─► then/now diff in code
                                                       └► claims extracted in the background ─► watchlist
```

## Memory and claims

Time is data: messages carry their time, and "last Tuesday" or "on the 3rd" become dates in code against an
injectable clock (an ambiguous phrase uses the reading with a matching conversation). Facts are rows: prices and plans
from answers become claims (subject, attribute, value, unit, source, date, what they supersede). "Is it still
correct?" re-searches exactly those facts; the then/now verdict is computed in code.

## The right moment

Stated facts form a watchlist. A new chat quietly re-checks up to 3 subjects older than 3 days. A change becomes a
nudge only if its score passes 0.15:

**score = importance × magnitude × timeliness**

- *Importance*: asked once 0.3; compared or shortlisted +0.25; asked in more than one message +0.25; "watch it for
  me" +0.5 (cap 1).
- *Magnitude*: relative price change, 20% or more = 1; a plan, feature or unit change 0.6; discontinued 1.
- *Timeliness*: halves every 14 days since you last asked; a watched fact keeps 0.5; a date you mentioned within
  14 days makes it 1.

Highest score first, one nudge per new chat, saying why: "You compared Neon with Supabase and Railway on Tue 10 Nov;
its Launch plan price dropped 21%". A change is saved only with the nudge that shows it: never twice, never lost if
you type first. Smaller changes wait for "anything new?". Weights: `src/rightmoment.ts`.

## Grounding (honest scope)

While the answer streams, every **price and number** is checked in code against the sources (amount, currency,
product); a total must be a sourced price times your number. Unbacked ones show as "(unverified)". Other statements
are cited, not checked in code.

## Cost and latency

Measured in live run 4 (16 Nov, 39 turns, before the agentic loop was added): web answers start after **12.8 s** and
finish in **19.6 s** (medians); memory answers finish in **2.9 s**, their date reading and quote at once. Run 4 cost
$1.53, about 4 cents a turn. A spend meter caps every run.

## Testing

Model, search and clock have fakes: 12 multi-day scenarios replay offline against a fixture web whose prices change
on known dates (`npm run eval`). Four live runs scored 72%, 83%, 92%, then 106 / 107; every miss became a fix and a
test.

## Decisions

| Decision | Why | Rejected |
|---|---|---|
| Planned parallel round, then a bounded tool loop | Fast and predictable, can still follow up | Pure agent loop: slow, serial, costly |
| Claims as rows, diff in code | Per-fact verdicts that can be tested | A model comparing prose |
| SQLite FTS5 + time windows | Recall is mostly *when*; exact, no extra service | Vector DB |
| Scored nudges, silent by default | A "no news" ping teaches you to ignore it | Nudge on any change |
| Plain Anthropic SDK | Every prompt and step visible | Agent frameworks: hidden control flow |
| Fakes as unhelpful as the live models | The offline eval catches what live runs caught | Live-only tests: flaky, paid |
