/** The watchlist's value cell (#400): always the spread's PRICE — a delta rule's figure is the Δ
 *  column's and its sentence's, never this one's — and out of New York's session the last price read
 *  IN it, with its time on New York's clock: "−4.12 (Fri 16:14 ET)", or a dash where there is none.
 *  On the desk, the phone, the picture and its Markdown alike, so the screen and the picture agree.
 *  In the session nothing changes but that a delta rule's figure is no longer called a value.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BookProps } from "../Book";
import { DeskBook } from "../desk/DeskBook";
import { lastPriceWords, withLastKnown } from "../lastknown";
import { PhoneBook } from "../phone/PhoneBook";
import type { Entry, Holding, Monitor } from "../shared/api";
import { plainView, toMarkdown } from "../snapshot/plain";
import { call, entry, holding, monitor, side } from "../testing/ownerBook";
import { readMarkdown } from "../testing/plainRead";

/** Sunday 20261115 2026, 12:00 New York: the clock a reading's age is told by. */
const SUNDAY = new Date("2026-11-15T17:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SUNDAY);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Legs = { sign: number; option_type: string; strike: number; qty?: number }[];
const put = (short: number, long: number, longQty?: number): Legs => [
  { sign: -1, option_type: "PUT", strike: short },
  { sign: 1, option_type: "PUT", strike: long, ...(longQty ? { qty: longQty } : {}) },
];
const flipped = (short: number, long: number): Legs => put(short, long).map((l) => ({ ...l, sign: -l.sign }));

/** Read at 16:14:59 New York on Friday 20261113 — in the session; 05:14 on Saturday in DISPLAY_TZ. */
const FRIDAY_CLOSE = "2026-11-14 05:14:59+08:00";
/** Read at 16:14:59 New York on Friday 20261106: in a session, but nine days before Sunday. */
const LAST_WEEK = "2026-11-07 05:14:59+08:00";
/** Read at 01:47 New York on Saturday: the 0 a bid 0 / ask 0 once stored, out of the session. */
const SATURDAY_NIGHT = "2026-11-14 14:47:28+08:00";

/** One watched row: what `/quotes` serves for it in the session and out of it, and its stored
 *  reading in `/monitors`. A price rule has no price out of hours; a greek is served at every hour. */
interface Row {
  id: string; code: string; strike_date: string; legs: Legs; field?: string;
  /** the served figure: a price rule's price, a delta rule's delta — null out of hours for a price */
  live: number; quietOut?: boolean;
  last: [number, string] | null;
  held?: boolean; positions?: { id: string; name: string }[];
}

const ROWS: Row[] = [
  // a delta rule on 1218_P7150 listed BEFORE its price rule, with no figure out of hours and a stored
  // reading of its own taken in the session: only a price rule's reading may lend a value
  { id: "w-delta-quiet", code: "1218_P7150 Δq", strike_date: "2026-12-18", legs: put(7150, 7100), field: "option_delta",
    live: -0.18, quietOut: true, last: [-0.21, FRIDAY_CLOSE] },
  // a spread watched on its price
  { id: "w-price", code: "1218_P7150", strike_date: "2026-12-18", legs: put(7150, 7100), live: -2.4, last: [-4.12, FRIDAY_CLOSE] },
  // the same spread watched on its delta: `combo_value` is its DELTA, served at every hour
  { id: "w-delta", code: "1218_P7150 Δ", strike_date: "2026-12-18", legs: put(7150, 7100), field: "option_delta",
    live: -0.17, last: [-0.17, SATURDAY_NIGHT] },
  // a spread watched on its delta alone: no price rule on it, so no price anywhere
  { id: "w-delta-only", code: "1231_C7600", strike_date: "2026-12-31", legs: call(7600, 7650) as Legs, field: "option_delta",
    live: 0.06, last: [0.06, FRIDAY_CLOSE] },
  // a price rule whose only stored reading was taken out of the session
  { id: "w-zero", code: "1204_P6900", strike_date: "2026-12-04", legs: put(6900, 6850), live: -1.1, last: [0, SATURDAY_NIGHT] },
  // a price rule last read in a session nine days ago: said with its date
  { id: "w-old", code: "1204_P6800", strike_date: "2026-12-04", legs: put(6800, 6750), live: -0.9, last: [-0.85, LAST_WEEK] },
  // a delta rule whose strikes three price rules share — none of them on the SAME contracts: a 1×2
  // ratio, the legs under the other sign, and another expiry. Each lends it nothing
  { id: "w-key", code: "1211_P6000 Δ", strike_date: "2026-12-11", legs: put(6000, 5950), field: "option_delta",
    live: -0.1, last: null },
  { id: "w-ratio", code: "1211_P6000 1x2", strike_date: "2026-12-11", legs: put(6000, 5950, 2), live: 1.2, last: [1.3, FRIDAY_CLOSE] },
  { id: "w-flip", code: "1211_P6000 flip", strike_date: "2026-12-11", legs: flipped(6000, 5950), live: 3, last: [3.1, FRIDAY_CLOSE] },
  { id: "w-later", code: "1218_P6000", strike_date: "2026-12-18", legs: put(6000, 5950), live: -2.9, last: [-2.8, FRIDAY_CLOSE] },
  // a combo drawn in the watchlist because it only PARTLY overlaps a holding (#346): held, and a watchlist row
  { id: "w-over", code: "1231_P6500x", strike_date: "2026-12-31", legs: put(6500, 6400), live: -1.5, last: [-3.3, FRIDAY_CLOSE],
    held: true, positions: [{ id: "h-6500", name: "1231_P6500" }] },
];

const HOLDING: Holding = holding("h-6500", { name: "1231_P6500", strike_date: "2026-12-31",
  legs: [side("short", "PUT", 6500), side("long", "PUT", 6450)] });

/** What each row's value cell says, out of the session and in it. */
const EXPECT: Record<string, [string, string]> = {
  "w-delta-quiet": ["−4.12 (Fri 16:14 ET)", "−2.40"],
  "w-price": ["−4.12 (Fri 16:14 ET)", "−2.40"],
  "w-delta": ["−4.12 (Fri 16:14 ET)", "−2.40"],
  "w-delta-only": ["—", "—"],
  "w-zero": ["—", "−1.10"],
  "w-old": ["−0.85 (Fri 20261106 16:14 ET)", "−0.90"],
  "w-key": ["—", "—"],
  "w-ratio": ["1.30 (Fri 16:14 ET)", "1.20"],
  "w-flip": ["3.10 (Fri 16:14 ET)", "3.00"],
  "w-later": ["−2.80 (Fri 16:14 ET)", "−2.90"],
  "w-over": ["−3.30 (Fri 16:14 ET)", "−1.50"],
};
const IDS = ROWS.map((r) => r.id);
const expected = (session: boolean) => IDS.map((id) => EXPECT[id]![session ? 1 : 0]);

function quotes(session: boolean): Entry[] {
  return ROWS.map((r) => {
    const price = (r.field ?? "mid_price") === "mid_price";
    const figure = session || !(price || r.quietOut) ? r.live : null;
    return entry(r.id, {
      code: r.code, strike_date: r.strike_date, legs: r.legs as never, field: r.field ?? "mid_price",
      threshold: price ? 6 : 0.3, combo_value: figure, watched: figure, distance: figure === null ? null : 1,
      fill: figure === null ? null : 40, combo_greeks: { option_delta: price ? null : figure },
      held: r.held ?? false, positions: r.positions ?? [],
    });
  });
}

const MONITORS: Monitor[] = ROWS.map((r) => monitor(r.id, {
  code: r.code, strike_date: r.strike_date, field: r.field ?? "mid_price", legs: r.legs as never,
  last_value: r.last?.[0] ?? null, last_checked_at: r.last?.[1] ?? null, positions: r.positions ?? [],
}));

/** The rows as the page holds them: through `withLastKnown`, as `Next.tsx` passes them on. */
const page = (session: boolean) => withLastKnown(quotes(session), MONITORS, session ? "live" : "close");

function props(session: boolean): BookProps {
  return {
    quotes: page(session), monitors: MONITORS, holdings: [HOLDING], holdingsError: null, holdingsAt: "23:14:05",
    session, privacy: false, entryStyle: "opportunity",
  };
}

const deskValue = (id: string) => document.querySelector(`.nxd-row[data-ref="${id}"] [data-col="value"] .nxd-v`)?.textContent;
const phoneValue = (id: string) => document.querySelector(`article[data-ref="${id}"] [data-value] dd`)?.textContent ?? null;

it("draws the partly overlapping combo as a watched spread, not under the holding, so the cases below reach it there", () => {
  render(<DeskBook {...props(false)} />);
  const row = document.querySelector<HTMLElement>('.nxd-row[data-ref="w-over"]')!;
  expect(row.dataset.nested).toBeUndefined();
  expect(row.closest("[data-bracket]")).toBeNull();
  expect(document.querySelector('.nxd-row[data-kind="holding"]')!.closest("li")!.contains(row)).toBe(false);
});

describe("on the desk", () => {
  it("out of the session, says each watched row's last price read in it, with its New York time, or a dash", () => {
    render(<DeskBook {...props(false)} />);
    expect(IDS.map(deskValue)).toEqual(expected(false));
  });

  it("in the session, the live price — a delta rule's spread by its price rule's, and never its delta", () => {
    render(<DeskBook {...props(true)} />);
    expect(IDS.map(deskValue)).toEqual(expected(true));
    // the delta is still said, where a delta belongs
    expect(document.querySelector('.nxd-row[data-ref="w-delta-only"] [data-col="delta"] .nxd-v')?.textContent).toBe("0.060");
  });
});

describe("on the phone", () => {
  // each watched card says its value as its desk row does, at every hour (part K)
  it("out of the session, says each watched card's last price, as the desk's row does", () => {
    render(<div className="nx"><PhoneBook {...props(false)} /></div>);
    expect(IDS.map(phoneValue)).toEqual(expected(false));
  });

  it("in the session, its live price, as the desk's row does", () => {
    render(<div className="nx"><PhoneBook {...props(true)} /></div>);
    expect(IDS.map(phoneValue)).toEqual(expected(true));
  });
});

describe("in the detail, as in the row (review of #420)", () => {
  /** The value a detail's figures say, by their first figure: the value of a watched row. */
  const detailValue = (root: Element) => root.querySelector(".nx-figures div:first-child dd")?.textContent ?? null;

  it("out of the session, says each watched row's last price in the inspector and the sheet, as its row and card do", async () => {
    render(<DeskBook {...props(false)} />);
    const rows = IDS.filter((id) => document.querySelector(`.nxd-row[data-ref="${id}"] .nxd-name`));
    const inspector: (string | null)[] = [];
    for (const id of rows) {
      const name = document.querySelector<HTMLButtonElement>(`.nxd-row[data-ref="${id}"] .nxd-name`)!;
      fireEvent.click(name);
      inspector.push(detailValue(screen.getByRole("complementary", { name: `inspector: ${name.textContent}` })));
    }
    expect(inspector).toEqual(rows.map((id) => EXPECT[id]![0]));
    cleanup();
    render(<div className="nx"><PhoneBook {...props(false)} /></div>);
    const sheet: (string | null)[] = [];
    const cards = rows.filter((id) => document.querySelector(`article[data-ref="${id}"]`));
    expect(cards.length).toBeGreaterThan(2);
    for (const id of cards) {
      fireEvent.click(within(document.querySelector<HTMLElement>(`article[data-ref="${id}"]`)!).getByRole("button", { name: /^details of / }));
      sheet.push(detailValue(await screen.findByRole("dialog")));
      act(() => { window.history.back(); });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    expect(sheet).toEqual(cards.map((id) => EXPECT[id]![0]));
  });
});

describe("in the picture and its Markdown", () => {
  const values = (session: boolean) => {
    const view = plainView({
      quotes: page(session), monitors: MONITORS, holdings: [HOLDING], holdingsError: null, holdingsAt: null,
      session, privacy: false, needs: [], health: null, polledAt: null, error: null, references: [],
      hidden: new Set(), takenAt: session ? new Date("2026-11-16T15:00:00Z") : SUNDAY,
    });
    const rows = readMarkdown(toMarkdown(view)).sections.find((s) => s.title === "Book")!.rows;
    const at = rows[0]!.indexOf("value");
    // the text writes a figure's minus as the hyphen (MARKDOWN_FIGURE_MINUS); the page, the true one
    return IDS.map((id) => rows.find((r) => r[0] === ROWS.find((x) => x.id === id)!.code)?.[at]?.replace(/^-/, "\u2212"));
  };

  it("says what the page says, out of the session and in it", () => {
    expect(values(false)).toEqual(expected(false));
    expect(values(true)).toEqual(expected(true));
  });
});

describe("a last price's time", () => {
  it("is a weekday within six days, and a date before that, on New York's clock", () => {
    expect(lastPriceWords({ value: -4.12, at: FRIDAY_CLOSE })).toBe("−4.12 (Fri 16:14 ET)");
    expect(lastPriceWords({ value: -0.85, at: LAST_WEEK })).toBe("−0.85 (Fri 20261106 16:14 ET)");
    expect(lastPriceWords(null)).toBe("—");
  });
});

describe("the last close the service stored (#402)", () => {
  const close = { price: -3.85, observed_on: "2026-11-13", observed_at: FRIDAY_CLOSE, timing: "close" as const };
  const priceRule = entry("w-p", { code: "1218_P7150", strike_date: "2026-12-18", legs: put(7150, 7100),
    watched: null, combo_value: null, last_close: close });
  const deltaRule = entry("w-d", { code: "1218_P7150", strike_date: "2026-12-18", legs: put(7150, 7100),
    field: "option_delta", watched: -0.12, combo_value: -0.12, last_close: close });

  it("is what the value cell says out of the session, before the sweep's last reading", () => {
    const m = monitor("w-p", { last_value: -2.5, last_checked_at: FRIDAY_CLOSE });
    const [p] = withLastKnown([priceRule], [m], "close");
    expect(lastPriceWords(p!.last_price!)).toBe("−3.85 (Fri 16:14 ET)");
  });

  it("gives a spread watched only on its delta a price out of the session", () => {
    const [d] = withLastKnown([deltaRule], [], "close");
    expect(lastPriceWords(d!.last_price!)).toBe("−3.85 (Fri 16:14 ET)");
  });

  it("changes nothing in the session", () => {
    const [p] = withLastKnown([priceRule], [], "live");
    expect(p!.last_price).toBeUndefined();
  });

  it("in the Curb and GTH says the live price where the poll has one, and the last close where not (#416)", () => {
    const [p] = withLastKnown([{ ...priceRule, combo_value: -3.6, watched: -3.6 }], [], "live-or-close");
    expect(p!.price).toBe(-3.6);
    expect(p!.last_price).toBeUndefined();
    const [q] = withLastKnown([priceRule], [], "live-or-close");
    expect(q!.price).toBeNull();
    expect(lastPriceWords(q!.last_price!)).toBe("−3.85 (Fri 16:14 ET)");
  });
});
