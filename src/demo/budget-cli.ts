// Shows or resets the hosted demo's spend ledger (DATA_DIR/demo.db).
//   npm run demo:budget              show what was spent
//   npm run demo:budget -- --reset   set it back to $0 (stop the server first)
import { join } from "node:path";
import { DemoRegistry } from "./registry.ts";

const dataDir = process.env.DATA_DIR?.trim() || "data/demo";
const reg = new DemoRegistry(join(dataDir, "demo.db"));
if (process.argv.includes("--reset")) {
  const before = reg.ledger();
  reg.resetLedger(Date.now());
  console.log(`Ledger reset (was $${before.spent_usd.toFixed(4)} over ${before.calls} calls).`);
} else {
  const l = reg.ledger();
  const budget = Number(process.env.DEMO_BUDGET_USD || 18);
  console.log(`Spent $${l.spent_usd.toFixed(4)} of $${budget} (${((l.spent_usd / budget) * 100).toFixed(1)}%) over ${l.calls} model calls, ${l.web_searches} web searches; ${reg.count()} visitors.`);
  console.log(`Last spend: ${l.updated_at ? new Date(l.updated_at).toISOString() : "never"}`);
}
reg.close();
