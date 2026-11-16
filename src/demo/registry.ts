// The demo's own small database (DATA_DIR/demo.db), separate from every visitor's memory:
// who the visitors are (for the cap, the daily message limit, their clock and the TTL sweep)
// and the global spend ledger. SQLite so counters are atomic and survive restarts.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  day TEXT NOT NULL DEFAULT '',
  msgs_today INTEGER NOT NULL DEFAULT 0,
  clock_ms INTEGER
);
CREATE INDEX IF NOT EXISTS visitors_seen ON visitors(last_seen);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  spent_usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  web_searches INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO ledger (id) VALUES (1);
`;

export interface LedgerRow {
  spent_usd: number;
  calls: number;
  web_searches: number;
  updated_at: number;
}

export class DemoRegistry {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // FULL: the money ledger must not lose a committed write on a crash.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 2000;");
    this.db.exec(SCHEMA);
  }

  exists(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM visitors WHERE id = ?").get(id);
  }

  count(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM visitors").get() as { n: number }).n);
  }

  /** Adds a visitor unless the demo is full. node:sqlite is synchronous, so count-then-insert is atomic here. */
  register(id: string, now: number, max: number): "ok" | "full" {
    if (this.exists(id)) return "ok";
    if (this.count() >= max) return "full";
    this.db.prepare("INSERT INTO visitors (id, created_at, last_seen) VALUES (?, ?, ?)").run(id, now, now);
    return "ok";
  }

  touch(id: string, now: number): void {
    // At most one write a minute per visitor.
    this.db.prepare("UPDATE visitors SET last_seen = ? WHERE id = ? AND last_seen < ?").run(now, id, now - 60_000);
  }

  /** Counts one message for today; false (and nothing counted) when today's limit is reached. */
  takeMessage(id: string, day: string, limit: number): boolean {
    const r = this.db
      .prepare(
        `UPDATE visitors SET msgs_today = CASE WHEN day = ?1 THEN msgs_today + 1 ELSE 1 END, day = ?1
         WHERE id = ?2 AND (day <> ?1 OR msgs_today < ?3)`,
      )
      .run(day, id, limit);
    return Number(r.changes) === 1;
  }

  /** Gives back a message that never started (e.g. refused for the budget). */
  returnMessage(id: string, day: string): void {
    this.db.prepare("UPDATE visitors SET msgs_today = msgs_today - 1 WHERE id = ? AND day = ? AND msgs_today > 0").run(id, day);
  }

  messagesToday(id: string, day: string): number {
    const r = this.db.prepare("SELECT day, msgs_today FROM visitors WHERE id = ?").get(id) as { day: string; msgs_today: number } | undefined;
    return r && r.day === day ? Number(r.msgs_today) : 0;
  }

  clock(id: string): number | null {
    const r = this.db.prepare("SELECT clock_ms FROM visitors WHERE id = ?").get(id) as { clock_ms: number | null } | undefined;
    return r?.clock_ms == null ? null : Number(r.clock_ms);
  }

  setClock(id: string, ms: number | null): void {
    this.db.prepare("UPDATE visitors SET clock_ms = ? WHERE id = ?").run(ms, id);
  }

  /** Visitors not seen since `before`. */
  expired(before: number, limit = 500): string[] {
    return (this.db.prepare("SELECT id FROM visitors WHERE last_seen < ? ORDER BY last_seen LIMIT ?").all(before, limit) as Array<{ id: string }>).map((r) => r.id);
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM visitors WHERE id = ?").run(id);
  }

  ledger(): LedgerRow {
    const r = this.db.prepare("SELECT spent_usd, calls, web_searches, updated_at FROM ledger WHERE id = 1").get() as unknown as LedgerRow;
    return { spent_usd: Number(r.spent_usd), calls: Number(r.calls), web_searches: Number(r.web_searches), updated_at: Number(r.updated_at) };
  }

  addSpend(usd: number, calls: number, webSearches: number, now: number): void {
    this.db
      .prepare("UPDATE ledger SET spent_usd = spent_usd + ?, calls = calls + ?, web_searches = web_searches + ?, updated_at = ? WHERE id = 1")
      .run(usd, calls, webSearches, now);
  }

  resetLedger(now: number): void {
    this.db.prepare("UPDATE ledger SET spent_usd = 0, calls = 0, web_searches = 0, updated_at = ? WHERE id = 1").run(now);
  }

  close(): void {
    this.db.close();
  }
}
