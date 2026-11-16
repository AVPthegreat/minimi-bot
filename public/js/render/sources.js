// Sources under an answer: cards with the site's logo, the page title, the date and an "Official" mark.
// The numbers match the [n] citations in the text. Only http(s) links are shown.
import { h } from "../dom.js";
import { safeUrl } from "../markdown.js";
import { logo } from "./logo.js";

const VISIBLE = 4;

export function renderSources(container, sources) {
  const list = (sources ?? []).filter((s) => safeUrl(s.url));
  container.replaceChildren();
  container.hidden = list.length === 0;
  if (!list.length) return;
  const cards = list.map((s, i) =>
    h("li", { class: i >= VISIBLE ? "more" : null },
      h("a", { class: "source", href: safeUrl(s.url), target: "_blank", rel: "noopener noreferrer", title: s.title || s.domain },
        h("span", { class: "source-top" }, logo(s.domain, s.domain), h("span", { class: "source-domain" }, s.domain), h("span", { class: "source-n", "aria-label": `source ${s.n}` }, String(s.n))),
        h("span", { class: "source-title" }, s.title || s.url),
        h("span", { class: "source-meta" }, s.official ? h("span", { class: "badge badge-official" }, "Official") : null, s.date ? h("span", {}, s.date) : null),
      ),
    ),
  );
  const ul = h("ul", { class: "sources-grid" }, cards);
  const head = h("p", { class: "sources-head" }, `${list.length} source${list.length === 1 ? "" : "s"}`);
  container.append(head, ul);
  if (list.length > VISIBLE) {
    const more = h("button", { class: "btn btn-small btn-ghost", type: "button", "aria-expanded": "false" }, `Show ${list.length - VISIBLE} more`);
    more.addEventListener("click", () => {
      const open = ul.classList.toggle("all");
      more.setAttribute("aria-expanded", String(open));
      more.textContent = open ? "Show fewer" : `Show ${list.length - VISIBLE} more`;
    });
    container.append(more);
  }
}
