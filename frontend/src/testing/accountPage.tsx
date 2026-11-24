/** The account page (#471) for the layout suites (`__browser__/Account*.test.tsx`): drawn on one
 *  of the made-up answers in `testing/account.ts`, and measured for what a reader needs of it — nothing pushed sideways, and
 *  every figure of every row drawn whole, inside its row. */
import { act, fireEvent, render } from "@testing-library/react";

import { Page } from "../Page";
import type { Account } from "../shared/api";
import { ACCOUNT, EMPTY, NO_RATE, PAPER, REFUSALS, serveAccount, TWO_CURRENCIES } from "./account";

/** as the book's layout suites wait (`__browser__/nextBook.ts`): long enough for the read to land */
const settle = () => new Promise((r) => setTimeout(r, 250));

/** TWO_CURRENCIES a thousand times over, for wide figures. */
const scaled = (n: number | null) => (n === null ? null : n * 1_000);
export const LARGE: Account = {
  ...TWO_CURRENCIES,
  totals: {
    net_liquidation: scaled(TWO_CURRENCIES.totals.net_liquidation), total_cash: scaled(TWO_CURRENCIES.totals.total_cash),
    unrealized_pnl: scaled(TWO_CURRENCIES.totals.unrealized_pnl), realized_pnl: scaled(TWO_CURRENCIES.totals.realized_pnl),
    daily_pnl: null,
  },
  stocks: TWO_CURRENCIES.stocks.map((s) => ({
    ...s, position: scaled(s.position), market_value: scaled(s.market_value), unrealized_pnl: scaled(s.unrealized_pnl),
  })),
  options: TWO_CURRENCIES.options.map((o) => ({
    ...o, position: scaled(o.position), market_value: scaled(o.market_value), unrealized_pnl: scaled(o.unrealized_pnl),
  })),
  other: TWO_CURRENCIES.other.map((o) => ({ ...o, market_value: scaled(o.market_value) })),
};

/** Every state the page draws an answer in, by name. */
export const STATES = {
  loaded: ACCOUNT,
  paper: PAPER,
  empty: EMPTY,
  "two currencies": TWO_CURRENCIES,
  "no rate": NO_RATE,
  large: LARGE,
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

/** The variants beside the states: privacy on, and a failed refresh after a good read. */
export const VARIANTS = {
  "privacy on": () => showAccount(TWO_CURRENCIES, { privacy: true }),
  "failed refresh after a good read": () => showAccount(TWO_CURRENCIES, { thenFails: REFUSALS.notAnswering }),
} as const;

/** Every figure, currency and lead of every row that is not drawn whole inside its place: cut by its
 *  own box, or reaching past the sides of its row, or of its own cell or label-and-figure pair — where
 *  it would be drawn over its neighbour's figure while still inside the row. */
export function cutShort(): string[] {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-holding]")];
  return rows.flatMap((row) => {
    return [...row.querySelectorAll<HTMLElement>("[data-fig], [data-currency], .nx-acct-lead, th")].flatMap((el) => {
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
