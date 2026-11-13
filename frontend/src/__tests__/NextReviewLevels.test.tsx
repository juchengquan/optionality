/** REVIEW's Level chips say when they were valued (#354, the owner's decision (b), ADR 0023).
 *
 *  The needs-you line uses only what is polled (ADR 0012), and REVIEW does not poll the holdings:
 *  it values them once on entering. So in REVIEW the line says nothing of a holding's Levels, while
 *  the holding's own chip, drawn from that one valuation, can still say "at stop". The two must not
 *  read as a disagreement, so the chip says which valuation it is from — "at stop · as valued at
 *  23:04" — on every surface that draws one: the desk's row and inspector, the phone's REVIEW page
 *  and sheet, and the saved picture. LIVE is unchanged: there the line and the chip read the same
 *  poll, and agree.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Arrangement } from "../next/arrangement";
import { charsOf, COLUMNS, type DeskRow } from "../next/desk/columns";
import { levelWords, valuedClock } from "../next/levels";
import { Next } from "../next/Next";
import { Still } from "../next/snapshot/Still";
import type { Holding } from "../shared/api";
import { payoffAnswer, samplesAnswer, volAnswer } from "../testing/ownerBook";
import { until } from "../testing/until";

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};
const spread = {
  id: "w1", code: "1218_7150P", strike_date: "2026-12-18", option_type: "CMB",
  field: "mid_price", threshold: 6.01, direction: "above", compare: "abs", triggered: false,
  quote: null, legs: [{ sign: -1, option_type: "PUT", strike: 7150 }, { sign: 1, option_type: "PUT", strike: 7100 }],
  combo_value: 2, combo_greeks: {}, dte: 38, scope: null, positions: [], cost_to_close: null,
  entry: null, pnl: null, fill: 33, schedule: null, watched: 2, distance: 4.01, in_combos: [],
  held: false,
};
const schedule = {
  dte_at_open: 45, on_pace: 1.23, pace_gap: 0.47, target: 1, stop: 4, target_dte: 11,
  manage_by_dte: 21, reached: null as string | null, manage_by_due: false,
};
/** at its stop by the valuation the service stamped at 23:04:11 in DISPLAY_TZ */
const holding = {
  id: "p1", name: "1231_7000P", strategy: null, strike_date: "2026-12-31", contracts: 1,
  entry: 3, legs: [{ side: "short", option_type: "PUT", strike: 7000 }, { side: "long", option_type: "PUT", strike: 6950 }],
  created_at: null, opened_at: "2026-11-03", closed_on: null, exit: null, realized_points: null,
  cost_to_close: 6.2, pnl: -320, contract_size: 100, greeks: {}, fetched_at: "2026-11-08 23:04:11+08:00",
  dte: 51, schedule: { ...schedule, reached: "stop" }, captured: -1.07, spx: null, spx_reason: null,
  short_strikes: [], legs_delta: null,
};
/** past its manage-by, by the same valuation */
const due = {
  ...holding, id: "p2", name: "1204_6900P", strike_date: "2026-12-04",
  legs: [{ side: "short", option_type: "PUT", strike: 6900 }, { side: "long", option_type: "PUT", strike: 6850 }],
  cost_to_close: 1.5, pnl: 150, dte: 19, schedule: { ...schedule, manage_by_due: true }, captured: 0.5,
};

let holdings: object[] = [holding, due];
let quotes: object[] = [spread];
/** the time the fake service stamps on each valuation it serves, in DISPLAY_TZ (+08:00) — never
 *  the zone this suite runs in (TZ=UTC), so a note drawn from the device's clock would differ */
let stamp = "2026-11-08 23:04:11+08:00";
const valued = () => holdings.map((h) => ({ ...h, fetched_at: stamp }));

/** A rule on the whole of p1, linked to it: `/quotes` serves it the holding's schedule
 *  (`schedule.position_id`), and REVIEW still polls `/quotes`. */
const linked = (over: object = {}) => ({
  ...spread, id: "r1", code: "1231_7000P", strike_date: "2026-12-31", field: "mid_price", threshold: 6,
  legs: [{ sign: -1, option_type: "PUT", strike: 7000 }, { sign: 1, option_type: "PUT", strike: 6950 }],
  positions: [{ id: "p1", name: "1231_7000P" }], scope: "all", held: true, watched: 6.2, distance: -0.2,
  schedule: { ...schedule, reached: "stop", position_id: "p1" }, ...over,
});

