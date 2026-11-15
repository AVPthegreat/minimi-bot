// Claims are the unit of "is it still correct?". An answer like "Neon's Launch plan is $19/month"
// becomes {subject: Neon, attribute: Launch plan price, value: $19, unit: per month}. Comparing old
// and new claims is plain code, not a model call: a price either moved or it did not.

import type { NewClaim } from "./db.ts";

export type DiffStatus = "unchanged" | "changed" | "unverified";

export interface DiffRow {
  subject: string;
  attribute: string;
  oldValue: string; // with unit
  newValue: string | null;
  status: DiffStatus;
  sourceN?: number; // citation number of the page that confirmed the new value
  sourceDate?: string | null;
  note?: string;
}

export interface ParsedValue {
  amount: number | null;
  currency: string | null;
  text: string; // normalised text for non-numeric comparison
}

const CURRENCY: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "₹": "INR", usd: "USD", eur: "EUR", gbp: "GBP", inr: "INR", rs: "INR" };

export function parseValue(value: string): ParsedValue {
  const v = value.trim();
  const m = v.match(/([$€£₹]|\b(?:usd|eur|gbp|inr|rs\.?)\b)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m)?\b\s*(usd|eur|gbp|inr)?/i);
  let amount: number | null = null;
  let currency: string | null = null;
  if (m) {
    amount = Number(m[2]!.replace(/,/g, ""));
    if (m[3]) amount *= m[3].toLowerCase() === "k" ? 1e3 : 1e6;
    const cur = (m[1] ?? m[4] ?? "").toLowerCase().replace(".", "");
    currency = CURRENCY[cur] ?? null;
  }
  if (/^free$/i.test(v)) amount = 0;
  return { amount, currency, text: v.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim() };
}

/** Same value? Numbers compare as numbers (so "$19" == "19 USD"); everything else as normalised text. */
const BARE_NUMBER = /^\s*\d[\d,]*(?:\.\d+)?\s*$/;

function isMoney(v: string, p: ParsedValue): boolean {
  return p.currency !== null || /^free$/i.test(v.trim());
}

/**
 * Same value? Money compares as money ("$19" == "19 USD", "Free" == "$0"); bare numbers as numbers;
 * everything else (versions, dates, sizes like "2 GB" vs "2 TB") as normalised text, so a change in
 * any part of the value counts as a change.
 */
export function sameValue(a: string, b: string): boolean {
  const x = parseValue(a);
  const y = parseValue(b);
  const numeric = (isMoney(a, x) && isMoney(b, y)) || (BARE_NUMBER.test(a) && BARE_NUMBER.test(b)) ||
    (isMoney(a, x) && BARE_NUMBER.test(b)) || (BARE_NUMBER.test(a) && isMoney(b, y));
  if (numeric && x.amount !== null && y.amount !== null) {
    if (x.currency && y.currency && x.currency !== y.currency) return false;
    return Math.abs(x.amount - y.amount) <= 0.005 * Math.max(Math.abs(x.amount), Math.abs(y.amount), 1e-9);
  }
  return x.text === y.text;
}

export function withUnit(value: string, unit?: string | null): string {
  return unit ? `${value} ${unit}` : value;
}

export function diffClaim(
  old: { subject: string; attribute: string; value: string; unit: string | null },
  fresh: { value: string; unit?: string | null; sourceN?: number; sourceDate?: string | null } | null,
): DiffRow {
  const base = { subject: old.subject, attribute: old.attribute, oldValue: withUnit(old.value, old.unit) };
  if (!fresh) return { ...base, newValue: null, status: "unverified", note: "no current source found" };
  const unitChanged = !!(old.unit && fresh.unit && normUnit(old.unit) !== normUnit(fresh.unit));
  const changed = !sameValue(old.value, fresh.value) || unitChanged;
  return {
    ...base,
    newValue: withUnit(fresh.value, fresh.unit ?? old.unit),
    status: changed ? "changed" : "unchanged",
    sourceN: fresh.sourceN,
    sourceDate: fresh.sourceDate ?? null,
  };
}

function normUnit(u: string): string {
  return u.toLowerCase().replace(/\b(a|an|per|\/)\b/g, " ").replace(/user|seat|licen[cs]e/g, "seat").replace(/\s+/g, " ").trim();
}

const STATUS_LABEL: Record<DiffStatus, string> = {
  unchanged: "Unchanged",
  changed: "**Changed**",
  unverified: "Couldn't verify",
};

/** The comparison table, rendered by code so the numbers in it are exactly the stored ones. */
export function renderDiffTable(rows: DiffRow[], thenLabel: string, nowLabel: string): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const lines = [
    `| What | Then (${thenLabel}) | Now (${nowLabel}) | Status |`,
    "|---|---|---|---|",
    ...rows.map((r) => {
      const now = r.newValue ? `${esc(r.newValue)}${r.sourceN ? ` [${r.sourceN}]` : ""}` : "not found";
      return `| ${esc(r.subject)}: ${esc(r.attribute)} | ${esc(r.oldValue)} | ${now} | ${STATUS_LABEL[r.status]} |`;
    }),
  ];
  return lines.join("\n");
}

