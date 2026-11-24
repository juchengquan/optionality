/** The account page (#471) for the layout suites (`__browser__/Account*.test.tsx`): drawn on one
 *  of the made-up answers in `testing/account.ts`, and measured for what a reader needs of it — nothing pushed sideways, and
 *  every figure of every row drawn whole, inside its row: folded, and with its combined rows opened. */
import { act, fireEvent, render } from "@testing-library/react";

import { Page } from "../Page";
import type { Account } from "../shared/api";
import { ACCOUNT, COMBOS, EMPTY, NO_RATE, NOT_LIVE, PAPER, REFUSALS, serveAccount, TWO_CURRENCIES } from "./account";

/** as the book's layout suites wait (`__browser__/nextBook.ts`): long enough for the read to land */
const settle = () => new Promise((r) => setTimeout(r, 250));

/** TWO_CURRENCIES a thousand times over, for wide figures. */
const scaled = (n: number | null) => (n === null ? null : n * 1_000);
export const LARGE: Account = {
  ...TWO_CURRENCIES,
  totals: {
    net_liquidation: scaled(TWO_CURRENCIES.totals.net_liquidation), total_cash: scaled(TWO_CURRENCIES.totals.total_cash),
    unrealized_pnl: scaled(TWO_CURRENCIES.totals.unrealized_pnl), realized_pnl: scaled(TWO_CURRENCIES.totals.realized_pnl),
    daily_pnl: scaled(TWO_CURRENCIES.totals.daily_pnl),
  },
  stocks: TWO_CURRENCIES.stocks.map((s) => ({
    ...s, position: scaled(s.position), market_value: scaled(s.market_value), unrealized_pnl: scaled(s.unrealized_pnl),
    daily_pnl: scaled(s.daily_pnl),
  })),
  options: TWO_CURRENCIES.options.map((o) => ({
    ...o, position: scaled(o.position), market_value: scaled(o.market_value), unrealized_pnl: scaled(o.unrealized_pnl),
    daily_pnl: scaled(o.daily_pnl),
  })),
  other: TWO_CURRENCIES.other.map((o) => ({ ...o, market_value: scaled(o.market_value) })),
};

/** COMBOS a thousand times over, for wide combined rows and folded totals. */
export const LARGE_COMBOS: Account = {
  ...COMBOS,
  options: COMBOS.options.map((o) => ({
    ...o, position: scaled(o.position), market_value: scaled(o.market_value), unrealized_pnl: scaled(o.unrealized_pnl),
    daily_pnl: scaled(o.daily_pnl),
  })),
};

/** Every state the page draws an answer in, by name. */
export const STATES = {
  loaded: ACCOUNT,
  "not live yet": NOT_LIVE,
  paper: PAPER,
  empty: EMPTY,
  "two currencies": TWO_CURRENCIES,
  "no rate": NO_RATE,
  large: LARGE,
  combos: COMBOS,
  "large combos": LARGE_COMBOS,
  "not configured": REFUSALS.notConfigured,
  "not answering": REFUSALS.notAnswering,
  deadline: REFUSALS.deadline,
  "several accounts": REFUSALS.severalAccounts,
  "refused session": REFUSALS.refusedSession,
} as const;

/** The page drawn on `answer`. `privacy`: with the book's privacy setting on. `thenFails`: a refresh
 *  after that read, refused so — the last figures kept, dimmed, under the error. */
export async function showAccount(answer: (typeof STATES)[keyof typeof STATES], { privacy = false, thenFails }: {
  privacy?: boolean; thenFails?: { status: number; detail: string };
} = {}): Promise<void> {
  document.cookie = `ui_privacy=${privacy ? "on" : "off"};path=/`;
  const svc = serveAccount(answer);
  render(<Page path="/opt/account" base="/opt/" />);
  await settle();
  if (thenFails) {
    svc.answer = thenFails;
    await act(async () => { fireEvent.click(document.querySelector<HTMLButtonElement>('[aria-label="refresh now"]')!); });
    await settle();
  }
}

/** Every combined row opened, then every section and underlying folded: from the inside out, so
 *  each heading is pressed while it is drawn. */
