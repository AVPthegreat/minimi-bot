// Model and user text reaches the page only through markdown.js (then dom.js `h(tag, {html})` /
// innerHTML). These tests pipe hostile input through the renderer and check the HTML string is inert:
// every tag is one the renderer writes, no event-handler attributes, every href is http(s), and no
// input can break out of an attribute. Plus the single-sink rule for public/js.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ICONS } from "../public/js/icons.js";
import { inline, markdown, safeUrl } from "../public/js/markdown.js";

const TAGS = new Set("p br strong em code pre a ul ol li h3 h4 h5 h6 blockquote hr div table thead tbody tr th td span figure figcaption time".split(" "));
const ATTRS = new Set(["class", "href", "target", "rel", "title", "scope", "tabindex", "role", "aria-label", "aria-hidden"]);
const ICON_SVGS = Object.values(ICONS as Record<string, string>);

/** Fails unless `html` holds only the renderer's own tags, with plain quoted attributes and safe hrefs. */
function assertInert(html: string, input: string) {
  let rest = html;
  for (const svg of ICON_SVGS) rest = rest.split(svg).join(""); // static icons from icons.js
  assert.doesNotMatch(rest, /<script|<img|<svg|<iframe|<style|<object|<embed/i, `raw tag for ${JSON.stringify(input)}`);
  for (const [tag] of rest.matchAll(/<[^>]*>?/g)) {
    const m = tag.match(/^<\/?([a-z][a-z0-9]*)((?:\s[a-z-]+="[^"<>]*")*)\s*>$/);
    assert.ok(m, `malformed tag ${tag} for ${JSON.stringify(input)}`);
    assert.ok(TAGS.has(m[1]!), `unexpected <${m[1]}> for ${JSON.stringify(input)}`);
    for (const [, name, value] of m[2]!.matchAll(/\s([a-z-]+)="([^"]*)"/g)) {
      assert.ok(ATTRS.has(name!), `unexpected attribute ${name} in ${tag}`);
      if (name === "href") {
        assert.match(value!, /^https?:\/\//, `unsafe href ${value}`);
        assert.match(tag, /target="_blank" rel="noopener noreferrer"/, `link without rel: ${tag}`);
      }
    }
  }
  assert.doesNotMatch(rest, /\u0000/, "placeholder leaked");
}

const HOSTILE = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  '<svg onload="alert(1)"><circle/></svg>',
  "<a href=\"javascript:alert(1)\">x</a>",
  "[x](javascript:alert(1))",
  "[x](JaVaScRiPt:alert(1))",
  "[x]( javascript:alert(1))",
  "[x](jav&#x09;ascript:alert(1))",
  "[x](java\tscript:alert(1))",
  "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[x](vbscript:msgbox(1))",
  "[x](//evil.example/path)",
  '[x](https://ok.example/"onmouseover="alert(1))',
  "[x](https://ok.example/'onmouseover='alert(1))",
  '[x](https://ok.example/a"><script>alert(1)</script>)',
  '[<img src=x onerror=alert(1)>](https://ok.example)',
  "**bold <img src=x onerror=alert(1)> _em <b onclick=x>y</b>_**",
  "_*__**<script>x</script>**__*_",
  "`<script>alert(1)</script>`",
  "```\n<script>alert(1)</script>\n```",
  "```html\n</code></pre><img src=x onerror=alert(1)>\n```",
  "| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | [x](javascript:alert(1)) |",
  "| What | Then (<b>x</b>) | Now (\"y\") | Status |\n|---|---|---|---|\n| <i>s</i>: <svg onload=1> | 1 | not found | Changed |",
  '**"onmouseover="x = <img src=x onerror=1>.** rest <script>',
  'You asked on <img src=x onerror=1>: "<script>alert(1)</script>"',
  "> <script>alert(1)</script>\n- <img onerror=1 src=x>\n1. [x](javascript:1)\n### <svg onload=1>",
  "a \u00000\u0000 b \u000099\u0000 [x](https://ok.example) \u00000\u0000",
  "price $19 (unverified) <img src=x onerror=1> [1]",
];

test("hostile markdown renders as inert HTML", () => {
  const sources = [{ n: 1, url: "https://ok.example/a", title: '"><script>alert(1)</script>', domain: "ok.example" }];
  for (const input of HOSTILE) assertInert(markdown(input, sources), input);
});

test("dangerous link schemes never become links; safe ones keep target and rel", () => {
  for (const u of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", " javascript:alert(1)", "jav&#x09;ascript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "//evil.example"]) {
    assert.equal(safeUrl(u), null, u);
  }
  assert.doesNotMatch(markdown("[x](javascript:alert(1))"), /<a /);
  const html = markdown("see [docs](https://ok.example/a?b=1&c=2)");
  assert.match(html, /<a href="https:\/\/ok\.example\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs<\/a>/);
});

test("a citation to a javascript: source is plain text, not a link", () => {
  const html = inline("claim [1]", [{ n: 1, url: "javascript:alert(1)", title: "x", domain: "x" }]);
  assert.equal(html, "claim [1]");
});

test("text that looks like the renderer's slot placeholders cannot pull in or break output", () => {
  const html = inline("x \u00000\u0000 \u00005\u0000 y");
  assert.doesNotMatch(html, /undefined|\u0000/);
  assert.equal(html, "x 0 5 y");
});

test("long and pathological inputs render in bounded time (no catastrophic backtracking)", () => {
  const n = 50_000;
  const inputs = [
    "a".repeat(n),
    " _a".repeat(n / 3),
    "*".repeat(n),
    "_".repeat(n),
    "**" + " = ".repeat(n / 3) + "x",
    "[".repeat(n) + "](" + "(".repeat(n),
    "[x](" + "h".repeat(n),
    "|".repeat(n) + "\n|---|\n" + "| a ".repeat(n / 4),
    "You asked on " + ": \"".repeat(n / 3),
    "`".repeat(n),
    "<".repeat(n) + "&".repeat(n),
    "- x\n".repeat(n / 4),
    "[x](".repeat(n / 4),
    "**a = ".repeat(n / 6),
  ];
  for (const input of inputs) {
    const t0 = performance.now();
    const html = markdown(input);
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `${JSON.stringify(input.slice(0, 20))}… took ${ms.toFixed(0)} ms`);
    assertInert(html, input.slice(0, 40));
  }
});

// The single-sink rule: raw HTML is inserted only by dom.js (`h(tag, {html})`, `icon`). The other
// sites listed here set a static icon from icons.js or the markdown renderer's output; anything new
// must go through dom.js or be reviewed and added here.
test("public/js inserts raw HTML only through dom.js and the reviewed static-icon/markdown sites", () => {
  const root = join(import.meta.dirname, "..", "public", "js");
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".js"));
  const SINK = /\.innerHTML\s*[+]?=|\.outerHTML\b|insertAdjacentHTML|document\.write/;
  const REVIEWED = /\.innerHTML = (ICONS\.\w+|icon|markdown\(text, sources\)|next === "dark" \? ICONS\.moon : ICONS\.sun|busy \? ICONS\.stop : ICONS\.send|ok \? ICONS\.check : ICONS\.x|ev\.state === "running" \? '<span class="spinner" aria-hidden="true"><\/span>' : STATE_ICON\[ev\.state\] \?\? "");/;
  const offenders: string[] = [];
  for (const f of files) {
    if (f.replace(/\\/g, "/") === "dom.js") continue;
    readFileSync(join(root, f), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (SINK.test(line) && !REVIEWED.test(line)) offenders.push(`public/js/${f}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(offenders, [], "raw HTML sink outside dom.js; use h(tag, {html}) with escaped/static HTML");
});
