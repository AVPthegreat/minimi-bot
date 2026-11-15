# Minimi Agent

A chat agent with one tool, web search, that remembers what you asked and when, re-checks its own
past answers ("is that still correct?"), and opens a new chat with one short heads-up only when
something you asked about has actually changed.

## Run it (3 steps)

1. `npm install` (Node 22.13 or newer; no native build step)
2. `cp .env.example .env` and set `ANTHROPIC_API_KEY` (optional: `TAVILY_API_KEY` for faster search)
3. `npm run dev` and open http://localhost:3000

Without a key it starts in **fake mode**: a deterministic model and a small offline test web, with a
demo clock in the sidebar so you can try memory across days (ask about Postgres hosting on 10 Nov,
move the clock to 18 Nov, ask "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?").

## Other entry points

| Command | What it does |
|---|---|
| `npm run chat` | The same agent in the terminal (`/new`, `/time <ISO date>`, `/quit`) |
| `npm test` | Unit tests + the whole offline eval (no network, no keys) |
| `npm run eval` | The multi-day eval with a readable report (`EVAL_VERBOSE=1` prints answers) |
| `npm run eval:live` | The same scripts against real Claude + search, capped at `MAX_SPEND_USD` (default $5) |
| `npm run typecheck` | `tsc --noEmit`, strict |

Programmatic use: `import { createAgent } from "./src/index.ts"` (see the comment at the top of that file).

Design and trade-offs: [DESIGN.md](DESIGN.md).
