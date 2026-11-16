// Memory: one SQLite file (node:sqlite, built into Node 22, so no native build step).
// Four tables: sessions, messages (+ FTS5 index), searches (what we looked up and saw), claims
// (checkable facts pulled out of answers, so "is it still correct?" can re-check them one by one).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SessionRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: number;
  meta: string; // JSON
}

export interface ClaimRow {
  id: number;
  /** The answer the claim came from; null for background watchlist re-checks. */
  message_id: number | null;
  session_id: string;
  subject: string;
  attribute: string;
  value: string;
  unit: string | null;
  source_url: string | null;
  source_date: string | null;
  checked_at: number;
  /** Last time we tried to re-check it (even if the web did not confirm it). */
  rechecked_at: number | null;
  supersedes_id: number | null;
}

export interface NewClaim {
  subject: string;
  attribute: string;
  value: string;
  unit?: string | null;
  sourceUrl?: string | null;
  sourceDate?: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS messages_time ON messages(role, created_at);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content='messages', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  query TEXT NOT NULL,
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL,
  results TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS searches_message ON searches(message_id);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER REFERENCES messages(id),
  session_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  unit TEXT,
  source_url TEXT,
  source_date TEXT,
  checked_at INTEGER NOT NULL,
  rechecked_at INTEGER,
  supersedes_id INTEGER REFERENCES claims(id)
);
CREATE INDEX IF NOT EXISTS claims_supersedes ON claims(supersedes_id);
CREATE INDEX IF NOT EXISTS claims_message ON claims(message_id);
CREATE INDEX IF NOT EXISTS claims_subject ON claims(subject COLLATE NOCASE);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  // ---- sessions
  createSession(id: string, at: number): SessionRow {
    this.db.prepare("INSERT INTO sessions(id, title, created_at, updated_at) VALUES (?, '', ?, ?)").run(id, at, at);
    return { id, title: "", created_at: at, updated_at: at };
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  listSessions(limit = 100): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE title != '' ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as unknown as SessionRow[];
  }

  touchSession(id: string, at: number, titleIfEmpty: string): void {
    this.db
      .prepare("UPDATE sessions SET updated_at = ?, title = CASE WHEN title = '' THEN ? ELSE title END WHERE id = ?")
      .run(at, titleIfEmpty, id);
  }

  // ---- messages
  addMessage(sessionId: string, role: "user" | "assistant", content: string, at: number, meta: object = {}): number {
    const r = this.db
      .prepare("INSERT INTO messages(session_id, role, content, created_at, meta) VALUES (?, ?, ?, ?, ?)")
      .run(sessionId, role, content, at, JSON.stringify(meta));
    return Number(r.lastInsertRowid);
  }

  updateMessageMeta(id: number, patch: object): void {
    const row = this.db.prepare("SELECT meta FROM messages WHERE id = ?").get(id) as { meta: string } | undefined;
    if (!row) return;
    const meta = { ...JSON.parse(row.meta), ...patch };
    this.db.prepare("UPDATE messages SET meta = ? WHERE id = ?").run(JSON.stringify(meta), id);
  }

  getMessage(id: number): MessageRow | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
  }

  sessionMessages(sessionId: string): MessageRow[] {
    return this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id").all(sessionId) as unknown as MessageRow[];
  }

  /** The last `n` messages of a session before message `beforeId` (oldest first). */
  recentMessages(sessionId: string, beforeId: number, n: number): MessageRow[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
      .all(sessionId, beforeId, n) as unknown as MessageRow[];
    return rows.reverse();
  }

  /** The assistant reply to a user message (the next assistant message in the same session). */
  answerTo(userMessageId: number): MessageRow | undefined {
    return this.db
      .prepare(
        `SELECT a.* FROM messages a JOIN messages u ON u.id = ?
         WHERE a.session_id = u.session_id AND a.role = 'assistant' AND a.id > u.id
         ORDER BY a.id LIMIT 1`,
      )
      .get(userMessageId) as MessageRow | undefined;
  }

  /** User messages in a time window, oldest first. */
  userMessagesBetween(start: number, end: number, excludeId: number, limit = 50): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE role = 'user' AND created_at >= ? AND created_at < ? AND id != ?
         ORDER BY created_at LIMIT ?`,
      )
      .all(start, end, excludeId, limit) as unknown as MessageRow[];
  }

  /**
   * Keyword search over the user's past questions (FTS5, BM25 ranking), optionally inside a window.
   * `terms` are plain words; we quote them so user text can never inject FTS syntax.
   */
  searchUserMessages(terms: string[], opts: { start?: number; end?: number; excludeId: number; limit?: number }): MessageRow[] {
    if (terms.length === 0) return [];
    const match = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
    return this.db
      .prepare(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
         WHERE messages_fts MATCH ? AND m.role = 'user' AND m.id != ?
           AND m.created_at >= ? AND m.created_at < ?
         ORDER BY bm25(messages_fts), m.created_at DESC LIMIT ?`,
      )
      .all(match, opts.excludeId, opts.start ?? 0, opts.end ?? Number.MAX_SAFE_INTEGER, opts.limit ?? 5) as unknown as MessageRow[];
  }

  // ---- searches
  logSearch(messageId: number, query: string, provider: string, purpose: string, results: unknown, at: number): void {
    this.db
      .prepare("INSERT INTO searches(message_id, query, provider, purpose, results, fetched_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(messageId, query, provider, purpose, JSON.stringify(results), at);
  }

  searchesFor(messageId: number): Array<{ query: string; provider: string; purpose: string; fetched_at: number }> {
    return this.db
      .prepare("SELECT query, provider, purpose, fetched_at FROM searches WHERE message_id = ? ORDER BY id")
      .all(messageId) as unknown as Array<{ query: string; provider: string; purpose: string; fetched_at: number }>;
  }

  // ---- claims
  addClaims(messageId: number | null, sessionId: string, claims: Array<NewClaim & { supersedesId?: number | null }>, at: number): void {
    const stmt = this.db.prepare(
      `INSERT INTO claims(message_id, session_id, subject, attribute, value, unit, source_url, source_date, checked_at, supersedes_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of claims) {
      stmt.run(
        messageId, sessionId, c.subject, c.attribute, c.value, c.unit ?? null,
        c.sourceUrl ?? null, c.sourceDate ?? null, at, c.supersedesId ?? null,
      );
    }
  }

  claimsFor(messageId: number): ClaimRow[] {
    return this.db.prepare("SELECT * FROM claims WHERE message_id = ? ORDER BY id").all(messageId) as unknown as ClaimRow[];
  }

  /** Mark that we tried to re-check these claims (so the watchlist does not retry them for a while). */
  markRechecked(ids: number[], at: number): void {
    const stmt = this.db.prepare("UPDATE claims SET rechecked_at = ? WHERE id = ?");
    for (const id of ids) stmt.run(at, id);
  }

  /**
   * The watchlist: the newest version of every tracked fact (claims nobody has superseded),
   * last checked before `olderThan`, newest interest first, one per subject + attribute.
   */
  watchCandidates(olderThan: number, limit: number): ClaimRow[] {
    return this.db
      .prepare(
        `SELECT c.* FROM claims c
         WHERE NOT EXISTS (SELECT 1 FROM claims n WHERE n.supersedes_id = c.id)
           AND MAX(c.checked_at, COALESCE(c.rechecked_at, 0)) < ?
           AND c.id = (SELECT c2.id FROM claims c2
                       WHERE c2.subject = c.subject COLLATE NOCASE AND c2.attribute = c.attribute COLLATE NOCASE
                         AND NOT EXISTS (SELECT 1 FROM claims n2 WHERE n2.supersedes_id = c2.id)
                       ORDER BY c2.checked_at DESC, c2.id DESC LIMIT 1)
         ORDER BY c.checked_at DESC LIMIT ?`,
      )
      .all(olderThan, limit) as unknown as ClaimRow[];
  }

  /** The first claim in a re-check chain (it points at the answer the user originally saw). */
  rootClaim(claim: ClaimRow): ClaimRow {
    let cur = claim;
    for (let i = 0; i < 50 && cur.supersedes_id !== null; i++) {
      const prev = this.db.prepare("SELECT * FROM claims WHERE id = ?").get(cur.supersedes_id) as ClaimRow | undefined;
      if (!prev) break;
      cur = prev;
    }
    return cur;
  }

  /** The user question an assistant message answered. */
  questionFor(answerId: number): MessageRow | undefined {
    return this.db
      .prepare(
        `SELECT u.* FROM messages u JOIN messages a ON a.id = ?
         WHERE u.session_id = a.session_id AND u.role = 'user' AND u.id < a.id ORDER BY u.id DESC LIMIT 1`,
      )
      .get(answerId) as MessageRow | undefined;
  }

  close(): void {
    this.db.close();
  }
}
