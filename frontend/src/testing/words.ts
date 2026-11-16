/** The page's words, as the guards read them (the owner's standard of 2026-11-16, parts F, G and N):
 *  each check a function of what a place SAYS (`hyphens.saidBy`), returning every offending bit
 *  with what is around it. `WordsPage.test.tsx` runs them over the whole page and holds each to a
 *  planted fault; `PlainErrors.test.tsx` reads a failing page with one. */

/** A zone's mark after a clock: `ET`, a short name (`SGT`, `EST`, `AEDT`), `UTC`, or an offset's name. */
// the end of the mark is the end of its capitals: the page's text runs words together ("SGTup is")
const ZONE = String.raw`(?:GMT[+\-−]\d{1,2}(?::\d{2})?(?!\d)|[A-Z]{2,5}(?![A-Z]))`;
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

