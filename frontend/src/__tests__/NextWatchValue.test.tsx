/** The watchlist's value cell (#400): always the spread's PRICE — a delta rule's figure is the Δ
 *  column's and its sentence's, never this one's — and out of New York's session the last price read
 *  IN it, with its time on New York's clock: "-4.12 (Fri 16:14)", or a dash where there is none.
 *  On the desk, the phone, the picture and its Markdown alike, so the screen and the picture agree.
 *  In the session nothing changes but that a delta rule's figure is no longer called a value.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { BookProps } from "../Book";
import { DeskBook } from "../desk/DeskBook";
import { withLastKnown } from "../lastknown";
import { PhoneBook } from "../phone/PhoneBook";
import type { Entry, Monitor } from "../shared/api";
import { plainView, toMarkdown } from "../snapshot/plain";
import { call, entry, monitor } from "../testing/ownerBook";
import { readMarkdown } from "../testing/plainRead";

afterEach(cleanup);

const put = (short: number, long: number) => [
  { sign: -1, option_type: "PUT", strike: short }, { sign: 1, option_type: "PUT", strike: long },
] as never;

/** Read at 16:14:59 New York on Friday 13 Nov — in the session; 05:14 on Saturday in DISPLAY_TZ. */
const FRIDAY_CLOSE = "2026-11-14 05:14:59+08:00";
/** Read at 01:47 New York on Saturday: the 0 a bid 0 / ask 0 once stored, out of the session. */
const SATURDAY_NIGHT = "2026-11-14 14:47:28+08:00";

/** The watchlist as `/quotes` serves it, in the session (`live`) or out of it, where no option has a
 *  price but a greek is still served. */
function quotes(live: boolean): Entry[] {
  const price = (v: number) => live ? { combo_value: v, watched: v, distance: 6 - Math.abs(v) }
    : { combo_value: null, watched: null, distance: null, fill: null };
  return [
    // a spread watched on its price
    entry("w-price", { code: "1218_P7150", strike_date: "2026-12-18", legs: put(7150, 7100), ...price(-2.4) }),
    // the same spread watched on its delta: `combo_value` is its DELTA, served at every hour
    entry("w-delta", { code: "1218_P7150 Δ", strike_date: "2026-12-18", legs: put(7150, 7100),
      field: "option_delta", threshold: 0.3, combo_value: -0.17, watched: -0.17, distance: 0.13,
      combo_greeks: { option_delta: -0.17 } }),
    // a spread watched on its delta alone: no price rule on it, so no price anywhere
    entry("w-delta-only", { code: "1231_C7600", strike_date: "2026-12-31", legs: call(7600, 7650) as never,
      field: "option_delta", threshold: 0.3, combo_value: 0.06, watched: 0.06, distance: 0.24,
      combo_greeks: { option_delta: 0.06 } }),
    // a price rule whose only stored reading was taken out of the session
    entry("w-zero", { code: "1204_P6900", strike_date: "2026-12-04", legs: put(6900, 6850), ...price(-1.1) }),
  ];
}

const MONITORS: Monitor[] = [
  monitor("w-price", { code: "1218_P7150", field: "mid_price", last_value: -4.12, last_checked_at: FRIDAY_CLOSE }),
  monitor("w-delta", { code: "1218_P7150 Δ", last_value: -0.17, last_checked_at: SATURDAY_NIGHT }),
  monitor("w-delta-only", { code: "1231_C7600", strike_date: "2026-12-31", last_value: 0.06, last_checked_at: FRIDAY_CLOSE }),
  monitor("w-zero", { code: "1204_P6900", strike_date: "2026-12-04", field: "mid_price", last_value: 0, last_checked_at: SATURDAY_NIGHT }),
];

/** The rows as the page holds them: through `withLastKnown`, as `Next.tsx` passes them on. */
const page = (session: boolean) => withLastKnown(quotes(session), MONITORS, session);

const IDS = ["w-price", "w-delta", "w-delta-only", "w-zero"];
const OUT = ["-4.12 (Fri 16:14)", "-4.12 (Fri 16:14)", "—", "—"];
const IN = ["-2.40", "-2.40", "—", "-1.10"];

function props(session: boolean): BookProps {
  return {
    quotes: page(session), monitors: MONITORS, holdings: [], holdingsError: null, holdingsAt: "23:14:05",
    session, privacy: false, entryStyle: "opportunity",
  };
}

const deskValue = (id: string) => document.querySelector(`.nxd-row[data-ref="${id}"] [data-col="value"] .nxd-v`)?.textContent;
const phoneValue = (id: string) => document.querySelector(`article[data-ref="${id}"] [data-value]`)?.textContent ?? null;

describe("on the desk", () => {
  it("out of the session, says each watched row's last price read in it, with its New York time, or a dash", () => {
    render(<DeskBook {...props(false)} />);
    expect(IDS.map(deskValue)).toEqual(OUT);
  });

  it("in the session, the live price — a delta rule's spread by its price rule's, and never its delta", () => {
    render(<DeskBook {...props(true)} />);
    expect(IDS.map(deskValue)).toEqual(IN);
    // the delta is still said, where a delta belongs
    expect(document.querySelector('.nxd-row[data-ref="w-delta-only"] [data-col="delta"] .nxd-v')?.textContent).toBe("0.060");
  });
});

describe("on the phone", () => {
  it("out of the session, adds a value line to each watched card", () => {
    render(<div className="nx"><PhoneBook {...props(false)} /></div>);
    expect(IDS.map(phoneValue)).toEqual(OUT.map((v) => `value ${v}`));
  });

  it("in the session, adds none: nothing changes there", () => {
    render(<div className="nx"><PhoneBook {...props(true)} /></div>);
    expect(IDS.map(phoneValue)).toEqual([null, null, null, null]);
  });
});

describe("in the picture and its Markdown", () => {
  const values = (session: boolean) => {
    const view = plainView({
      quotes: page(session), monitors: MONITORS, holdings: [], holdingsError: null, holdingsAt: null,
      session, privacy: false, needs: [], health: null, polledAt: null, error: null, references: [],
      hidden: new Set(), takenAt: new Date(session ? "2026-11-16T15:00:00Z" : "2026-11-15T17:00:00Z"),
    });
    const rows = readMarkdown(toMarkdown(view)).sections.find((s) => s.title === "Watchlist")!.rows;
    const at = rows[0]!.indexOf("value");
    return Object.fromEntries(rows.filter((r) => IDS.some((id) => quotes(true).find((q) => q.id === id)!.code === r[0]))
      .map((r) => [r[0], r[at]]));
  };
  const byCode = (cells: string[]) => Object.fromEntries(IDS.map((id, i) => [quotes(true).find((q) => q.id === id)!.code, cells[i]]));

  it("says what the page says, out of the session and in it", () => {
    expect(values(false)).toEqual(byCode(OUT));
    expect(values(true)).toEqual(byCode(IN));
  });
});
