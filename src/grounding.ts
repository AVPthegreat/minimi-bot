// Grounding, enforced in code while the answer streams. The answer model's text passes through this
// guard on its way to the user: text without numbers goes out at once; a sentence (or table row) that
// contains a price is held until it is complete, checked against the current evidence, and any price
// no gathered source supports is marked "(unverified)" in place before the user sees it. A prompt can
// ask for sourced prices; only this makes an unsourced price impossible to show as fact.

// A price can start with a sign, a digit or a currency code ("USD 5", "Rs. 499").
const PRICE_START = /[$€£₹]|\d|\b(?:USD|EUR|GBP|INR|Rs)\b/i;

export class GroundingGuard {
  /** Every price that was marked unverified (for the warnings and the stored message meta). */
  readonly flagged: string[] = [];
  private line = "";
  private emitted = 0; // chars of `line` already sent
  /** The finished text so far (the tail of it): what a price with no product named next to it refers back to. */
  private done = "";

  /**
   * `check` returns the unsupported prices in a finished line, given the text before it; it is called with
   * the evidence as of then.
   */
  constructor(private readonly check: (line: string, before: string) => string[]) {}

  /** Feed model text; returns what can be shown now. */
  push(text: string): string {
    this.line += text;
    let out = "";
    for (;;) {
      const end = this.boundary();
      if (end < 0) break;
      out += this.finish(this.line.slice(0, end));
      this.line = this.line.slice(end);
      this.emitted = 0;
    }
    // The unfinished rest: send everything before the first digit or currency sign; hold the remainder.
    const first = this.line.slice(this.emitted).search(PRICE_START);
    const upTo = first < 0 ? this.line.length : this.emitted + first;
    if (upTo > this.emitted) {
      out += this.line.slice(this.emitted, upTo);
      this.emitted = upTo;
    }
    return out;
  }

  /** End of the stream: check and release whatever is held. */
  end(): string {
    const out = this.finish(this.line);
    this.line = "";
    this.emitted = 0;
    return out;
  }

  /** Where the current unit ends: a newline, or (outside tables) the end of a sentence. */
  private boundary(): number {
    const nl = this.line.indexOf("\n");
    if (this.line.trimStart().startsWith("|")) return nl < 0 ? -1 : nl + 1;
    // A sentence ends at punctuation followed by a space (so "$0.30" is never cut at its dot, nor "Rs. 499").
    const m = /(?<!\bRs)[.!?](?:\s?\[\d{1,2}\])*(?=\s)/i.exec(this.line); // "Rs. 499" is one price
    const sentence = m ? m.index + m[0].length : -1;
    if (nl >= 0 && (sentence < 0 || nl < sentence)) return nl + 1;
    return sentence;
  }

  private finish(unit: string): string {
    let held = unit.slice(this.emitted);
    const before = this.done;
    this.done = (this.done + unit).slice(-4000);
    if (!PRICE_START.test(held)) return held;
    for (const price of this.check(unit, before)) {
      // The currency code may already be on screen ("Rs." went out before its number arrived): mark the number.
      const num = price.match(/\d[\d,.]*(?:\s?[km]\b)?(?:\s?(?:USD|EUR|GBP|INR))?$/i)?.[0] ?? price;
      const mark = held.includes(price) ? price : num;
      const at = held.indexOf(mark);
      if (at < 0) continue;
      this.flagged.push(price);
      held = `${held.slice(0, at + mark.length)} (unverified)${held.slice(at + mark.length)}`;
    }
    return held;
  }
}
