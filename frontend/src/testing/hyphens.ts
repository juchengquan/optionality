/** The hyphen-minus guard's reader (the owner's standard, 2026-11-16): a hyphen-minus used as a
 *  SIGN, where the page writes the true minus, U+2212.
 *
 *  A sign is a hyphen-minus with no letter, digit, point or underscore before it, before a digit, a
 *  `$`, a point or a leg (`-C8050`). A hyphen INSIDE a word is not a sign and is left alone: a date
 *  (`2026-12-31`), a name the owner typed (`1218-6800`), and a name the add form derives and stores
 *  (`1231_-C8050+C8100`, add.ts `derivedName`) — stored names are data, written as stored. */
export const HYPHEN_SIGN = /(?<![\w.])-(?=[\d$.]|[CP]\d)/;

/** Every place `text` uses a hyphen-minus as a sign, with what is around it. */
export function hyphenSigns(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(HYPHEN_SIGN.source, "g"))) {
    out.push(text.slice(Math.max(0, m.index - 24), m.index + 12));
  }
  return out;
}

/** Everything an element and its descendants SAY: their text, and every title and aria-label — a
 *  figure in a tooltip or read to a screen reader is a figure on the page too. */
export function saidBy(root: Element): string {
  const attrs = [root, ...root.querySelectorAll("*")].flatMap((el) =>
    ["title", "aria-label", "aria-valuetext"].map((a) => el.getAttribute(a)).filter((v): v is string => Boolean(v)));
  return [root.textContent ?? "", ...attrs].join(" | ");
}
