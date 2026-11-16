# Hosted demo

`DEMO_MODE=1` turns minimi from a single-user app into a public demo: every visitor gets their own minimi
(own SQLite memory, sessions, watchlist and demo clock) and all of them share one hard spend budget on our
API key. Without `DEMO_MODE=1` nothing changes: one user, one `data/minimi.db`.

## Run it

```sh
npm ci
export DEMO_MODE=1
export DEMO_COOKIE_SECRET="$(openssl rand -hex 32)"   # keep it stable across restarts (see Rotation)
export ANTHROPIC_API_KEY=...                          # from your secret store; omit for an offline demo
export DATA_DIR=/var/lib/minimi-demo PORT=8787 HOST=127.0.0.1 DEMO_TRUST_PROXY=1
npm start
```

It refuses to start without `DEMO_COOKIE_SECRET` (32+ characters). Run **one** process: the limits and
the "answers running" counters live in that process (the ledger itself is in SQLite and survives restarts).

## Environment

| Variable | Default | What it does |
|---|---|---|
| `DEMO_MODE` | off | `1` = hosted demo |
| `DEMO_COOKIE_SECRET` | required | HMAC key for the visitor cookie, 32+ chars |
| `DEMO_COOKIE_SECRET_PREVIOUS` | empty | The old key during a rotation (still accepted, cookies re-signed) |
| `DATA_DIR` | `data/demo` | `demo.db` (visitors + ledger), `visitors/<id>.db`, `logos/` |
| `DEMO_BUDGET_USD` | 18 | Hard stop for all spend (keep it under the provider workspace limit, e.g. $20) |
| `DEMO_TURN_RESERVE_USD` | 0.25 | Held back per running answer before a new one may start |
| `DEMO_MAX_VISITORS` | 500 | New visitors beyond this see "the demo is full" |
| `DEMO_TTL_DAYS` | 7 | A visitor's data is deleted this long after their last visit (hourly sweep) |
| `DEMO_OPEN_VISITORS` | 200 | Visitors kept open in memory (LRU); idle ones are closed |
| `DEMO_MSGS_PER_VISITOR_PER_DAY` | 40 | Per visitor, resets at midnight in `USER_TIMEZONE` |
| `DEMO_IP_MSGS_PER_MIN` | 10 | Chat messages per IP (token bucket) |
| `DEMO_IP_REQUESTS_PER_MIN` | 240 | All requests per IP |
| `DEMO_MAX_MESSAGE_CHARS` | 2000 | Longer messages are refused |
| `DEMO_MAX_BODY_BYTES` | 16384 | Request body cap |
| `DEMO_MAX_STREAMS` | 8 | Answers (and nudges) running at once, server-wide; 1 per visitor |
| `DEMO_STREAM_TIMEOUT_MS` | 120000 | An answer is stopped (and saved) after this |
| `DEMO_TRUST_PROXY` | off | `1` = use the last `X-Forwarded-For` entry and `X-Forwarded-Proto` (only behind your proxy) |
| `DEMO_COOKIE_SECURE` | off | `1` = always mark cookies Secure (they already are when the trusted proxy says https) |
| `DEMO_ACCESS_CODE` | empty | When set, the first visit needs `?code=…` (then a cookie) |

The usual settings still apply (`ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, `USER_TIMEZONE`, `LOGO_FETCH`, models).
`MAX_SPEND_USD` is ignored in demo mode: the ledger replaces it.

## Behind Caddy (automatic HTTPS)

`deploy/Caddyfile.demo` is a complete site block: Caddy gets the certificate, keeps the original `Host` (the
app's cross-origin check compares it with `Origin`), sets `X-Forwarded-For` to the client address, sets
`X-Forwarded-Proto`, and flushes the answer stream at once. Bind the app to `127.0.0.1` so only Caddy reaches it,
and set `DEMO_TRUST_PROXY=1`. Then `caddy reload --config /etc/caddy/Caddyfile`.

Check: `curl -sI https://demo.example.com/` shows `content-security-policy`, `strict-transport-security` and a
`set-cookie: minimi_visitor=…; HttpOnly; SameSite=Lax; Secure`; `curl -s https://demo.example.com/api/demo/status`.

## The budget ledger

One row in `DATA_DIR/demo.db` (SQLite, `synchronous=FULL`). Every Anthropic call is priced with the same table as
`src/usage.ts` and added the moment its usage arrives, so a restart never forgets spend. Before every paid call the
ledger is checked; at `DEMO_BUDGET_USD` calls are refused and chat returns a typed event
`{type:"error", code:"demo_budget", final:true}` that the page shows with how to run minimi locally. A new message
also needs `spent + (answers running + 1) × DEMO_TURN_RESERVE_USD ≤ budget`, which bounds the overshoot from
answers already in flight. Set the provider's own workspace limit a little higher as the last line.

- Show: `DATA_DIR=/var/lib/minimi-demo npm run demo:budget`
- Reset (stop the server first): `DATA_DIR=/var/lib/minimi-demo npm run demo:budget -- --reset`
- Status for anyone: `GET /api/demo/status` → `{mode, fake, budgetUsedPct, budgetUsedUp, visitors, maxVisitors, openVisitors, streams}`

## Rotating the cookie secret

1. Set `DEMO_COOKIE_SECRET_PREVIOUS` to the current secret and `DEMO_COOKIE_SECRET` to a new one; restart.
2. Returning visitors are recognised with the old key and silently re-signed with the new one.
3. After `DEMO_TTL_DAYS`, remove `DEMO_COOKIE_SECRET_PREVIOUS` and restart.

If the secret leaked, skip step 1: everyone becomes a new visitor (their old data is swept after the TTL). Changing
the secret also resets the access-code cookie.

## What visitors get, and what they can't do

- A random 128-bit id in an HttpOnly, SameSite=Lax cookie, HMAC-signed; a forged or edited cookie becomes a new,
  empty visitor. All state is server-side under that id; ids are checked as 32 hex characters before they name a file.
- Their own clock (`POST /api/clock` moves only theirs, saved across restarts), never the server's.
- Typed refusals with `Retry-After`: `too_long` (400), `rate_limited`/`daily_limit`/`busy` (429), `demo_full`/`busy_global` (503), `access_required` (401).
- Headers on every response: CSP (own origin only; the inline theme script by hash), `frame-ancestors 'none'`,
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, HSTS behind https.
- Errors never carry stack traces or provider messages; the logo proxy stays https-only to public addresses.
