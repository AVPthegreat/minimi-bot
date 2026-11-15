import assert from "node:assert/strict";
import { test } from "node:test";
import { diffClaim, grammarClaims, parseValue, renderDiffTable, sameValue, unsupportedPrices } from "../src/claims.ts";

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
