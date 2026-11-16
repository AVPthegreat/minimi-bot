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
  const m = v.match(/([$€£₹]|\b(?:usd|eur|gbp|inr|rs)\b\.?)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m)?\b\s*(usd|eur|gbp|inr)?/i);
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
  // "Changed" means the value changed, never only its wording or its verification status
  // (live: "$5 (unverified) per month per account" then, "$5 per month [5]" now was shown as Changed).
  const oldValue = stripUnverified(old.value);
  const unitChanged = !!(old.unit && fresh.unit && !sameUnit(old.unit, fresh.unit));
  const changed = !(sameValue(oldValue, fresh.value) || sameWording(oldValue, fresh.value)) || unitChanged;
  const confirmed = !changed && oldValue !== old.value.trim();
  return {
    ...base,
    newValue: withUnit(fresh.value, fresh.unit ?? old.unit),
    status: changed ? "changed" : "unchanged",
    ...(confirmed ? { note: "was unverified, now confirmed" } : {}),
    sourceN: fresh.sourceN,
    sourceDate: fresh.sourceDate ?? null,
  };
}

/** A value stored with "(unverified)" (the guard flagged it then). */
function stripUnverified(v: string): string {
  return v.replace(/\s*\(unverified\)/gi, "").trim();
}

const UNIT_FILLER = new Set(["a", "an", "per", "each", "the", "of", "every"]);
const UNIT_WORD: Record<string, string> = {
  mo: "month", monthly: "month", months: "month", yr: "year", annually: "year", annual: "year", yearly: "year", years: "year",
  user: "seat", users: "seat", seats: "seat", licence: "seat", license: "seat", licenses: "seat", licences: "seat",
};

function unitWords(u: string): Set<string> {
  return new Set(
    u.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !UNIT_FILLER.has(w)).map((w) => UNIT_WORD[w] ?? (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)),
  );
}

/**
 * Same unit? Word order and filler do not matter ("per month per organization" = "per organization per
 * month"), and a unit that only leaves a word out ("per month" for "per month per workspace") is the same
 * fact worded less fully. A different word on both sides ("per month" vs "per year") is a change.
 */
export function sameUnit(a: string, b: string): boolean {
  const x = unitWords(a);
  const y = unitWords(b);
  return [...x].every((w) => y.has(w)) || [...y].every((w) => x.has(w));
}

/** Non-money values with the same numbers and units, one only adding words ("500 MB each" / "500 MB database each"). */
function sameWording(a: string, b: string): boolean {
  const nums = (s: string) => (s.toLowerCase().match(/\d[\d,.]*\s*[a-z%]*/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\s+/g, " ").trim());
  const na = nums(a);
  const nb = nums(b);
  if (!na.length || na.join("|") !== nb.join("|")) return false;
  return sameUnit(a.replace(/\d[\d,.]*/g, " "), b.replace(/\d[\d,.]*/g, " "));
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
      const status = r.status === "unchanged" && r.note === "was unverified, now confirmed" ? "Unchanged, now confirmed" : STATUS_LABEL[r.status];
      return `| ${esc(r.subject)}: ${esc(r.attribute)} | ${esc(r.oldValue)} | ${now} | ${status} |`;
    }),
  ];
  return lines.join("\n");
}

// ---- Money guard: every price in an answer must appear in what the model was shown.

// Thousands separators only between digit groups, Indian grouping too ("₹1,49,999"); codes before or after ("USD 5", "5 USD").
const MONEY_RE = /(?:[$€£₹]\s?(?:\d{1,2}(?:,\d{2})+,\d{3}|\d{1,3}(?:,\d{3})*)(?:\.\d+)?(?!\d)(?:\s?[km]\b)?|[$€£₹]\s?\d+(?:\.\d+)?(?:\s?[km]\b)?|\b(?:USD|EUR|GBP|INR|Rs\.?)\s?(?:\d{1,2}(?:,\d{2})+,\d{3}|\d{1,3}(?:,\d{3})*)(?:\.\d+)?(?!\d)|\b(?:\d{1,2}(?:,\d{2})+,\d{3}|\d{1,3}(?:,\d{3})*)(?:\.\d+)?(?!\d)\s?(?:USD|EUR|GBP|INR)\b|\b\d+(?:\.\d+)?\s?(?:USD|EUR|GBP|INR)\b)/gi;

export function moneyIn(text: string): string[] {
  return [...new Set(text.match(MONEY_RE) ?? [])].map((s) => s.trim());
}

interface PriceMention {
  text: string; // "$19"
  amount: number;
  currency: string | null;
  context: Set<string>; // words around the price ("neon", "launch")
  /** Stated as a past value ("was $19", "$19 then"). */
  past: boolean;
  /** Citations attached to the price: the [n] after it in its sentence or table cell. */
  cites: number[];
  /** Where the price starts in the text it was read from. */
  at: number;
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
      .filter((w) => w.length >= 3 && !CONTEXT_STOP.has(w) && !/^\d+$/.test(w))
      .map(stem),
  );
}

/** "requests" = "request", "tiers" = "tier": the answer and the page rarely use the same plural. */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