function serve() {
  holdings = [holding, due];
  quotes = [spread];
  stamp = "2026-11-08 23:04:11+08:00";
  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    // what a holding's detail reads once it is opened — its payoff, samples and pace split — as
    // the owner-shaped book's put spread has them
    const own = path.replace(/^\/positions\/p[12]\//, "/positions/h-puts/");
    const read = payoffAnswer(own) ?? samplesAnswer(own) ?? volAnswer(own);
    const body = read ? read : init?.method && init.method !== "GET" ? {}
      : path === "/quotes" ? quotes
        : path === "/monitors" ? []
          : path === "/health" ? health
            : path === "/references" ? []
              : path === "/positions/values" ? valued()
                : path === "/positions" ? holdings : null;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

/** A Monday in the session, or a Sunday: the clock picks the mode. */
function at(iso: string) {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: new Date(iso) });
}
const SESSION = "2026-11-09T15:00:00Z";
const SUNDAY = "2026-11-08T15:00:00Z";

async function open(arrangement: Arrangement, now: string, chip = true) {
  document.cookie = `ui_arrangement=${arrangement};path=/`;
  at(now);
  render(<Next />);
  await until(() => expect(document.querySelector(chip ? '[data-ref="p1"] .nx-chip' : '[data-ref="p1"]')).toBeTruthy());
}

/** what the line says, or "" where nothing needs you and it is not drawn */
const line = () => screen.queryByRole("status", { name: "needs you" })?.textContent ?? "";
const chipIn = (root: ParentNode, ref: string) =>
  root.querySelector(`[data-ref="${ref}"] .nx-chip`)?.textContent ?? null;

beforeEach(serve);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.cookie = "ui_arrangement=;path=/;max-age=0";
});

describe("the words", () => {
  it("reads the clock the service wrote on the valuation, to the minute", () => {
    expect(valuedClock("2026-11-12 21:04:37+08:00")).toBe("21:04");
    expect(valuedClock("2026-11-12T09:30:00-05:00")).toBe("09:30");
    // a stamp that says no time is not given one
    expect(valuedClock("x")).toBeNull();
    expect(valuedClock(null)).toBeNull();
  });

  it("adds the valuation's time to a Level in REVIEW, and nothing in LIVE", () => {
    const h = holding as unknown as Holding;
    expect(levelWords("stop", h, "review")).toBe("at stop · as valued at 23:04");
    expect(levelWords("target", h, "review")).toBe("at target · as valued at 23:04");
    expect(levelWords("manage", h, "review")).toBe("manage-by · as valued at 23:04");
    expect(levelWords("stop", h, "live")).toBe("at stop");
    // still marked as not live where the service gave no time
    expect(levelWords("stop", { ...h, fetched_at: null }, "review")).toBe("at stop · as last valued");
  });

  it("is what the desk's fitting counts, so the longer chip is measured", () => {
    const name = COLUMNS.review.find((c) => c.key === "name")!;
    const rows: DeskRow[] = [{ kind: "holding", holding: holding as unknown as Holding, rules: [] }];
    expect(charsOf(name, rows, false, "review") - charsOf(name, rows, false, "live"))
      .toBe(" · as valued at 23:04".length);
  });
});

