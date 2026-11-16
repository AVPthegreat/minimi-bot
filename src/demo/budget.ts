// The demo's spend meter: the same prices as the single-user meter (src/usage.ts), but every cost is
// written to the global ledger on disk at once, and every paid call is refused once the ledger has
// reached the budget. One meter is shared by all visitors.

import { BudgetExceededError, type UsageLike, UsageMeter } from "../usage.ts";
import type { DemoRegistry } from "./registry.ts";

export const BUDGET_USED_UP = "The demo budget is used up, so this hosted demo has stopped answering.";

export class LedgerMeter extends UsageMeter {
  constructor(
    private readonly registry: DemoRegistry,
    readonly budgetUsd: number,
  ) {
    super(null);
  }

  override add(model: string, u: UsageLike | null | undefined): void {
    const cost = this.costUsd;
    const calls = this.calls;
    const searches = this.webSearches;
    super.add(model, u);
    if (this.calls !== calls) this.registry.addSpend(this.costUsd - cost, this.calls - calls, this.webSearches - searches, Date.now());
  }

  spentUsd(): number {
    return this.registry.ledger().spent_usd;
  }

  /** Called before every paid request (by the Anthropic model and search clients). */
  override check(): void {
    if (this.spentUsd() >= this.budgetUsd) throw new BudgetExceededError(BUDGET_USED_UP);
  }

  /** May a new message start? Keeps `reserve` per answer already running, so parallel answers can't overshoot much. */
  canStart(running: number, reserveUsd: number): boolean {
    return this.spentUsd() + (running + 1) * reserveUsd <= this.budgetUsd && this.spentUsd() < this.budgetUsd;
  }

  usedPct(): number {
    if (this.budgetUsd <= 0) return 100;
    return Math.min(100, Math.round((this.spentUsd() / this.budgetUsd) * 1000) / 10);
  }
}