const moneyAt = () => new RegExp(MONEY_RE.source, "gi");
/** A clause boundary inside a sentence: the words beyond it belong to another clause. */
const CLAUSE = /[,;:()]|\s(?:and|but|while|whereas|vs\.?|versus)\s|\*\*/gi;

/**
 * Each price with the words that say what it belongs to. Evidence (`withAfter`): the words before it back
 * to the previous price, plus up to 6 words after ("$0.30 per million requests"). An answer: its own
 * clause, before and after ("**about $15/month typical on Neon**"), so a subject named in the previous
 * clause ("$5/month on Railway, about $15") is not taken as this price's. A table row is one context.
 */
function priceMentions(text: string, withAfter = false): PriceMention[] {
  const out: PriceMention[] = [];
  let offset = 0;
  for (const line of text.split(/(?<=\n)|(?<=[.!?])(?<!\bRs\.)(?=\s)/i)) {
    const row = line.trimStart().startsWith("|");
    let from = 0;
    const all = [...line.matchAll(moneyAt())];
    for (const [i, m] of all.entries()) {
      const v = parseValue(m[0]);
      if (v.amount === null) continue;
      const start = m.index!;
      const stop = start + m[0].length;
      const nextAt = all[i + 1]?.index ?? line.length;
      let context: string;
      if (row) context = line;
      else if (withAfter) context = `${line.slice(from, start)} ${line.slice(stop, nextAt).split(/\s+/).slice(0, 6).join(" ")}`;
      else {
        const before = line.slice(from, start);
        const cut = [...before.matchAll(CLAUSE)].at(-1);
        const after = line.slice(stop, nextAt);
        const end = after.search(CLAUSE);
        context = `${cut ? before.slice(cut.index! + cut[0].length) : before} ${(end < 0 ? after : after.slice(0, end)).split(/\s+/).slice(0, 6).join(" ")}`;
      }
      // Citations right after the price, up to the end of its table cell or sentence ("$25 per month [8]").
      const tail = line.slice(stop, row ? (line.indexOf("|", stop) < 0 ? line.length : line.indexOf("|", stop)) : line.length);
      const cites = [...tail.slice(0, Math.max(0, tail.search(moneyAt()) < 0 ? tail.length : tail.search(moneyAt()))).matchAll(/\[(\d{1,2})\]/g)].map((c) => Number(c[1]));
      const pre = line.slice(Math.max(0, start - 40), start);
      const post = line.slice(stop, stop + 40);
      const past = PAST_BEFORE.test(pre) || PAST_AFTER.test(post);
      out.push({ text: m[0].trim(), amount: v.amount, currency: v.currency, context: contextWords(context), past, cites, at: offset + start });
      from = stop;
    }
    offset += line.length;
  }
  return out;
}

/** A piece of current evidence: its text, plus words naming what it is about (a source's title and query). */
export interface EvidenceDoc {
  text: string;
  about?: string;
  /** The source's citation number, so a price that cites [n] can be checked against exactly that source. */
  n?: number;
  /**
   * Evidence for what WAS true (an earlier answer, earlier in this chat): it supports a price only when
   * the sentence states it as past ("was $19", "$19 then", "down from $19"), never as today's price.
   */
  pastOnly?: boolean;
}

// Words right before a price that make it a past value, or "then" right after it.
const PAST_BEFORE = /\b(?:was|were|had been|used to be|previously|from|then|earlier|before)\s*(?:at\s+)?$/i;
const PAST_AFTER = /^\s*(?:[^\s$€£₹\d]+\s+){0,3}?(?:then|before|earlier|previously)\b/i;

/** Plain numbers that may multiply a sourced unit price into a total (seats, months). */
function multipliersIn(s: string): number[] {
  const out: number[] = [];
  for (const m of s.replace(MONEY_RE, " ").matchAll(/\b(\d{1,6})(?:[- ](?:person|people|seats?|users?|members?|months?))?\b/gi)) {
    const n = Number(m[1]);
    if (n >= 2 && n <= 100000) out.push(n);
  }
  return out;
}

// Capitalised words that open sentences or headings, not names of products or plans.
const COMMON_CAPS = new Set(
  ("the a an all both each every this that these those there here what which who how when where why yes no not none some any one two three four five " +
    "it its they their we our you your i my he she his her and or but so if then also however note notes caveat check source sources free paid " +
    "new now today plan plans price prices pricing cost costs monthly annual per month year total totals other another only most more less").split(" "),
);

/** Words that name products in evidence when the caller gives no names: capitalised, not common words. */
function namesFromEvidence(docs: EvidenceDoc[]): Set<string> {
  const out = new Set<string>();
  for (const d of docs) {
    for (const m of `${d.about ?? ""}\n${d.text}`.matchAll(/\b[A-Z][A-Za-z0-9]{2,}/g)) {
      const w = m[0].toLowerCase();
      if (!COMMON_CAPS.has(w) && !CONTEXT_STOP.has(w)) out.add(stem(w));
    }
  }
  return out;
}

