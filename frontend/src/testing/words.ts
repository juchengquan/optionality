/** The page's words, as the guards read them (the owner's standard of 2026-11-16, parts F, G and N):
 *  each check a function of what a place SAYS (`hyphens.saidBy`), returning every offending bit
 *  with what is around it. `WordsPage.test.tsx` runs them over the whole page and holds each to a
 *  planted fault; `PlainErrors.test.tsx` reads a failing page with one. */

/** The zones the page may mark a clock with, in the walk's world: New York's, as `ET`, and the
 *  viewer's DISPLAY_TZ by its name — Asia/Singapore's `SGT` (review of #420: any two to five capitals
 *  would have passed `21:04 EST` or a word that happened to follow). Nothing is asked of what comes
 *  after the mark: the page's text runs words together ("SGTHoldings", "SGTup is"). */
export const ZONES = ["ET", "SGT"];
const ZONE = `(?:${ZONES.join("|")})`;
const CLOCK = new RegExp(String.raw`(?<![\d:.])([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?![\d:])(?! ${ZONE})`, "g");

/** Each check: a name, and every offending bit of `text` it finds. */
export const CHECKS: Record<string, (text: string) => string[]> = {
  "a clock with no zone": (text) => [...text.matchAll(CLOCK)].map((m) => around(text, m.index)),
  "an offset for a zone": (text) => [...text.matchAll(/\d[+-]\d{2}:\d{2}\b/g)].map((m) => around(text, m.index)),
  "an ISO date": (text) => [...text.matchAll(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g)].map((m) => around(text, m.index)),
  "Monitor, where the page says rule": (text) => [...text.matchAll(/\bmonitors?\b/gi)].map((m) => around(text, m.index)),
  "a raw error": (text) => [...text.matchAll(/Failed to fetch|Load failed|NetworkError|ECONN\w*|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|socket hang up/g)]
    .map((m) => around(text, m.index)),
};

const around = (text: string, at: number) => text.slice(Math.max(0, at - 30), at + 24);

const MONTH = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";

/** A date written any way but YYYYMMDD (the owner's standard of 2026-11-17): the day and the month in
 *  words, either way round (`31 Dec`, `Dec 31`), or the six digits a contract's code carries
 *  (`261231`). Read over each text node APART (`textsOf`) as well as the whole, because the page's
 *  text runs together: `261218` in one cell and `7150P` in the next read as one number. The six
 *  digits are a year from 20 to 29, a month and a day, standing alone — not inside a code
 *  (`US.SPXW261231C8100000`), a name (`261231_8050`), the whole date (`20261231`) or a figure. */
export const DATE_CHECKS: Record<string, (text: string) => string[]> = {
  "a date in words": (text) => [...text.matchAll(new RegExp(String.raw`(?<![\w])\d{1,2} (?:${MONTH})\b|\b(?:${MONTH}) \d{1,2}(?!\d)`, "g"))]
    .map((m) => around(text, m.index)),
  "a six-digit date": (text) => [...text.matchAll(/(?<![\w.\-+\u2212$])2\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?![\w.,\-])/g)]
    .map((m) => around(text, m.index)),
};

/** What a place says, node by node: each text node's own text and each label, apart. */
export function textsOf(root: Element): string {
  const copy = root.cloneNode(true) as Element;
  for (const raw of copy.querySelectorAll("[data-raw]")) raw.remove();
  const out: string[] = [];
  const walker = copy.ownerDocument.createTreeWalker(copy, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.trim()) out.push(n.textContent);
  for (const el of [copy, ...copy.querySelectorAll("*")]) {
    for (const a of ["title", "aria-label", "aria-valuetext"]) { const v = el.getAttribute(a); if (v) out.push(v); }
  }
  return out.join(" | ");
}


/** What a place says in WORDS: its text and labels with every raw disclosure (`ErrorWords.tsx`'s
 *  `data-raw`) taken out — what was thrown or served is kept there on purpose, raw, one tap away. */
export function wordsOf(root: Element, said: (el: Element) => string): string {
  const copy = root.cloneNode(true) as Element;
  for (const raw of copy.querySelectorAll("[data-raw]")) raw.remove();
  return said(copy);
}
