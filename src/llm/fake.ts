// A deterministic stand-in for Claude, used by `npm test`, the offline eval and FAKE_MODE.
// It is deliberately simple: it only writes facts it can read in the sources (the same grammar
// the fixture web uses), so the eval checks the agent's plumbing: routing, memory, time, re-checks.

import { grammarClaims } from "../claims.ts";
import type { NewClaim } from "../db.ts";
import { rulesRoute, stopwordsTopic } from "../router.ts";
import type { AnswerInput, LLM, RecheckResult, RouteInput, RoutePlan } from "./types.ts";

const PRODUCT_RE = /\b(?:[A-Z][a-zA-Z]+(?:\s(?:CRM|Workers|Cloud|Hub))?)\b/g;
const NOT_PRODUCTS = new Set(["I", "We", "Our", "My", "Me", "It", "Its", "They", "And", "Or", "For", "In", "Of", "What", "Which", "How", "Compare", "Is", "Are", "Has", "Have", "On", "Last", "The", "Tell", "Should", "Give", "Can", "Do", "Does", "Postgres", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "November", "October", "December"]);

export class FakeLLM implements LLM {
  readonly name = "fake (deterministic, offline)";

  async route(input: RouteInput): Promise<Omit<RoutePlan, "via">> {
    const rules = rulesRoute(input.text, input.timePhrases.length > 0, input.history.length > 0, input.rest);
    if (rules) return rules;
    const products = [...new Set((input.text.match(PRODUCT_RE) ?? []).filter((w) => !NOT_PRODUCTS.has(w)))];
    const topic = stopwordsTopic(input.rest);
    const queries = products.length >= 2 ? products.slice(0, 5).map((p) => `${p} pricing`) : [topic || input.text];
    return { intent: "search", memoryQuery: topic, searchQueries: queries, sinceDays: 0, highStakes: /pric|cost|\$/i.test(input.text) };
  }

  async *streamAnswer(input: AnswerInput): AsyncIterable<string> {
    for (const word of this.compose(input).split(/(?<=\s)/)) {
      if (input.signal?.aborted) return;
      yield word;
    }
  }

  private compose(input: AnswerInput): string {
    const out: string[] = [];
    for (const n of input.notes) out.push(`_Note: ${n}_`);
    if (input.intent === "chat") {
      out.push("Hi! I'm running in fake mode (no API keys), so my answers come from a small offline test web. Ask me about Postgres hosting or CRM pricing, then ask me about it again on another day.");
      return out.join("\n\n");
    }
    if (input.intent === "recall" || input.intent === "verify") {
      if (input.memory.length === 0) {
        out.push("I don't have a conversation that matches that in my memory.");
        return out.join("\n\n");
      }
      for (const t of input.memory) {
        const gist = t.answer.split("\n").filter((l) => l.trim() && !l.startsWith("_Note")).slice(0, 4).join("\n");
        out.push(`On ${t.when} you asked: "${t.question}"\n\nMy answer then, in short:\n${gist}`);
      }
    }
    if (input.intent === "verify" && input.diff) {
      const rows = input.diff.rows;
      const changed = rows.filter((r) => r.status === "changed");
      const same = rows.filter((r) => r.status === "unchanged").length;
      const unknown = rows.filter((r) => r.status === "unverified").length;
      out.push(`Compared with today: ${changed.length} changed, ${same} unchanged, ${unknown} couldn't be verified.`);
      for (const r of changed) out.push(`- ${r.subject} ${r.attribute}: ${r.oldValue} then, ${r.newValue} now${r.sourceN ? ` [${r.sourceN}]` : ""}.`);
      const thenDay = input.diff.thenLabel;
      const news = input.sources.filter((s) => !grammarClaims(s.snippet).length || /launch|shipped|news|cut/i.test(s.title));
      if (news.length) out.push(`Since ${thenDay}:\n${news.map((s) => `- ${s.title} (${s.publishedDate ?? "undated"}) [${s.n}]`).join("\n")}`);
      return out.join("\n\n");
    }
    if (input.intent === "search") {
      if (input.sources.length === 0) {
        out.push("I couldn't find a reliable source for that, so I won't guess.");
        return out.join("\n\n");
      }
      out.push(`Here's what I found (as of ${input.nowLabel}):`);
      const lines: string[] = [];
      for (const s of input.sources.slice(0, 6)) {
        const facts = s.snippet.match(/[A-Z][\w.]*(?: [A-Z][\w.]*)*: the [^.]+\./g);
        if (facts) for (const f of facts) lines.push(`- ${f.replace(/\.$/, "")} [${s.n}] (source dated ${s.publishedDate ?? "unknown"})`);
        else lines.push(`- ${s.title} [${s.n}]`);
      }
      out.push(lines.join("\n"));
    }
    return out.join("\n\n");
  }

  async extractClaims(input: { answer: string; sources: { n: number; url: string; publishedDate?: string }[] }): Promise<NewClaim[]> {
    const claims: NewClaim[] = [];
    for (const line of input.answer.split("\n")) {
      const n = Number(line.match(/\[(\d+)\]/)?.[1] ?? 0);
      const src = input.sources.find((s) => s.n === n);
      claims.push(...grammarClaims(line, src?.url, src?.publishedDate));
    }
    return claims.slice(0, 12);
  }

  async recheck(input: Parameters<LLM["recheck"]>[0]): Promise<Array<RecheckResult | null>> {
    return input.claims.map((c) => {
      for (const s of input.sources) {
        const hit = grammarClaims(s.snippet).find(
          (f) => f.subject.toLowerCase() === c.subject.toLowerCase() && f.attribute.toLowerCase() === c.attribute.toLowerCase(),
        );
        if (hit) return { value: hit.value, unit: hit.unit ?? null, sourceN: s.n };
      }
      return null;
    });
  }
}
