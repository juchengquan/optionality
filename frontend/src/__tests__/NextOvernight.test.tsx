/** SPX options' overnight session, GTH, and the Curb (#416): the page polls as in session, a holding
 *  is valued live where every leg is quoted and from its close where not, and the page says which
 *  session it is — "overnight session — live quotes, thin", never "market closed". SPX outside the
 *  regular session is the last close's level, and is said so beside its price, never as current.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ClosedLine } from "../ClosedLine";
import { StrikeStrip } from "../StrikeStrip";
import { closedLineText, levelWords, thinLineWords } from "../levels";
import { spxOfBook, spxWords } from "../pricemap";
import { spxStripWords, type Strip } from "../strip";
import { holding } from "../testing/ownerBook";

afterEach(cleanup);

const legs = [{ side: "short" as const, option_type: "PUT" as const, strike: 7000 }];
/** valued live at Sunday 20:30 New York — 09:30 on Monday in DISPLAY_TZ (+08:00): GTH */
const overnight = (id: string) => holding(id, {
  strike_date: "2026-12-31", legs, fetched_at: "2026-11-16 09:30:00+08:00", valued_from: "live",
  spx: 7561.68, spx_reason: "index not computed overnight — the last close's level",
});
/** a leg unquoted overnight: valued from Friday's close, at 16:14:59 New York */
const fromClose = (id: string) => holding(id, {
  strike_date: "2026-12-31", legs, fetched_at: "2026-11-14 05:14:59+08:00",
  valued_from: "close", valued_on: "2026-11-13", valued_timing: "close",
});
/** valued live in the regular session, Monday 11:00 New York */
const inSession = (id: string) => holding(id, {
  strike_date: "2026-12-31", legs, fetched_at: "2026-11-17 00:00:00+08:00", valued_from: "live",
});

describe("the session line in the Curb and GTH", () => {
  it("says the quotes are live and thin, never that the market is closed", () => {
    expect(thinLineWords([overnight("a")], "overnight")).toBe("overnight session — live quotes, thin");
    expect(thinLineWords([overnight("a")], "curb")).toBe("Curb — live quotes, thin");
  });

  it("names how many were valued from a close for want of a quote, and which close", () => {
    expect(thinLineWords([overnight("a"), fromClose("b")], "overnight"))
      .toBe("overnight session — live quotes, thin; 1 not quoted, as of the close, Fri 13 Nov 16:14");
  });

  it("says where the Provider could not be asked", () => {
    const unasked = { ...overnight("a"), cost_to_close: null, valued_reason: "moomoo call failed: down" };
    expect(thinLineWords([unasked], "overnight"))
      .toBe("overnight session — live quotes, thin; the Provider could not be asked");
  });

  it("says it where the Provider was down for a holding valued from its close for want of a quote", () => {
    // every holding is asked overnight: the close-valued one carries the failure too (#416 review)
    const down = { ...fromClose("b"), valued_reason: "moomoo call failed: connect ECONNREFUSED" };
    expect(thinLineWords([down], "overnight")).toBe(
      "overnight session — live quotes, thin; 1 not quoted, as of the close, Fri 13 Nov 16:14; the Provider could not be asked");
  });

  it("is the line's words by the phase, and the market-closed words while nothing trades", () => {
    expect(closedLineText("09:30", null, [overnight("a")], new Date(), "overnight"))
      .toBe("overnight session — live quotes, thin");
    expect(closedLineText("09:30", null, [overnight("a")], new Date(), "closed")).toBe("market closed — valued at 09:30");
    render(<ClosedLine at="09:30" holdings={[overnight("a")]} phase="overnight" className="x" />);
    expect(screen.getByText("overnight session — live quotes, thin")).toBeTruthy();
  });
});

describe("a Level chip polled in the Curb and GTH (#416)", () => {
  it("says when a live valuation from thin quotes was made", () => {
    expect(levelWords("stop", overnight("a"), true)).toBe("at stop · live at 09:30");
  });

  it("says a close is the close, and is bare in the regular session", () => {
    expect(levelWords("stop", fromClose("a"), true)).toBe("at stop · as of the close");
    expect(levelWords("stop", inSession("a"), true)).toBe("at stop");
  });
});

describe("SPX outside the regular session is said stale beside its price (#416)", () => {
  const strip: Strip = {
    shorts: [{ code: "US.SPXW261231P7000000", option_type: "PUT", strike: 7000, delta: -0.1, points: 561.68, sigma: 1.5, one_sigma: 374 }],
    longs: [], spx: 7561.68, reason: "index not computed overnight — the last close's level",
  };

  it("on the strike strip, in words and as a hollow dot", () => {
    expect(spxStripWords(strip)).toBe("SPX 7561.68 (index not computed overnight — the last close's level)");
    expect(spxStripWords({ ...strip, reason: null })).toBe("SPX 7561.68");
    expect(spxStripWords({ ...strip, spx: null, reason: "no premium" })).toBe("SPX — no premium");
    const { container } = render(<StrikeStrip strip={strip} />);
    expect(container.querySelector(".nxs-spx[data-stale]")).toBeTruthy();
    expect(container.querySelector(".nxs-spx-words")?.textContent).toContain("the last close's level");
  });

  it("on the price map's line from a holding's close, never as a batch's (#416 review)", () => {
    const close = { ...fromClose("b"), spx: 7561.69, spx_reason: "the level at the close it is valued from" };
    const line = spxOfBook([], [close]);
    expect(line.source).toBe("close");
    expect(spxWords(line, true)).toBe("SPX 7561.69 (the level at the close it is valued from)");
    // a holding valued live is preferred to one valued from its close
    expect(spxOfBook([], [close, overnight("a")]).source).toBe("holdings");
  });

  it("on the price map's line, from the batch that gave it", () => {
    const line = spxOfBook([], [overnight("a")]);
    expect(line.reason).toBe("index not computed overnight — the last close's level");
    expect(spxWords(line, true)).toMatch(/^SPX 7561\.68 \(index not computed overnight — the last close's level\) · /);
  });
});
