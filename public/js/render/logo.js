// A site's logo as a small rounded tile. Served by our own server (/api/logo), which always returns an
// image (the real logo or a letter tile), so the browser never calls a third party.
import { api } from "../api.js";
import { h } from "../dom.js";

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export const validDomain = (d) => typeof d === "string" && DOMAIN.test(d);

/** Logo tile for a domain; without a usable domain, a letter tile from `label` drawn here. */
export function logo(domain, label = "", cls = "") {
  if (validDomain(domain)) {
    return h("span", { class: `logo ${cls}` }, h("img", { src: api.logoUrl(domain.toLowerCase()), alt: "", width: 20, height: 20, loading: "lazy", decoding: "async" }));
  }
  const letter = (label.trim()[0] || "?").toUpperCase();
  return h("span", { class: `logo logo-letter ${cls}`, "aria-hidden": "true" }, letter);
}
