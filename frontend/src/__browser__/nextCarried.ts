/** For the browser suites carried from today's page to `/opt/next` (#337). Not a test file, so it
 *  may not import `testing/` (`make check-test-support`). */
import { serveBook } from "./nextBook";

/** Three References in the widest shapes the strip can draw, carried from `References.test.tsx`: a label, a vendor, up to two
 *  freshness marks, a five-digit figure and a signed percentage — more text than a 390px screen has
 *  room for on one line. */

export const REFERENCES = [
  {
    id: "r1", code: "SPX", label: "SPX", source: "ibkr", name: "S&P 500",
    // the longest line the strip can draw: a vendor AND both freshness flags
    delayed: true, last_known: true, delayed_by_minutes: null,
    figure: 7587.3, field: "mid_price", change: 0.003982956650611325, error: null,
  },
  {
    id: "r2", code: "^NDX", label: "Nasdaq 100", source: "yahoo", name: "NASDAQ-100",
    // and the other long shape: stated minutes rather than a bare tier
    delayed: true, last_known: true, delayed_by_minutes: 15,
    figure: 14962.5, field: "last_price", change: -0.0123, error: null,
  },
  {
    id: "r3", code: "US.VIXY", label: null, source: "moomoo", name: "ProShares VIX Short-Term",
    delayed: null, last_known: null, delayed_by_minutes: null,
    figure: 42.18, field: "mid_price", change: 0.0415, error: null,
  },
];

/** The layout book (`serveBook`) as the service serves it today: every row of `/quotes` and
 *  `/positions/values` carries SPX's derived price (ADR 0024), null here where the layout book
 *  predates it and leaves it out. A payoff chart drawn for a row with no `spx` at all reads
 *  `undefined` as a price and throws (`Payoff.tsx`'s `pnlAt`), which the service never sends. */
export function serveServedBook(): void {
  serveBook();
  const book = window.fetch;
  window.fetch = (async (url: string, init?: RequestInit) => {
    const answer = await book(url, init);
    if (!/\/(quotes|positions\/values)$/.test(String(url))) return answer;
    const rows = await answer.json() as Record<string, unknown>[];
    const served = rows.map((r) => ({ spx: null, spx_reason: "no derived price in this fixture", ...r }));
    return { ok: answer.ok, status: answer.status, json: () => Promise.resolve(served) } as Response;
  }) as typeof fetch;
}

/** The served book, with `REFERENCES` as what `/references` answers. */
export function serveReferences(): void {
  serveServedBook();
  const book = window.fetch;
  window.fetch = ((url: string, init?: RequestInit) => (String(url).endsWith("/references")
    ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(REFERENCES) })
    : book(url, init))) as typeof fetch;
}

/** The strip's items, and how many lines they took. */
export function stripLines(): { items: HTMLElement[]; lines: number } {
  const items = [...document.querySelectorAll<HTMLElement>(".nx .references .reference")];
  return { items, lines: new Set(items.map((i) => Math.round(i.getBoundingClientRect().top))).size };
}

