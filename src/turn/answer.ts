// Stage 3 of a turn: the answer model writes from the gathered evidence, streamed through the grounding
// guard: every price it writes must be backed by CURRENT evidence (the gathered sources, passages it
// cited, the computed diff table), or it is marked "(unverified)" before the user sees it. Old answers
// are not evidence for today's prices; only a pure recall answer may quote them, as history.

import { type EvidenceDoc, priceChecker, questionMultipliers } from "../claims.ts";
import { GroundingGuard } from "../grounding.ts";
import { NOT_NAMES } from "../planner.ts";
import { type Source, domainOf, isOfficialFor } from "../search/rank.ts";
import type { SearchResult } from "../search/types.ts";
import type { Turn } from "./context.ts";
import { type AgentEvent, publicSource } from "./types.ts";

export async function* answer(t: Turn, web: boolean): AsyncGenerator<AgentEvent> {
  const { deps, intent, signal } = t;
  const selfSearches: string[] = [];
  const addSource = (r: SearchResult): { source: Source; added: boolean } => {
    const existing = t.sources.find((x) => x.url === r.url);
    if (existing) return { source: existing, added: false };
    const source: Source = { ...r, n: t.sources.length + 1, domain: domainOf(r.url), official: isOfficialFor(r.url, t.plan.searchQueries), query: "(answer model)" };
    t.sources.push(source);
    return { source, added: true };
  };
  const maxSelfSearches = web && t.sources.length === 0 ? (deps.maxSelfSearches ?? 3) : 0;

  const guard = groundingGuard(t);
  const out = (text: string): AgentEvent | null => {
    const safe = guard.push(text);
    if (!safe) return null;
    if (t.firstTokenMs === null) t.firstTokenMs = performance.now() - t.t0;
    if (t.firstModelTokenMs === null) t.firstModelTokenMs = performance.now() - t.t0;
    t.answer += safe;
    return { type: "delta", text: safe };
  };
  try {
    if (signal?.aborted) throw new Error("stopped");
    if (!t.answeredByCode) for await (const ev of deps.llm.streamAnswer({
      intent: intent === "updates" ? "verify" : intent,
      question: t.question,
      nowLabel: t.nowLabel,
      history: t.history,
      sources: t.sources,
      memory: t.memory,
      diff: t.diff,
      notes: t.notes,
      shown: t.shown,
      highStakes: t.plan.highStakes,
      maxSelfSearches,
      signal,
    })) {
      if (ev.type === "text") {
        const d = out(ev.text);
        if (d) yield d;
      } else if (ev.type === "searching") {
        selfSearches.push(ev.query);
        yield t.status(`Searching the web: ${ev.query}`);
        yield t.step(ev.query, "running"); // the model's own search: no per-search end, the UI closes it on "done"
      } else if (ev.type === "source") {
        if (addSource(ev.result).added) yield { type: "sources", sources: t.sources.map(publicSource) };
      } else if (ev.type === "cite") {
        const { source, added } = addSource({ title: ev.title ?? ev.url, url: ev.url, snippet: "" });
        if (!source.snippet.includes(ev.citedText)) source.snippet = `${source.snippet} ${ev.citedText}`.trim().slice(0, 2000);
        if (added) yield { type: "sources", sources: t.sources.map(publicSource) };
        const tag = ` [${source.n}]`;
        if (!t.answer.endsWith(tag)) {
          const d = out(tag);
          if (d) yield d;
        }
      }
    }
  } catch (e) {
    if (!signal?.aborted) {
      const message = deps.publicError ? deps.publicError(e as Error) : (e as Error).message;
      const d = out(`\n\n(The model failed before finishing: ${message})`);
      if (d) yield d;
      yield { type: "error", message };
    }
  }
  const tail = guard.end();
  if (tail) {
    t.answer += tail;
    yield { type: "delta", text: tail };
  }
  for (const q of selfSearches) {
    deps.store.logSearch(t.userId, q, "answer-model web_search", "self-search", t.sources.filter((x) => x.query === "(answer model)"), t.now);
  }

  t.flagged = [...new Set(guard.flagged)];
  t.warnings = t.flagged.map((p) => `I couldn't match ${p} to a current source. Treat it as unverified.`);
  for (const w of t.warnings) yield { type: "warning", text: w };
}

/** The guard over this turn's evidence; it reads the sources live, so sources found mid-answer count. */
function groundingGuard(t: Turn): GroundingGuard {
  const { intent } = t;
  const evidence = (): EvidenceDoc[] => [
    ...t.sources.map((x) => ({ n: x.n, text: `${x.title}\n${x.snippet}`, about: `${siteName(x.url)} ${x.query === t.specQuery ? x.title : `${x.title} ${x.query}`}` })),
    { text: t.diff?.table ?? "" },
    // What was said before (the earlier answer, earlier in this chat) backs a price only as history:
    // fully in a recall answer, and elsewhere only where the sentence says it was the price then.
    ...t.memory.map((m) => ({ text: m.answer, pastOnly: intent !== "recall" })),
    ...t.history.filter((m) => m.role === "assistant").map((m) => ({ text: m.content, pastOnly: intent !== "recall" })),
  ];
  const multipliers = questionMultipliers(t.text);
  // The products this turn is about: what decides which product a price belongs to.
  const names = (): string[] => [
    ...t.subjects,
    ...productWords(t.topic),
    ...t.memory.flatMap((m) => [...m.claims.map((c) => c.subject), ...productWords(m.question)]),
    ...(t.diff?.rows.map((r) => r.subject) ?? []),
    ...t.sources.map((x) => siteName(x.url)),
  ];
  return new GroundingGuard((line, before) => priceChecker(evidence(), { multipliers, names: names() })(line, `${t.shown.join("\n")}\n${before}`));
}

/** The site's own name: "docs.railway.com" -> "railway", "neon.com" -> "neon". */
function siteName(url: string): string {
  const parts = domainOf(url).split(".");
  return parts.length >= 2 ? parts[parts.length - 2]! : parts[0]!;
}

/** Capitalised words of a question that are not sentence openers or dates ("Cloudflare", "Workers"). */
function productWords(text: string): string[] {
  return [...text.matchAll(/(?<![.!?]\s|^)\b[A-Z][\w.+&-]{2,}/g)].map((m) => m[0]).filter((w) => !NOT_NAMES.has(w));
}
