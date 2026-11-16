// The search plan, owned by code. A comparison ("Supabase, Neon and Railway", "HubSpot vs Pipedrive")
// names its subjects in the message itself, so we read them here, instantly and testably, and search
// one query per subject in parallel. The router model only adds queries when code finds no list.
// (Live, the small router model regularly missed its 1.5 s budget, the fallback plan was "search the
// raw question once", and the per-product fan-out silently never happened.)

import { stopwordsTopic } from "./router.ts";

/** Most comparisons name 2-5 things; more than that is a list, not a shortlist. */
export const MAX_SUBJECTS = 5;

// A product name: 1-3 capitalised words ("Zoho CRM", "Cloudflare Workers", "Close").
const NAME = String.raw`[A-Z][\w.+&-]*(?:\s+[A-Z][\w.+&-]*){0,2}`;
const SEP = String.raw`(?:\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or|vs\.?|versus)\s+)`;
const LIST_RE = new RegExp(`${NAME}(?:${SEP}${NAME})+`, "g");

// Capitalised words that start sentences or name days, not products.
const NOT_NAMES = new Set(
  ("I We We're Our My Me It Its They And Or For In Of What Which How Compare Comparing Is Are Has Have On Last The Tell Should " +
    "Give Can Do Does Please Show List Between Who Why When Where Monday Tuesday Wednesday Thursday Friday Saturday Sunday " +
    "January February March April May June July August September October November December").split(" "),
);

function cleanName(raw: string): string {
  const words = raw.trim().split(/\s+/);
  while (words.length && NOT_NAMES.has(words[0]!)) words.shift();
  return words.join(" ").replace(/[.,]+$/, "");
}

/** The subjects of a comparison, in the order the user named them (empty when there is no list). */
export function planSubjects(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(LIST_RE)) {
    for (const part of m[0].split(new RegExp(SEP))) {
      const name = cleanName(part);
      if (name && !out.some((s) => s.toLowerCase() === name.toLowerCase())) out.push(name);
    }
  }
  return out.length >= 2 ? out.slice(0, MAX_SUBJECTS) : [];
}

/** One query per subject: the subject plus what is being asked about it ("Neon pricing"). */
export function subjectQueries(subjects: string[], text: string): string[] {
  if (/\b(pric\w*|cost\w*|fees?|plans?|cheap\w*|expensive|per (seat|user|month))\b|[$€£₹]/i.test(text)) {
    return subjects.map((s) => `${s} pricing`);
  }
  const names = new Set(subjects.flatMap((s) => s.toLowerCase().split(/\s+/)));
  const topic = stopwordsTopic(text)
    .split(/\s+/)
    .filter((w) => !names.has(w.toLowerCase()) && !NOT_NAMES.has(w))
    .slice(0, 4)
    .join(" ");
  return subjects.map((s) => `${s} ${topic}`.trim());
}

/**
 * Facts are stored under the subjects the agent searched for, so a later re-check runs exactly one
 * search per product: "HubSpot Sales Hub" with planned subject "HubSpot" becomes subject "HubSpot",
 * attribute "Sales Hub Starter plan price".
 */
export function canonicalSubject<T extends { subject: string; attribute: string }>(claim: T, subjects: string[]): T {
  const s = claim.subject.trim();
  for (const planned of subjects) {
    if (s.toLowerCase() === planned.toLowerCase()) return { ...claim, subject: planned };
    // The model shortened the name ("Zoho" for "Zoho CRM"): file it under the name that was searched.
    if (planned.toLowerCase().startsWith(s.toLowerCase() + " ")) return { ...claim, subject: planned };
    if (s.toLowerCase().startsWith(planned.toLowerCase() + " ")) {
      const extra = s.slice(planned.length).trim();
      const attribute = claim.attribute.toLowerCase().startsWith(extra.toLowerCase()) ? claim.attribute : `${extra} ${claim.attribute}`;
      return { ...claim, subject: planned, attribute };
    }
  }
  return claim;
}

/**
 * At most `max` facts, taken round-robin across subjects so every product of a shortlist is covered
 * (a plain "first 12" kept 3 CRMs with 4 tiers each and dropped the other 2).
 */
export function fairCap<T extends { subject: string }>(items: T[], max: number, perSubject = Infinity): T[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = it.subject.trim().toLowerCase();
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  const out: T[] = [];
  for (let round = 0; out.length < max && round < perSubject; round++) {
    let added = false;
    for (const g of groups.values()) {
      if (g[round] && out.length < max) {
        out.push(g[round]!);
        added = true;
      }
    }
    if (!added) break;
  }
  // Keep the caller's order (most important first within a subject, subjects in the order seen).
  return items.filter((it) => out.includes(it));
}
