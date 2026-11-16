// Safe markdown for answers. Rule: every character of model text is HTML-escaped FIRST; the only tags
// in the output are the ones this file writes. Links must be http(s). Pure functions (no DOM), so
// node tests can run them.
//
// Besides plain markdown it recognises what the agent's code writes (src/memory.ts, src/claims.ts):
//   "**Last Tuesday = Tue 10 Nov.** ..."     -> a date-reading note
//   'You asked on Tue 10 Nov: "..."'         -> a quoted earlier question with its date
//   | What | Then (..) | Now (..) | Status | -> a then/now comparison with Changed/Unchanged badges
//   "$19 (unverified)"                       -> a warning chip on the number

import { ICONS } from "./icons.js";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** Only absolute http(s) URLs become links. */
export function safeUrl(u) {
  try {
    const url = new URL(String(u).replace(/&amp;/g, "&"));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const STATUS = {
  changed: { cls: "changed", label: "Changed" },
  unchanged: { cls: "unchanged", label: "Unchanged" },
  "couldn't verify": { cls: "unverified", label: "Couldn't verify" },
  unverified: { cls: "unverified", label: "Unverified" },
};

/** Inline markdown on one line of raw text. `sources` turns [n] into citation links. */
export function inline(raw, sources = []) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = esc(raw).replace(/\u0000/g, ""); // NUL is the slot marker below; input must not forge one
  s = s.replace(/`([^`]+)`/g, (_, code) => keep(`<code>${code}</code>`));
  s = s.replace(/\[([^[\]]+)\]\(([^)\s]{1,2048})\)/g, (m, text, href) => {
    const url = safeUrl(href);
    return url ? keep(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`) : m;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])[_*]([^_*\s][^_*]*)[_*](?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  s = s.replace(/\(unverified\)/gi, () => keep(`<span class="chip chip-warn" title="No current source backs this number">${ICONS.warn}unverified</span>`));
  s = s.replace(/\[(\d{1,2})\]/g, (m, n) => {
    const src = sources.find((x) => x.n === Number(n));
    const url = src && safeUrl(src.url);
    return url ? keep(`<a class="cite" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(src.title || src.domain)}">${n}</a>`) : m;
  });
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

const LIST = /^\s*([-*]|\d+\.)\s+/;
const DATE_NOTE = /^\*\*(.{1,200}?) = (.{1,200}?)\.\*\*\s*(.*)$/; // bounded: unbounded lazy groups went quadratic
const QUOTE = /^You asked on (.+?): "(.*)"\s*$/;

function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function table(head, rows, sources) {
  const thenCol = head.findIndex((c) => /^Then \(/.test(c));
  const nowCol = head.findIndex((c) => /^Now \(/.test(c));
  const statusCol = head.findIndex((c) => /^status$/i.test(c));
  const compare = thenCol >= 0 && nowCol >= 0 && statusCol >= 0;
  const statusOf = (cell) => STATUS[cell.replace(/\*/g, "").trim().toLowerCase()];
  const th = head
    .map((c, i) => {
      const m = compare && (i === thenCol || i === nowCol) ? c.match(/^(Then|Now) \((.+)\)$/) : null;
      return m ? `<th scope="col">${m[1]}<span class="th-date">${esc(m[2])}</span></th>` : `<th scope="col">${inline(c, sources)}</th>`;
    })
    .join("");
  const body = rows
    .map((r) => {
      const st = compare ? statusOf(r[statusCol] ?? "") : null;
      const tds = head
        .map((_, i) => {
          const c = r[i] ?? "";
          if (compare && i === statusCol && st) return `<td><span class="badge badge-${st.cls}">${st.label}</span></td>`;
          if (compare && i === 0 && c.includes(": ")) {
            const [subject, ...rest] = c.split(": ");
            return `<th scope="row"><span class="subject">${inline(subject, sources)}</span><span class="attr">${inline(rest.join(": "), sources)}</span></th>`;
          }
          if (compare && i === nowCol && /^not found$/i.test(c)) return `<td class="muted-cell">not found</td>`;
          if (compare && (i === thenCol || i === nowCol)) return `<td class="${i === nowCol ? "now" : "then"}">${inline(c, sources)}</td>`;
          // A short first-column name ("Supabase") stays on one line; a long one may wrap at spaces.
          if (i === 0 && c.trim().length <= 24) return `<td class="nowrap">${inline(c, sources)}</td>`;
          return `<td>${inline(c, sources)}</td>`;
        })
        .join("");
      return `<tr${st ? ` class="row-${st.cls}"` : ""}>${tds}</tr>`;
    })
    .join("");
  return `<div class="table-wrap${compare ? " compare" : ""}" tabindex="0" role="region" aria-label="${compare ? "Then and now comparison" : "Table"}"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Markdown text -> HTML string (safe to assign to innerHTML). */
export function markdown(text, sources = []) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    } else if (line.trim().startsWith("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || "")) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(splitRow(lines[i++]));
      out.push(table(head, rows, sources));
    } else if (LIST.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && LIST.test(lines[i])) items.push(lines[i++].replace(LIST, ""));
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((x) => `<li>${inline(x, sources)}</li>`).join("")}</${tag}>`);
    } else if (/^#{1,4}\s/.test(line)) {
      const level = Math.min(4, line.match(/^#+/)[0].length + 2);
      out.push(`<h${level}>${inline(line.replace(/^#+\s/, ""), sources)}</h${level}>`);
      i++;
    } else if (/^>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${q.map((x) => inline(x, sources)).join("<br>")}</blockquote>`);
    } else if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      out.push("<hr>");
      i++;
    } else if (DATE_NOTE.test(line)) {
      const [, said, date, rest] = line.match(DATE_NOTE);
      out.push(
        `<div class="note note-date">${ICONS.calendar}<div><p class="note-title">${inline(said)} <span aria-hidden="true">→</span><span class="visually-hidden">means</span> <strong>${inline(date)}</strong></p>${rest ? `<p class="note-text">${inline(rest, sources)}</p>` : ""}</div></div>`,
      );
      i++;
    } else if (QUOTE.test(line)) {
      const [, when, question] = line.match(QUOTE);
      out.push(`<figure class="recall"><figcaption>${ICONS.memory}You asked on <time>${esc(when)}</time></figcaption><blockquote>${inline(question)}</blockquote></figure>`);
      i++;
    } else if (line.trim() === "") {
      i++;
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() !== "" && !/^\s*([-*]|\d+\.)\s+|^#{1,4}\s|^```|^\s*\||^>/.test(lines[i]) && !DATE_NOTE.test(lines[i]) && !QUOTE.test(lines[i])) para.push(lines[i++]);
      if (para.length === 0) para.push(lines[i++]);
      out.push(`<p>${para.map((p) => inline(p, sources)).join("<br>")}</p>`);
    }
  }
  return out.join("");
}

/** Plain text for the copy button: markdown kept as written (it pastes well), code-only notes included. */
export const plainText = (text) => String(text ?? "").trim();
