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
export function sameValue(a: string, b: string): boolean {
  const x = parseValue(a);
  const y = parseValue(b);
  if (x.amount !== null && y.amount !== null) {
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

/**
 * Prices in `answer` that do not appear anywhere in `evidence` (sources, memory, the diff table).
 * The model is told never to invent prices; this checks it did not, and the UI flags any that slip.
 */
export function unsupportedPrices(answer: string, evidence: string): string[] {
  const known = moneyIn(evidence).map(parseValue);
  return moneyIn(answer).filter((p) => {
    const v = parseValue(p);
    return !known.some((k) => k.amount !== null && v.amount !== null && Math.abs(k.amount - v.amount) < 0.005);
  });
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