/** Product names as context words ("Zoho CRM" -> zoho, crm). */
export function nameWords(names: string[]): Set<string> {
  return new Set(names.flatMap((n) => [...contextWords(n)]).filter((w) => !COMMON_CAPS.has(w)));
}

const overlaps = (a: Set<string>, b: Set<string>) => [...a].some((w) => b.has(w));

export interface PriceCheckOptions {
  /** Numbers the user gave (seats, months): a sourced unit price times one of them is a supported total. */
  multipliers?: number[];
  /**
   * Names of the products this turn is about (the planned subjects, the stored facts' subjects, product
   * words of the question, the sources' sites). Only these decide what a price belongs to; generic words
   * around a price ("All five sources agree on the $5") say nothing about it. Default: read from evidence.
   */
  names?: string[];
}

/**
 * Checks prices against current evidence. A price is supported when the evidence has the same amount,
 * in the same currency (and, for an earlier answer, only as a past value), said about the same product:
 *   - the product named in the price's own clause; if it names none, the product named last before it
 *     (in the same sentence, then earlier in the answer): "Cloudflare Workers Paid is $5 ... What the $5
 *     includes:" is about Cloudflare Workers; "Neon Launch $19" is not supported by "Supabase Pro $19";
 *   - or the source the price cites ("[12]") states that amount, and names no other product;
 *   - or it is a total: a supported unit price for the same product times a number the user or the line
 *     gave, or 12 for a year ("20 seats x $14 [2] = $280", "Pipedrive Lite for 20 seats: about $280").
 * Nothing else passes: an amount no current source states is flagged, wherever it appears.
 */
export function priceChecker(evidence: string | EvidenceDoc[], opts: PriceCheckOptions = {}): (text: string, before?: string) => string[] {
  const docs = typeof evidence === "string" ? [{ text: evidence }] : evidence;
  const names = opts.names ? nameWords(opts.names) : namesFromEvidence(docs);
  const known = docs.flatMap((d) => {
    const about = contextWords(d.about ?? "");
    const all = new Set([...contextWords(d.text), ...about]);
    return priceMentions(d.text, true).map((k) => ({ ...k, context: new Set([...k.context, ...about]), docWords: all, n: d.n, pastOnly: !!d.pastOnly }));
  });
  type Known = (typeof known)[number];
  const sameMoney = (k: Known, p: { amount: number; currency: string | null; past: boolean }) =>
    !(k.pastOnly && !p.past) && Math.abs(k.amount - p.amount) < 0.005 && !(p.currency && k.currency && p.currency !== k.currency);
  const namesIn = (words: Set<string>) => new Set([...words].filter((w) => names.has(w)));
  /** The products named last in `text` (the latest sentence or line that names any). */
  const lastNamed = (text: string): Set<string> => {
    const parts = text.split(/\n|(?<=[.!?])\s+/);
    for (let i = parts.length - 1; i >= 0; i--) {
      const found = namesIn(contextWords(parts[i]!));
      if (found.size) return found;
    }
    return new Set();
  };

  return (text: string, before = "") => {
    const bad: string[] = [];
    let lineStart = 0;
    for (const line of text.split("\n")) {
      const mentions = priceMentions(line);
      const factors = [...multipliersIn(line), ...(opts.multipliers ?? []), 12];
      const about = (p: PriceMention) => {
        const own = namesIn(p.context);
        return own.size ? own : lastNamed(`${before}\n${text.slice(0, lineStart)}${line.slice(0, p.at)}`);
      };
      const forProduct = (k: Known, product: Set<string>) => product.size === 0 || overlaps(k.context, product);
      const supported = (p: PriceMention): boolean => {
        const product = about(p);
        const same = known.filter((k) => sameMoney(k, p));
        if (same.some((k) => forProduct(k, product))) return true;
        // No product named anywhere near it: the words around the price must match the source's.
        if (product.size === 0 && same.some((k) => p.context.size === 0 || overlaps(p.context, k.context))) return true;
        // The source it cites states this amount (and is not about another product).
        return same.some((k) => k.n !== undefined && p.cites.includes(k.n) && (product.size === 0 || overlaps(k.docWords, product)));
      };
      const ok = mentions.filter(supported);
      for (const p of mentions) {
        if (ok.includes(p)) continue;
        const product = about(p);
        const near = (a: number) => factors.some((n) => Math.abs(a * n - p.amount) <= 0.005 * Math.max(1, p.amount));
        const derived =
          ok.some((k) => k !== p && near(k.amount)) ||
          known.some((k) => !k.pastOnly && (!p.currency || !k.currency || p.currency === k.currency) && near(k.amount) && forProduct(k, product) && product.size > 0);
        if (!derived) bad.push(p.text);
      }
      lineStart += line.length + 1;
    }
    return [...new Set(bad)];
  };
}

/** Prices in `answer` that no piece of `evidence` supports (see `priceChecker`). */
export function unsupportedPrices(answer: string, evidence: string | EvidenceDoc[], opts: PriceCheckOptions = {}): string[] {
  return priceChecker(evidence, opts)(answer);
}

/** Numbers in the user's question that may multiply a price (team size, months). */
export function questionMultipliers(question: string): number[] {
  return multipliersIn(question);
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