async function pressAll(selector: string): Promise<void> {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(selector)].reverse();
  for (const b of buttons) await act(async () => { fireEvent.click(b); });
}
export const openCombos = () => pressAll(".nx-acct-combo-toggle");
export const foldAll = () => pressAll(".nx-acct-fold");

/** The variants beside the states: privacy on, a failed refresh after a good read, and the folds
 *  and combined rows each way. */
export const VARIANTS = {
  "privacy on": () => showAccount(TWO_CURRENCIES, { privacy: true }),
  "failed refresh after a good read": () => showAccount(TWO_CURRENCIES, { thenFails: REFUSALS.notAnswering }),
  "every combined row opened": async () => { await showAccount(LARGE_COMBOS); await openCombos(); },
  "every combined row opened, privacy on": async () => { await showAccount(LARGE_COMBOS, { privacy: true }); await openCombos(); },
  "everything folded": async () => { await showAccount(LARGE); await foldAll(); },
  "everything folded, no rate": async () => { await showAccount(NO_RATE); await foldAll(); },
  "everything folded, privacy on": async () => { await showAccount(LARGE_COMBOS, { privacy: true }); await foldAll(); },
} as const;

/** Every figure, currency and lead of every row that is not drawn whole inside its place: cut by its
 *  own box, or reaching past the sides of its row, or of its own cell or label-and-figure pair — where
 *  it would be drawn over its neighbour's figure while still inside the row. */
export function cutShort(): string[] {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-holding]")];
  return rows.flatMap((row) => {
    // each row's own, never those of the legs drawn inside a combined card, nor anything not drawn
    const own = [...row.querySelectorAll<HTMLElement>("[data-fig], [data-currency], .nx-acct-lead, th")]
      .filter((el) => el.closest("[data-holding]") === row && el.getClientRects().length > 0);
    return own.flatMap((el) => {
      const r = el.getBoundingClientRect();
      const clipped = el.scrollWidth > Math.ceil(r.width) + 0.5;
      const places = [row, el.closest<HTMLElement>("td, .nx-acct-figs > div, .nx-acct-card-head")]
        .filter((p): p is HTMLElement => p !== null && p !== el);
      const outside = places.find((p) => {
        const box = p.getBoundingClientRect();
        return r.left < box.left - 0.5 || r.right > box.right + 0.5;
      });
      if (!clipped && !outside) return [];
      const box = (outside ?? row).getBoundingClientRect();
      return [`${row.dataset.holding}: ${el.textContent} (${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(box.left)}–${Math.round(box.right)})`];
    });
  });
}

/** Which way a fold's or a combined row's chevron points, as drawn: by its stroke's box on the
 *  screen, which every transform it is drawn under turns with it — a right chevron (›) is twice as
 *  tall as it is wide, a down one twice as wide as it is tall, and one caught between the two, as a
 *  corner (⌟), neither — and by its own computed transform, `rotate(90deg)` as a matrix. */
export function chevron(button: Element): { points: "right" | "down" | "between"; box: string; transform: string } {
  const svg = button.querySelector<SVGSVGElement>(".nx-acct-mark")!;
  const r = svg.querySelector("path")!.getBoundingClientRect();
  const transform = getComputedStyle(svg).transform;
  const points = r.height > 1.5 * r.width ? "right" : r.width > 1.5 * r.height ? "down" : "between";
  return { points, box: `${r.width.toFixed(1)}×${r.height.toFixed(1)}`, transform };
}

/** Every total and every piece of the line under them (the account, its base, IBKR's time, the live
 *  line) that is not drawn whole: a figure broken over two lines, or either reaching past the screen. */
export function totalsCut(): string[] {
  const width = document.documentElement.clientWidth;
  const lines = (el: Element) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
  };
  return [...document.querySelectorAll<HTMLElement>(".nx-acct-total-figs dd, .nx-acct-about > span")].flatMap((el) => {
    const r = el.getBoundingClientRect();
    const broken = el.tagName === "DD" && lines(el) > 1;
    return broken || r.left < -0.5 || r.right > width + 0.5
      ? [`${el.textContent} (${Math.round(r.left)}–${Math.round(r.right)} of ${width}${broken ? ", broken" : ""})`] : [];
  });
}
