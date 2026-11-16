// Every demo visitor gets their own minimi: their own SQLite file (sessions, memory, searches,
// watchlist), their own clock and their own Agent. They are opened lazily and kept in a small LRU;
// the least recently used idle one is closed when too many are open. Nothing is shared between
// visitors except the read-only model/search clients' prices and the global spend ledger.

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../agent.ts";
import type { Config } from "../config.ts";
import { buildAgent } from "../index.ts";
import { FakeClock } from "../time.ts";
import type { UsageMeter } from "../usage.ts";
import { isVisitorId } from "./cookie.ts";
import type { DemoRegistry } from "./registry.ts";

export interface Visitor {
  id: string;
  agent: Agent;
  clock: FakeClock;
  /** Chats and nudges running for this visitor right now; a busy visitor is never closed or deleted. */
  active: number;
}

export interface PoolOptions {
  config: Config;
  registry: DemoRegistry;
  meter: UsageMeter;
  dir: string;
  maxOpen: number;
  publicError: (e: Error) => string;
}

export class VisitorPool {
  private readonly open = new Map<string, Visitor>();
  private readonly closing = new Map<string, Promise<void>>();

  constructor(private readonly opts: PoolOptions) {}

  /** The visitor's database file. The id is checked (32 hex characters), so it can't escape the folder. */
  pathFor(id: string): string {
    if (!isVisitorId(id)) throw new Error("bad visitor id");
    return join(this.opts.dir, `${id}.db`);
  }

  get size(): number {
    return this.open.size;
  }

  /** The visitor's minimi, opened if needed. Call only for registered visitors. */
  get(id: string): Visitor {
    let v = this.open.get(id);
    if (v) {
      this.open.delete(id); // move to the most recently used end
      this.open.set(id, v);
      return v;
    }
    const saved = this.opts.registry.clock(id);
    const clock = new FakeClock(saved ?? undefined);
    const { agent } = buildAgent(this.opts.config, { clock, meter: this.opts.meter, dbPath: this.pathFor(id), publicError: this.opts.publicError });
    v = { id, agent, clock, active: 0 };
    this.open.set(id, v);
    this.evictIdle();
    return v;
  }

  peek(id: string): Visitor | undefined {
    return this.open.get(id);
  }

  private evictIdle(): void {
    for (const [id, v] of this.open) {
      if (this.open.size <= this.opts.maxOpen) return;
      if (v.active > 0) continue;
      this.open.delete(id);
      this.closeVisitor(v);
    }
  }

  private closeVisitor(v: Visitor): Promise<void> {
    // Background work (claim extraction) still writes to the store: let it finish first.
    const p = v.agent
      .idle()
      .catch(() => {})
      .finally(() => {
        try {
          v.agent.store.close();
        } catch {
          /* already closed */
        }
      });
    this.closing.set(v.id, p);
    void p.finally(() => {
      if (this.closing.get(v.id) === p) this.closing.delete(v.id);
    });
    return p;
  }

  /** Closes and deletes one visitor's data. Returns false (nothing done) if they are busy right now. */
  async remove(id: string): Promise<boolean> {
    const v = this.open.get(id);
    if (v) {
      if (v.active > 0) return false;
      this.open.delete(id);
      await this.closeVisitor(v);
    }
    await this.closing.get(id); // an earlier eviction may still be closing the file
    const file = this.pathFor(id);
    for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
    this.opts.registry.remove(id);
    return true;
  }

  /** Deletes visitors not seen since `before`, and any visitor file the registry no longer knows. */
  async sweep(before: number): Promise<number> {
    let n = 0;
    for (const id of this.opts.registry.expired(before)) if (await this.remove(id)) n++;
    let files: string[] = [];
    try {
      files = readdirSync(this.opts.dir);
    } catch {
      return n;
    }
    for (const f of files) {
      const id = f.match(/^([0-9a-f]{32})\.db(?:-wal|-shm)?$/)?.[1];
      if (id && !this.open.has(id) && !this.opts.registry.exists(id)) rmSync(join(this.opts.dir, f), { force: true });
    }
    return n;
  }

  async closeAll(): Promise<void> {
    const all = [...this.open.values()];
    this.open.clear();
    await Promise.all([...all.map((v) => this.closeVisitor(v)), ...this.closing.values()]);
  }
}
