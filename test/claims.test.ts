import assert from "node:assert/strict";
import { test } from "node:test";
import { diffClaim, grammarClaims, parseValue, renderDiffTable, sameValue, summarizeDiff, unsupportedPrices } from "../src/claims.ts";

test("values compare as numbers when they can", () => {
  assert.ok(sameValue("$19", "19 USD"));
  assert.ok(sameValue("$1,999", "$1999.00"));
  assert.ok(!sameValue("$19", "$15"));
  assert.ok(!sameValue("$19", "€19"));
  assert.ok(sameValue("Free", "$0"));
  assert.ok(sameValue("Generally available", "generally  available"));
  assert.deepEqual(parseValue("₹1,499").amount, 1499);
  assert.deepEqual(parseValue("$2.5k").amount, 2500);
});

test("diff statuses", () => {
  const old = { subject: "Neon", attribute: "Launch plan price", value: "$19", unit: "per month" };
  assert.equal(diffClaim(old, { value: "$15", unit: "per month" }).status, "changed");
  assert.equal(diffClaim(old, { value: "19", unit: "per month" }).status, "unchanged");
  assert.equal(diffClaim(old, { value: "$19", unit: "per year" }).status, "changed");
  assert.equal(diffClaim(old, null).status, "unverified");
});

test("diff table is rendered by code and escapes pipes", () => {
  const t = renderDiffTable(
    [{ subject: "A|B", attribute: "price", oldValue: "$1", newValue: "$2", status: "changed", sourceN: 3 }],
    "Tue 10 Nov",
    "Wed 18 Nov",
  );
  assert.match(t, /\| A\\\|B: price \| \$1 \| \$2 \[3\] \| \*\*Changed\*\* \|/);
});

test("price guard flags prices that are in no source", () => {
  const evidence = "Neon: the Launch plan costs $19 per month.";
  assert.deepEqual(unsupportedPrices("Neon is $19 a month.", evidence), []);
  assert.deepEqual(unsupportedPrices("Neon is $19, Scale is $59.", evidence), ["$59"]);
  assert.deepEqual(unsupportedPrices("Costs 25 USD.", "it is $25"), []);
});

test("fixture grammar extracts facts", () => {
  const c = grammarClaims("Supabase: the Pro plan costs $25 per month. Close: the Startup plan costs $49 per seat per month.");
  assert.deepEqual(
    c.map((x) => [x.subject, x.attribute, x.value, x.unit]),
    [
      ["Supabase", "Pro plan price", "$25", "per month"],
      ["Close", "Startup plan price", "$49", "per seat per month"],
    ],
  );
});

test("non-money values compare as text, so versions, sizes and dates that change are caught", () => {
  assert.ok(!sameValue("2 GB", "2 TB"));
  assert.ok(!sameValue("18.1.0", "18.1.5"));
  assert.ok(!sameValue("2026-11-03", "2026-12-01"));
  assert.ok(sameValue("20", "20"));
  assert.ok(sameValue("$20", "20"));
});

test("price guard checks the amount, the currency and what the price belongs to", () => {
  const current = "Neon: the Launch plan costs $15 per month. Supabase: the Pro plan costs $19 per month.";
  assert.deepEqual(unsupportedPrices("Neon's Launch plan is $19 per month.", current), ["$19"]); // $19 belongs to Supabase
  assert.deepEqual(unsupportedPrices("Neon's Launch plan is €15 per month.", current), ["€15"]); // wrong currency
  assert.deepEqual(unsupportedPrices("Neon's Launch plan is $15 per month.", current), []);
  assert.deepEqual(unsupportedPrices("Supabase Pro is $19 and Neon Launch is $15.", current), []);
  // Table rows: the subject in the first cell is the context for every price in the row.
  const table = "| Neon: Launch plan price | $19 per month | $15 per month [1] | **Changed** |";
  assert.deepEqual(unsupportedPrices("Neon Launch went from $19 to $15.", table), []);
});

test("re-check summary is honest about what could not be verified", () => {
  const row = (status: "changed" | "unchanged" | "unverified") => ({ subject: "X", attribute: "a", oldValue: "$1", newValue: status === "unverified" ? null : "$1", status });
  assert.equal(summarizeDiff([row("unverified"), row("unverified")], "Tue 10 Nov"), "I couldn't verify any of the 2 facts from Tue 10 Nov against current sources.");
  assert.equal(summarizeDiff([row("unchanged"), row("unchanged")], "Tue 10 Nov"), "Nothing I checked has changed since Tue 10 Nov (2 of 2 verified).");
  assert.equal(
    summarizeDiff([row("changed"), row("unchanged"), row("unchanged"), row("unverified"), row("unverified")], "Tue 10 Nov"),
    "Since Tue 10 Nov: **1 changed**, 2 unchanged, 2 I couldn't verify.",
  );
  assert.equal(summarizeDiff([row("unchanged"), row("unverified")], "Tue 10 Nov"), "Since Tue 10 Nov: 1 unchanged, 1 I couldn't verify.");
});
