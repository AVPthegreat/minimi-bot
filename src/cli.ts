// Terminal chat on the same agent core: `npm run chat`.
// Commands: /new (new session), /time <ISO date> (demo clock, fake mode or ALLOW_CLOCK_OVERRIDE=1), /quit.

import { createInterface } from "node:readline/promises";
import { createAgent } from "./index.ts";

const { agent, clock, config, llm, search } = createAgent();
const rl = createInterface({ input: process.stdin, output: process.stdout });
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

console.log(dim(`minimi-agent | ${llm.name} | search: ${search.name} | ${agent.nowLabel()}`));
if (config.fakeMode) console.log(dim(`FAKE MODE (${config.fakeReason}). Try: /time 2026-11-10T10:00:00+05:30`));
console.log(dim("Commands: /new  /time <ISO date>  /quit\n"));

let sessionId = agent.newSession().id;
await showNudge();

async function showNudge(): Promise<void> {
  const n = await agent.nudge(sessionId).catch(() => null);
  if (n) console.log(`\n${n.nudge.text}\n${n.nudge.sources.map((s) => dim(`  [${s.n}] ${s.url}`)).join("\n")}\n`);
}

for (;;) {
  let line: string;
  try {
    line = (await rl.question("> ")).trim();
  } catch {
    break; // stdin closed
  }
  if (!line) continue;
  if (line === "/quit" || line === "/exit") break;
  if (line === "/new") {
    sessionId = agent.newSession().id;
    console.log(dim("(new session)"));
    await showNudge();
    continue;
  }
  if (line.startsWith("/time")) {
    if (!clock || !config.allowClockOverride) console.log(dim("The demo clock is off (fake mode or ALLOW_CLOCK_OVERRIDE=1)."));
    else {
      try {
        clock.set(line.slice(5).trim());
        console.log(dim(`now: ${agent.nowLabel()}`));
      } catch (e) {
        console.log(dim((e as Error).message));
      }
    }
    continue;
  }
  for await (const ev of agent.chat(sessionId, line)) {
    if (ev.type === "status") console.log(dim(`  ${ev.text}`));
    else if (ev.type === "delta") process.stdout.write(ev.text);
    else if (ev.type === "warning") console.log(`\n  ! ${ev.text}`);
    else if (ev.type === "error") console.log(`\n  error: ${ev.message}`);
    else if (ev.type === "sources") process.stdout.write(dim(ev.sources.map((s) => `  [${s.n}] ${s.domain}${s.date ? ` (${s.date})` : ""}`).join("\n")) + "\n\n");
    else if (ev.type === "done") console.log(dim(`\n  (${ev.atLabel}, first token ${ev.timings.firstTokenMs ?? "-"} ms, total ${ev.timings.totalMs} ms)\n`));
  }
}
rl.close();
await agent.idle();
agent.store.close();
