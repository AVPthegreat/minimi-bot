// Which website is a product's own? Used only for logos in the UI's search steps: a step for
// "Supabase pricing" shows supabase.com's logo while it is still searching. Known names come from a
// short seed list; every finished search teaches the book the official domain it actually found
// (a result on the subject's own site), so new products get their logo from the second search on.

import { domainOf, isOfficialFor } from "./search/rank.ts";
import type { SearchResult } from "./search/types.ts";

const SEED: Record<string, string> = {
  supabase: "supabase.com", neon: "neon.com", railway: "railway.com", render: "render.com", fly: "fly.io",
  vercel: "vercel.com", netlify: "netlify.com", heroku: "heroku.com", digitalocean: "digitalocean.com",
  planetscale: "planetscale.com", cloudflare: "cloudflare.com", aws: "aws.amazon.com", firebase: "firebase.google.com",
  hubspot: "hubspot.com", pipedrive: "pipedrive.com", salesforce: "salesforce.com", zoho: "zoho.com", close: "close.com",
  notion: "notion.so", slack: "slack.com", linear: "linear.app", github: "github.com", gitlab: "gitlab.com",
  stripe: "stripe.com", figma: "figma.com", openai: "openai.com", anthropic: "anthropic.com", bun: "bun.sh", deno: "deno.com",
};

/** The subject's key: its first word, lowercased ("Zoho CRM pricing" -> "zoho"). */
function keyOf(query: string): string {
  return (query.trim().toLowerCase().split(/\s+/)[0] ?? "").replace(/[^a-z0-9]/g, "");
}

export class BrandBook {
  private readonly learned = new Map<string, string>();

  /** The product's own domain, if known; undefined for a question that names no known product. */
  domainFor(query: string): string | undefined {
    const key = keyOf(query);
    return key.length >= 3 ? (this.learned.get(key) ?? SEED[key]) : undefined;
  }

  /**
   * The domain to show for a finished search: the subject's own site among the results (learned for
   * next time), else the known one. Never just the top result: a blog's logo next to "Neon pricing"
   * would suggest the wrong owner.
   */
  fromResults(query: string, results: SearchResult[]): string | undefined {
    const own = results.find((r) => isOfficialFor(r.url, [query]));
    if (own) {
      const key = keyOf(query);
      if (this.learned.size > 500) this.learned.clear();
      this.learned.set(key, domainOf(own.url));
      return domainOf(own.url);
    }
    return this.domainFor(query);
  }
}
