// Progress from work running in parallel (each search as it finishes) reaches the user at once: parallel
// work pushes events into an Updates queue, and `drain` yields them while it awaits that work.

import type { AgentEvent } from "./types.ts";

/** Events produced by parallel work (searches finishing), queued until the turn's generator yields them. */
export class Updates {
  private items: AgentEvent[] = [];
  private wake: (() => void) | null = null;
  push(e: AgentEvent): void {
    this.items.push(e);
    this.wake?.();
  }
  take(): AgentEvent[] {
    return this.items.splice(0);
  }
  drop(match: (e: AgentEvent) => boolean): void {
    this.items = this.items.filter((e) => !match(e));
  }
  next(): Promise<void> {
    return new Promise((r) => (this.wake = r));
  }
}

/** Await `p`, yielding progress events as they arrive; returns p's value (use with `yield*`). */
export async function* drain<T>(p: Promise<T>, updates: Updates): AsyncGenerator<AgentEvent, T> {
  let settled = false;
  const done = p.finally(() => {
    settled = true;
  });
  done.catch(() => {});
  while (!settled) {
    for (const e of updates.take()) yield e;
    if (settled) break;
    await Promise.race([done.then(() => undefined, () => undefined), updates.next()]);
  }
  for (const e of updates.take()) yield e;
  return await p;
}
