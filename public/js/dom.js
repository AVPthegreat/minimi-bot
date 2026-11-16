// A tiny element builder. Text always goes in as text (textContent), never as HTML; the only HTML
// this app inserts comes from icons.js (static) and markdown.js (escapes everything first).
import { ICONS } from "./icons.js";

/**
 * h("button", { class: "btn", onclick: fn, "aria-label": "Copy" }, "text", childNode, ...)
 * Attributes starting with "on" become listeners; `icon: "copy"` prepends an icon; null/false children are skipped.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "icon") el.insertAdjacentHTML("afterbegin", ICONS[v] ?? "");
    else if (k === "html") el.innerHTML = v; // only for trusted, generated HTML (icons, markdown output)
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Copies text, with a fallback for browsers without the async clipboard API. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { class: "visually-hidden", "aria-hidden": "true" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand?.("copy") ?? false;
    ta.remove();
    return ok;
  }
}