describe("in REVIEW, a holding's chip and the needs-you line never contradict each other", () => {
  it("on the desk: the row and the inspector say which valuation, and the line says nothing of it", async () => {
    await open("desk", SUNDAY);
    expect(document.querySelector(".nx")!.getAttribute("data-mode")).toBe("review");
    const row = document.querySelector('.nxd-row[data-ref="p1"]')!;
    expect(chipIn(document, "p1")).toBe("at stop · as valued at 23:04");
    expect(chipIn(document, "p2")).toBe("manage-by · as valued at 23:04");
    // the line names neither holding: it leaves their Levels out in REVIEW, as it always has
    expect(line()).not.toContain("1231_7000P");
    expect(line()).not.toContain("1204_6900P");

    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "1231_7000P" }));
    const inspector = await screen.findByRole("complementary", { name: "inspector: 1231_7000P" });
    expect(inspector.querySelector(".nx-chip")?.textContent).toBe("at stop · as valued at 23:04");
  });

  it("on the phone: the REVIEW page and the sheet say which valuation, and the line says nothing of it", async () => {
    await open("phone", SUNDAY);
    const page = document.querySelector<HTMLElement>('[data-page][data-ref="p1"]')!;
    expect(page.querySelector(".nx-chip")?.textContent).toBe("at stop · as valued at 23:04");
    expect(line()).not.toContain("1231_7000P");

    fireEvent.click(within(page).getByRole("button", { name: "detail and Monitors" }));
    const sheet = await screen.findByRole("dialog");
    await until(() => expect(sheet.querySelector(".nx-chip")?.textContent).toBe("at stop · as valued at 23:04"));
  });

  it("in LIVE they read the same poll and agree, so the chip carries no time", async () => {
    await open("desk", SESSION);
    expect(document.querySelector(".nx")!.getAttribute("data-mode")).toBe("live");
    await until(() => expect(line()).toContain("1231_7000P at stop"));
    expect(chipIn(document, "p1")).toBe("at stop");
    expect(line()).toContain("1204_6900P at its manage-by");
    expect(chipIn(document, "p2")).toBe("manage-by");

    // the inspector draws the row's chip, bare as the row's is
    fireEvent.click(within(document.querySelector<HTMLElement>('.nxd-row[data-ref="p1"]')!)
      .getByRole("button", { name: "1231_7000P" }));
    const inspector = await screen.findByRole("complementary", { name: "inspector: 1231_7000P" });
    expect(inspector.querySelector(".nx-chip")?.textContent).toBe("at stop");
  });

  it("in LIVE the phone's card and its sheet carry no time either", async () => {
    await open("phone", SESSION);
    const card = document.querySelector<HTMLElement>('article[data-ref="p1"]')!;
    expect(card.querySelector(".nx-chip")?.textContent).toBe("at stop");
    fireEvent.click(within(card).getByRole("button", { name: "details of 1231_7000P" }));
    const sheet = await screen.findByRole("dialog");
    await until(() => expect(sheet.querySelector(".nx-chip")?.textContent).toBe("at stop"));
  });

  it("still holds after switching from LIVE into REVIEW", async () => {
    await open("desk", SESSION);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review" })); });
    await until(() => expect(chipIn(document, "p1")).toBe("at stop · as valued at 23:04"));
    expect(line()).not.toContain("1231_7000P");
  });
});

describe("in REVIEW a rule linked to a holding does not say the holding's Levels either (#354)", () => {
  it("names no Level the holding's chip already says, and keeps the rule's own alarm", async () => {
    quotes = [spread, linked({ triggered: true })];
    await open("desk", SUNDAY);
    expect(chipIn(document, "p1")).toBe("at stop · as valued at 23:04");
    // the rule rings: that is the rule's, from the poll, and it is said
    await until(() => expect(line()).toContain("1231_7000P ringing"));
    expect(line()).not.toContain("at stop");
  });

  it("names no Level the holding's valuation did not show, so the line never states one the row lacks", async () => {
    // the stop reached since REVIEW valued the holding: the poll's schedule says it, the row cannot
    holdings = [{ ...holding, schedule }, due];
    quotes = [spread, linked()];
    await open("desk", SUNDAY, false);
    expect(chipIn(document, "p1")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(line()).not.toContain("at stop");
    expect(line()).not.toContain("1231_7000P");
  });

  it("while LIVE still says it, from the poll", async () => {
    quotes = [spread, linked()];
    await open("desk", SESSION);
    await until(() => expect(line()).toContain("1231_7000P at stop"));
  });
});

describe("one clock for a valuation", () => {
  it("says when the holdings were valued in the service's zone, as the chip does, whatever the device's", async () => {
    // this suite runs at TZ=UTC: 15:00 here is 23:00 in the service's +08:00
    await open("desk", SUNDAY);
    expect(document.querySelector(".nx-book")!.textContent).toContain("valued at 23:04:11");
    expect(chipIn(document, "p1")).toBe("at stop · as valued at 23:04");
  });

  it("moves the chip's time on when REVIEW values the holdings again", async () => {
    await open("desk", SUNDAY);
    stamp = "2026-11-08 23:09:30+08:00";
    // Settings, opened in REVIEW, values the holdings afresh
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    await until(() => expect(chipIn(document, "p1")).toBe("at stop · as valued at 23:09"));
    expect(screen.getByText("holdings valued at 23:09:30")).toBeTruthy();
  });
});

describe("the saved picture says which valuation, in REVIEW only", () => {
  function picture(arrangement: Arrangement, mode: "live" | "review") {
    render(<Still arrangement={arrangement} quotes={[spread] as never} monitors={[]}
                  holdings={[holding, due] as unknown as Holding[]} holdingsError={null} holdingsAt="23:04:15"
                  mode={mode} privacy={false} entryStyle="opportunity" needs={[]} health={null}
                  polledAt={null} error={null} references={[]} />);
  }

  for (const arrangement of ["desk", "phone"] as Arrangement[]) {
    it(`from the ${arrangement}`, () => {
      picture(arrangement, "review");
      expect(chipIn(document, "p1")).toBe("at stop · as valued at 23:04");
      cleanup();
      picture(arrangement, "live");
      expect(chipIn(document, "p1")).toBe("at stop");
    });
  }
});
