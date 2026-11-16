// Per-IP token buckets (in memory: a restart refills them, which is fine for a rate limit).

export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    readonly capacity: number,
    readonly perMinute: number,
    private readonly maxKeys = 50_000,
  ) {}

  /** Takes one token; returns 0 when allowed, else the seconds until one is available. */
  take(key: string, now = Date.now()): number {
    const rate = this.perMinute / 60_000; // tokens per ms
    const b = this.buckets.get(key);
    let tokens = this.capacity;
    if (b) {
      tokens = Math.min(this.capacity, b.tokens + (now - b.at) * rate);
      this.buckets.delete(key); // re-insert below: Map order = least recently used first
    } else if (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, at: now });
      return 0;
    }
    this.buckets.set(key, { tokens, at: now });
    return Math.max(1, Math.ceil((1 - tokens) / rate / 1000));
  }

  /** Drops buckets that have refilled completely (they hold no information). */
  prune(now = Date.now()): void {
    const full = (this.capacity / this.perMinute) * 60_000;
    for (const [k, b] of this.buckets) if (now - b.at >= full) this.buckets.delete(k);
  }

  get size(): number {
    return this.buckets.size;
  }
}
