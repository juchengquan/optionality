/** Out of New York's session the service values a holding from its latest close (#380), and the page
 *  says which close: the market-closed line names it on New York's clock — "market closed — as of the
 *  close, Fri 13 Nov 16:14", the bot's words for it — and a Level chip says only that it is that
 *  close, so the two state one clock between them (#354). A watched price rule has no close to fall
 *  back on: out of hours it keeps its dash, with the sweep's last reading IN the session beside it
 *  (F8) — and never a reading from outside it, which before #380 could be a 0 from a bid 0 / ask 0.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ClosedLine } from "../ClosedLine";
import { closeLineWords, closeWords, levelWords } from "../levels";
import { lastKnown, withLastKnown } from "../lastknown";
import { sentence } from "../needs";
import { newYorkWhen } from "../session";
import type { Entry, Monitor } from "../shared/api";
import { holding } from "../testing/ownerBook";

afterEach(cleanup);

const legs = [{ side: "short" as const, option_type: "PUT" as const, strike: 7000 }];
/** Friday's close, observed at 16:14:59 New York — 05:14:59 on Saturday in DISPLAY_TZ (+08:00) */
const fromClose = (id: string, over: Parameters<typeof holding>[1] | object = {}) => holding(id, {
  strike_date: "2026-12-31", legs, fetched_at: "2026-11-14 05:14:59+08:00",
  valued_from: "close", valued_on: "2026-11-13", valued_timing: "close", ...over,
});
const live = (id: string) => holding(id, { strike_date: "2026-12-31", legs, fetched_at: "2026-11-14 21:00:00+08:00" });

describe("naming the close", () => {
  it("reads a served stamp on New York's clock, date always", () => {
    expect(newYorkWhen("2026-11-14 05:14:59+08:00")).toBe("Fri 13 Nov 16:14");
    expect(newYorkWhen("2026-09-30 20:14:00Z")).toBe("Wed 30 Sep 16:14");
    expect(newYorkWhen("2026-11-14 05:14:59")).toBeNull(); // no zone, no instant
  });

  it("says a close as a close, and anything else by its timing", () => {
    expect(closeWords(fromClose("a"))).toBe("as of the close, Fri 13 Nov 16:14");
    expect(closeWords(fromClose("a", { valued_timing: "after-close", fetched_at: "2026-11-14 09:30:00+08:00" })))
      .toBe("as of Fri 13 Nov 20:30, after the close");
    expect(closeWords(fromClose("a", { valued_timing: "unrecorded", fetched_at: null })))
      .toBe("as of Fri 13 Nov, at a time not recorded");
  });

  it("is the line's words where any holding is valued from a close, the bot's word for word", () => {
    expect(closeLineWords([fromClose("a"), fromClose("b")])).toBe("market closed — as of the close, Fri 13 Nov 16:14");
    expect(closeLineWords([fromClose("a"), live("b")]))
      .toBe("market closed — as of the close, Fri 13 Nov 16:14; 1 with no close, valued live");
    expect(closeLineWords([fromClose("a"), fromClose("b", { valued_timing: "after-close", fetched_at: "2026-11-14 09:30:00+08:00" })]))
      .toBe("market closed — as of the close, Fri 13 Nov 16:14; 1 as of another reading");
    // every holding valued live: the line says when, as it did
    expect(closeLineWords([live("a")])).toBeNull();
    expect(closeLineWords(null)).toBeNull();
  });

  it("draws the line with the close, and the time it was valued at where nothing is from one", () => {
    render(<ClosedLine at="05:14:59" served="2026-11-14 05:14:59+08:00" holdings={[fromClose("a")]} className="x" />);
    expect(screen.getByText("market closed — as of the close, Fri 13 Nov 16:14")).toBeTruthy();
    cleanup();
    render(<ClosedLine at="21:00:00" holdings={[live("a")]} className="x" />);
    expect(screen.getByText("market closed — valued at 21:00")).toBeTruthy();
  });

  it("puts no time on a chip from a close: the line says it, on New York's clock", () => {
    expect(levelWords("stop", fromClose("a"), false)).toBe("at stop · as of the close");
    expect(levelWords("stop", fromClose("a", { valued_timing: "after-close" }), false)).toBe("at stop · as of the last reading");
    // in the session no chip carries a time, however it was valued
    expect(levelWords("stop", fromClose("a"), true)).toBe("at stop");
  });
});

describe("a watched rule out of hours (F8)", () => {
  const rule = {
    id: "w1", code: "1218_7150P", strike_date: "2026-12-18", option_type: "CMB", field: "mid_price",
    threshold: 6.01, direction: "above", compare: "abs", triggered: false, quote: null,
    legs: [{ sign: -1, option_type: "PUT", strike: 7150 }, { sign: 1, option_type: "PUT", strike: 7100 }],
    combo_value: null, combo_greeks: {}, dte: 34, scope: null, positions: [], cost_to_close: null,
    entry: null, pnl: null, fill: null, schedule: null, watched: null, distance: null, in_combos: [],
    held: false,
  } as unknown as Entry;
  const stored = (last_value: number | null, last_checked_at: string | null) =>
    ({ id: "w1", last_value, last_checked_at }) as unknown as Monitor;
  /** read at 16:14:59 New York on Friday: in the session */
  const FRIDAY_CLOSE = "2026-11-14 05:14:59+08:00";

  it("says the sweep's last reading in the session, with its time, beside the dash", () => {
    const [e] = withLastKnown([rule], [stored(3.05, FRIDAY_CLOSE)], false);
    expect(e!.last_reading).toEqual({ value: 3.05, at: FRIDAY_CLOSE });
    expect(sentence(e!)).toMatch(/^\|spread value\| ≥ 6\.01 — no figure out of session; last 3\.05 at (Sat 05:14|14 Nov 05:14)$/);
  });

  it("never presents a reading taken out of the session — the 0 a bid 0 / ask 0 once stored", () => {
    // what three live price rules hold until the first sweep in the session: 0.0 read at 01:47
    // New York on a Saturday
    expect(lastKnown(rule, stored(0, "2026-11-14 14:47:28+08:00"), false)).toBeNull();
    const [e] = withLastKnown([rule], [stored(0, "2026-11-14 14:47:28+08:00")], false);
    expect(sentence(e!)).toBe("|spread value| ≥ 6.01 — no figure");
  });

  it("adds nothing in the session, to a row with its own figure, or where nothing was read", () => {
    expect(lastKnown(rule, stored(3.05, FRIDAY_CLOSE), true)).toBeNull();
    expect(lastKnown({ ...rule, watched: 2 } as Entry, stored(3.05, FRIDAY_CLOSE), false)).toBeNull();
    expect(lastKnown(rule, stored(null, null), false)).toBeNull();
    expect(lastKnown(rule, undefined, false)).toBeNull();
  });
});
