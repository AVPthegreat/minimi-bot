// Every prompt the agent sends, in one file, so they can be read and reviewed together.
// System prompts are fixed strings, so the prefix stays byte-stable; anything that changes per turn
// (date, sources, memory) goes into the user turn.

import type { AnswerInput, RouteInput } from "./types.ts";
import type { ClaimRow } from "../db.ts";
import type { Source } from "../search/rank.ts";

export const ANSWER_SYSTEM = `You are Minimi, a chat assistant with one tool, web search, and a memory of every earlier conversation with this user (with dates).

How to answer:
- Lead with the answer in the first sentence. Then short paragraphs or bullets. Use a markdown table when comparing 3 or more things. No filler and no disclaimers about being an AI.
- The user's current local date and time are in <now>. Use them for words like "today" and to say how old a source is.
- Facts about the world come from <sources>. Cite each such fact right after it as [n], using the source numbers given. Prefer official pages (pricing pages, changelogs, release notes, docs) and the newest dates. For anything that changes (prices, plans, versions, limits) say the date of the source you rely on.
- Never state a price, number, version or date that is not in <sources> or <memory>. If the sources do not show it, say so plainly and say where the user can check. Every price you write is checked against the sources after you answer.
- You may have a web_search tool with a small budget. The <sources> were already fetched for this question, so search only when they do not answer it, look out of date, or a key number has a single weak source. Facts you find that way are cited automatically; do not number them yourself.
- If sources disagree, say so and give both with their dates. If <high_stakes> is true and only one source supports a key number, say that it is single-sourced.
- <memory> is the record of earlier conversations. When the user asks about the past, quote their earlier question exactly, give its date, and give the gist of your earlier answer. Memory says what was true then, not what is true now.
- When <comparison> is present, the user has already seen that table right above your reply. Do not repeat it. In 2-4 sentences say what changed (old to new, with the source date), what did not, and what could not be verified; then mention anything big from <sources> that happened since (launches, pricing changes), with citations.
- When <notes> is present, state each note briefly (for example how you read an ambiguous date).
- If the question is ambiguous in a way that changes the answer, answer the most likely reading and say in one line which reading you chose.
- For small talk, reply briefly and warmly; no sources needed.`;

export const ROUTER_SYSTEM = `You route messages for a chat assistant that has web search and a dated memory of earlier conversations. Decide the cheapest plan that still answers well.

intent:
- "chat": small talk, opinions, writing or reasoning that needs no current facts.
- "recall": the user asks about earlier conversations only (what they asked, what was said).
- "verify": the user asks whether an earlier answer or earlier facts are still true, or what changed since an earlier conversation.
- "search": anything that needs current or factual information from the web.

search_queries (only for "search"): 1 query for a simple fact; for comparisons one query per product (max 5). Make them specific: product names, the attribute ("pricing", "changelog", "release notes"), and the current year when freshness matters. Resolve pronouns using the history. Empty for other intents.
since_days: for questions about recent news or "what's new", how many days back to search (e.g. 7); otherwise 0.
memory_query: for recall/verify, the topic words to find the earlier conversation (e.g. "postgres hosting"); otherwise "".
high_stakes: true if a wrong number would cost the user money, health or legal trouble (prices, doses, taxes, contracts).`;

export const ROUTER_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["chat", "recall", "verify", "search"] },
    search_queries: { type: "array", items: { type: "string" } },
    since_days: { type: "integer" },
    memory_query: { type: "string" },
    high_stakes: { type: "boolean" },
  },
  required: ["intent", "search_queries", "since_days", "memory_query", "high_stakes"],
  additionalProperties: false,
} as const;

export const EXTRACT_SYSTEM = `Extract the checkable facts from an assistant's answer: facts that can change over time and that someone might later ask "is this still true?" about. Prices, plan limits, version numbers, release or end-of-life dates, availability, policy terms. Skip opinions, advice and timeless facts.

Rules:
- Only facts actually stated in the ANSWER. Copy values exactly as written (e.g. "$25").
- subject: the product or company ("Supabase"). attribute: specific ("Pro plan price", "free tier storage"). unit: e.g. "per month", "per seat per month", or "" if none.
- source_n: the citation number [n] the answer gives for the fact, or 0 if none.
- At most 12 facts, most important first.`;

export const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          subject: { type: "string" },
          attribute: { type: "string" },
          value: { type: "string" },
          unit: { type: "string" },
          source_n: { type: "integer" },
        },
        required: ["subject", "attribute", "value", "unit", "source_n"],
        additionalProperties: false,
      },
    },
  },
  required: ["claims"],
  additionalProperties: false,
} as const;

export const RECHECK_SYSTEM = `You check earlier facts against fresh search results. For each numbered fact, find its CURRENT value in the results.

Rules:
- found=false unless a result clearly states the value for the same subject and attribute. Do not guess and do not carry the old value forward.
- Copy the value exactly as the result states it; give its unit ("per month", "" if none) and the result number in source_n.
- Prefer the official page and the newest date when results disagree.`;

export const RECHECK_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fact: { type: "integer" },
          found: { type: "boolean" },
          value: { type: "string" },
          unit: { type: "string" },
          source_n: { type: "integer" },
        },
        required: ["fact", "found", "value", "unit", "source_n"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const;

export function renderSources(sources: Source[]): string {
  if (sources.length === 0) return "<sources>none</sources>";
  const items = sources.map(
    (s) =>
      `[${s.n}] ${s.title} | ${s.url} | ${s.publishedDate ? `dated ${s.publishedDate}` : "date unknown"}${s.official ? " | official" : ""}\n${s.snippet}`,
  );
  return `<sources>\n${items.join("\n\n")}\n</sources>`;
}

export function renderRouteInput(input: RouteInput): string {
  const hist = input.history
    .slice(-4)
    .map((m) => `${m.role}: ${m.content.slice(0, 400)}`)
    .join("\n");
  return `<now>${input.nowLabel}</now>\n<history>\n${hist || "(none)"}\n</history>\n<time_phrases>${input.timePhrases.join(", ") || "none"}</time_phrases>\n<message>${input.text}</message>`;
}

export function renderAnswerTurn(input: AnswerInput): string {
  const parts = [`<now>${input.nowLabel}</now>`, `<high_stakes>${input.highStakes}</high_stakes>`];
  if (input.memory.length) {
    parts.push(
      `<memory>\n${input.memory
        .map(
          (t) =>
            `On ${t.when} the user asked: "${t.question}"\nYour answer then:\n${t.answer.slice(0, 2500)}` +
            (t.claims.length ? `\nFacts recorded from it: ${t.claims.map((c) => `${c.subject} ${c.attribute} = ${c.value}${c.unit ? " " + c.unit : ""}`).join("; ")}` : ""),
        )
        .join("\n---\n")}\n</memory>`,
    );
  }
  if (input.diff) parts.push(`<comparison then="${input.diff.thenLabel}">\n${input.diff.table}\n</comparison>`);
  if (input.notes.length) parts.push(`<notes>\n${input.notes.map((n) => `- ${n}`).join("\n")}\n</notes>`);
  if (input.intent !== "chat") parts.push(renderSources(input.sources));
  parts.push(`<question>${input.question}</question>`);
  return parts.join("\n\n");
}

export function renderRecheck(claims: ClaimRow[], sources: Source[]): string {
  const facts = claims.map((c, i) => `${i + 1}. ${c.subject}: ${c.attribute} = ${c.value}${c.unit ? " " + c.unit : ""} (as of ${c.source_date ?? "earlier"})`);
  return `<facts>\n${facts.join("\n")}\n</facts>\n\n${renderSources(sources)}`;
}