// ---- Money guard: every price in an answer must appear in what the model was shown.

const MONEY_RE = /(?:[$€£₹]\s?\d[\d,]*(?:\.\d+)?(?:\s?[km]\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|INR)\b)/gi;

export function moneyIn(text: string): string[] {
  return [...new Set(text.match(MONEY_RE) ?? [])].map((s) => s.trim());
}

interface PriceMention {
  text: string; // "$19"
  amount: number;
  currency: string | null;
  context: Set<string>; // words naming what the price belongs to ("neon", "launch")
}

const CONTEXT_STOP = new Set(
  "the a an and or of for to in on at is are was were be it its this that with from per month monthly year yearly annual annually user users seat seats plan plans price prices pricing cost costs now then today was currently starts starting from up down only about around just new old source dated changed unchanged".split(" "),
);

function contextWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/\[\d+\]|https?:\/\/\S+/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !CONTEXT_STOP.has(w) && !/^\d+$/.test(w)),
  );
}

/** Each price with the words just before it on the same line, back to the previous price. */
function priceMentions(text: string): PriceMention[] {
  const out: PriceMention[] = [];
  for (const line of text.split(/\n|(?<=[.!?])\s+/)) {
    let from = 0;
    for (const m of line.matchAll(new RegExp(MONEY_RE.source, "gi"))) {
      const v = parseValue(m[0]);
      if (v.amount === null) continue;
      // For table rows the whole row is the context (the subject sits in the first cell).
      const context = line.trimStart().startsWith("|") ? line : line.slice(from, m.index);
      out.push({ text: m[0].trim(), amount: v.amount, currency: v.currency, context: contextWords(context) });
      from = m.index! + m[0].length;
    }
  }
  return out;
}

/**
 * Prices in `answer` that no piece of `evidence` supports. A price is supported when the evidence has
 * the same amount, in the same currency, said about the same thing (the words before the price share a
 * product or plan name). "Neon Launch $19" is not supported by "Supabase Pro $19". Callers pass only
 * current evidence (fresh sources and the computed diff table), so a stale price copied from an old
 * answer is flagged.
 */
export function unsupportedPrices(answer: string, evidence: string): string[] {
  const known = priceMentions(evidence);
  const bad = priceMentions(answer).filter((p) => {
    return !known.some((k) => {
      if (Math.abs(k.amount - p.amount) >= 0.005) return false;
      if (p.currency && k.currency && p.currency !== k.currency) return false;
      if (p.context.size === 0) return true; // "That's $19." refers back; nothing more to compare
      return [...p.context].some((w) => k.context.has(w));
    });
  });
  return [...new Set(bad.map((p) => p.text))];
}

/** One honest summary line for a re-check: never "nothing changed" unless every row was verified. */
export function summarizeDiff(rows: DiffRow[], thenLabel: string): string {
  const count = (s: DiffStatus) => rows.filter((r) => r.status === s).length;
  const changed = count("changed");
  const unchanged = count("unchanged");
  const unverified = count("unverified");
  if (rows.length && unverified === rows.length) {
    return `I couldn't verify any of the ${rows.length} fact${rows.length > 1 ? "s" : ""} from ${thenLabel} against current sources.`;
  }
  if (changed === 0 && unverified === 0) return `Nothing I checked has changed since ${thenLabel} (${unchanged} of ${rows.length} verified).`;
  const parts = [
    changed ? `**${changed} changed**` : "",
    unchanged ? `${unchanged} unchanged` : "",
    unverified ? `${unverified} I couldn't verify` : "",
  ].filter(Boolean);
  return `Since ${thenLabel}: ${parts.join(", ")}.`;
}

// ---- A tiny fact grammar used by the fake model (and as a no-model fallback extractor).
// Matches sentences like "Neon: the Launch plan costs $19 per month."

const FACT_RE = /([A-Z][\w.]*(?: [A-Z][\w.]*)*): the ([\w -]+?) (?:costs|is) ([$€£₹]?[\d,.]+[km]?|free)(?: (per [\w ]+?))?(?=[.,;]|\s\[|$)/g;

export function grammarClaims(text: string, sourceUrl?: string | null, sourceDate?: string | null): NewClaim[] {
  const out: NewClaim[] = [];
  for (const m of text.matchAll(FACT_RE)) {
    out.push({
      subject: m[1]!.trim(),
      attribute: `${m[2]!.trim()} price`,
      value: m[3]!.trim(),
      unit: m[4]?.trim() ?? null,
      sourceUrl: sourceUrl ?? null,
      sourceDate: sourceDate ?? null,
    });
  }
  return out;
}
