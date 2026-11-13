/** Outside the session the Level chips say when they were valued (#354, the owner's decision (b),
 *  ADR 0023; re-keyed from REVIEW to New York's session by #371 and the amendment of 2026-11-13).
 *
 *  The needs-you line uses only what is polled (ADR 0012), and outside the session the holdings are
 *  not polled: they are valued once. So there the line says nothing of a holding's Levels, while
 *  the holding's own chip, drawn from that one valuation, can still say "at stop". The two must not
 *  read as a disagreement, so the chip says which valuation it is from — "at stop · as valued at
 *  23:04" — on every surface that draws one: the desk's row and inspector, the phone's card, page
 *  and sheet, and the saved picture. In session the line and the chip read the same poll, and
 *  agree, with no time on the chip. WHICHEVER MODE is on screen: the mode decides neither.
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
 *  (`schedule.position_id`), and `/quotes` is polled at every hour. */
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

/** A Monday in the session, a Monday evening after it, or a Sunday. */
function at(iso: string) {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: new Date(iso) });
}
const SESSION = "2026-11-09T15:00:00Z";
const SUNDAY = "2026-11-08T15:00:00Z";
const EVENING = "2026-11-09T23:00:00Z";
/** the valuation's stamp on that evening: Tuesday 06:23 in the service's +08:00, after Monday's
 *  close, so its time alone is right (an older one is dated: `servedWhen`) */
const EVENING_STAMP = "2026-11-10 06:23:11+08:00";
/** the clock a chip states for the default stamp at `now` */
const valuedTime = (now: string) => (now === EVENING ? "06:23" : "23:04");

async function open(arrangement: Arrangement, now: string, chip = true, mode?: "Live" | "Review") {
  document.cookie = `ui_arrangement=${arrangement};path=/`;
  if (now === EVENING && stamp === "2026-11-08 23:04:11+08:00") stamp = EVENING_STAMP;
  at(now);
  render(<Next />);
  if (mode) {
    // the owner's choice, by hand: the desk's switch, the only one since #374
    fireEvent.click(within(screen.getByRole("group", { name: "mode" })).getByRole("button", { name: mode }));
  }
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
  // Sunday 23:00 in the service's +08:00: the stamp is today's, so its time alone is right
  beforeEach(() => at(SUNDAY));

  it("reads the clock the service wrote on the valuation, to the minute", () => {
    expect(valuedClock("2026-11-12 21:04:37+08:00")).toBe("21:04");
    expect(valuedClock("2026-11-12T09:30:00-05:00")).toBe("09:30");
    // a stamp that says no time is not given one
    expect(valuedClock("x")).toBeNull();
    expect(valuedClock(null)).toBeNull();
  });

  it("adds the valuation's time to a Level outside the session, and nothing in it", () => {
    const h = holding as unknown as Holding;
    expect(levelWords("stop", h, false)).toBe("at stop · as valued at 23:04");
    expect(levelWords("target", h, false)).toBe("at target · as valued at 23:04");
    expect(levelWords("manage", h, false)).toBe("manage-by · as valued at 23:04");
    expect(levelWords("stop", h, true)).toBe("at stop");
    // still marked as not live where the service gave no time
    expect(levelWords("stop", { ...h, fetched_at: null }, false)).toBe("at stop · as last valued");
  });

  it("is what the desk's fitting counts, so the longer chip is measured", () => {
    const rows: DeskRow[] = [{ kind: "holding", holding: holding as unknown as Holding, rules: [] }];
    const name = COLUMNS.find((c) => c.key === "name")!;
    expect(charsOf(name, rows, false, false) - charsOf(name, rows, false, true))
      .toBe(" · as valued at 23:04".length);
  });
});

describe("outside the session, a holding's chip and the needs-you line never contradict each other", () => {
  for (const [when, now, mode] of [
    ["on a Sunday", SUNDAY, undefined], ["on an evening with Live picked", EVENING, "Live"],
  ] as const) {
    it(`on the desk ${when}: the row and the inspector say which valuation, and the line says nothing of it`, async () => {
      await open("desk", now, true, mode);
      const t = valuedTime(now);
      expect(chipIn(document, "p1")).toBe(`at stop · as valued at ${t}`);
      expect(chipIn(document, "p2")).toBe(`manage-by · as valued at ${t}`);
      // the line names neither holding: it leaves their Levels out outside the session
      expect(line()).not.toContain("1231_7000P");
      expect(line()).not.toContain("1204_6900P");

      const row = document.querySelector<HTMLElement>('.nxd-row[data-ref="p1"]')!;
      fireEvent.click(within(row).getByRole("button", { name: "1231_7000P" }));
      const inspector = await screen.findByRole("complementary", { name: "inspector: 1231_7000P" });
      expect(inspector.querySelector(".nx-chip")?.textContent).toBe(`at stop · as valued at ${t}`);
      expect(inspector.textContent).toContain("as last valued");
    });
  }

  for (const [when, now] of [["on a Sunday", SUNDAY], ["on an evening", EVENING]] as const) {
    it(`on the phone's card and its sheet ${when}, and the line says nothing of it`, async () => {
      await open("phone", now);
      const t = valuedTime(now);
      const card = document.querySelector<HTMLElement>('article[data-ref="p1"]')!;
      expect(card.querySelector(".nx-chip")?.textContent).toBe(`at stop · as valued at ${t}`);
      expect(line()).not.toContain("1231_7000P");
      fireEvent.click(within(card).getByRole("button", { name: "details of 1231_7000P" }));
      const sheet = await screen.findByRole("dialog");
      await until(() => expect(sheet.querySelector(".nx-chip")?.textContent).toBe(`at stop · as valued at ${t}`));
    });
  }
});

describe("in session they read the same poll and agree, so the chip carries no time", () => {
  for (const mode of [undefined, "Review"] as const) {
    it(`on the desk${mode ? ", with Review picked" : ""}`, async () => {
      await open("desk", SESSION, true, mode);
      await until(() => expect(line()).toContain("1231_7000P at stop"));
      expect(chipIn(document, "p1")).toBe("at stop");
      expect(line()).toContain("1204_6900P at its manage-by");
      expect(chipIn(document, "p2")).toBe("manage-by");

      // the inspector draws the row's chip, bare as the row's is
      fireEvent.click(within(document.querySelector<HTMLElement>('.nxd-row[data-ref="p1"]')!)
        .getByRole("button", { name: "1231_7000P" }));
      const inspector = await screen.findByRole("complementary", { name: "inspector: 1231_7000P" });
      expect(inspector.querySelector(".nx-chip")?.textContent).toBe("at stop");
      expect(inspector.textContent).toContain("live: updates with every poll");
    });
  }

  it("on the phone's card and its sheet", async () => {
    await open("phone", SESSION);
    const card = document.querySelector<HTMLElement>('article[data-ref="p1"]')!;
    expect(card.querySelector(".nx-chip")?.textContent).toBe("at stop");
    fireEvent.click(within(card).getByRole("button", { name: "details of 1231_7000P" }));
    const sheet = await screen.findByRole("dialog");
    await until(() => expect(sheet.querySelector(".nx-chip")?.textContent).toBe("at stop"));
  });

  it("still holds across the close: the chip takes its time as the line lets the Level go", async () => {
    stamp = "2026-11-10 05:15:30+08:00"; // Monday 16:15:30 New York, valued just after the close
    await open("desk", "2026-11-09T21:14:00Z"); // Monday 16:14 New York
    await until(() => expect(line()).toContain("1231_7000P at stop"));
    expect(chipIn(document, "p1")).toBe("at stop");
    vi.setSystemTime(new Date("2026-11-09T21:16:00Z")); // 16:16, the window focused
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await until(() => expect(chipIn(document, "p1")).toBe("at stop · as valued at 05:15"));
    expect(line()).not.toContain("1231_7000P");
  });
});

describe("outside the session a rule linked to a holding does not say the holding's Levels either (#354)", () => {
  it("names no Level the holding's chip already says, and keeps the rule's own alarm", async () => {
    quotes = [spread, linked({ triggered: true })];
    await open("desk", SUNDAY);
    expect(chipIn(document, "p1")).toBe("at stop · as valued at 23:04");
    // the rule rings: that is the rule's, from the poll, and it is said
    await until(() => expect(line()).toContain("1231_7000P ringing"));
    expect(line()).not.toContain("at stop");
  });

  it("names no Level the holding's valuation did not show, so the line never states one the row lacks", async () => {
    // the stop reached since the holdings were valued: the poll's schedule says it, the row cannot
    holdings = [{ ...holding, schedule }, due];
    quotes = [spread, linked()];
    await open("desk", EVENING, false, "Live");
    expect(chipIn(document, "p1")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(line()).not.toContain("at stop");
    expect(line()).not.toContain("1231_7000P");
  });

  it("while in session it says it, from the poll, with Review picked too", async () => {
    quotes = [spread, linked()];
    await open("desk", SESSION, true, "Review");
    await until(() => expect(line()).toContain("1231_7000P at stop"));
  });
});

describe("one clock for a valuation", () => {
  it("says when the holdings were valued in the service's zone, as the chip does, whatever the device's", async () => {
    // this suite runs at TZ=UTC: 15:00 here is 23:00 in the service's +08:00
    await open("desk", SUNDAY);
    expect(document.querySelector(".nx-mkt-closed")!.textContent).toContain("market closed — valued at 23:04");
    expect(chipIn(document, "p1")).toBe("at stop · as valued at 23:04");
  });

  it("moves the chip's time on when the holdings are valued again outside the session", async () => {
    await open("desk", SUNDAY);
    stamp = "2026-11-08 23:09:30+08:00";
    // Settings, opened outside the session, values the holdings afresh
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    await until(() => expect(chipIn(document, "p1")).toBe("at stop · as valued at 23:09"));
    expect(screen.getByText("holdings valued at 23:09:30")).toBeTruthy();
    expect(document.querySelector(".nx-mkt-closed")!.textContent).toContain("valued at 23:09");
  });

  it("moves the line and the chip on together by the line's own refresh", async () => {
    await open("desk", SUNDAY, true, "Live");
    stamp = "2026-11-08 23:11:02+08:00";
    fireEvent.click(within(document.querySelector<HTMLElement>(".nx-mkt-closed")!)
      .getByRole("button", { name: "refresh the valuation" }));
    await until(() => expect(chipIn(document, "p1")).toBe("at stop · as valued at 23:11"));
    expect(document.querySelector(".nx-mkt-closed")!.textContent).toContain("market closed — valued at 23:11");
  });
});

describe("a valuation from another day says its date (#371's review)", () => {
  it("on the chip, the inspector and the market-closed line alike", async () => {
    // Sunday 23:00 in +08; valued on Friday's +08 evening, before the session's last edge
    stamp = "2026-11-06 23:04:11+08:00";
    await open("desk", SUNDAY);
    expect(chipIn(document, "p1")).toBe("at stop · as valued at Fri 23:04");
    expect(document.querySelector(".nx-mkt-closed")!.textContent).toContain("market closed — valued at Fri 23:04");
    fireEvent.click(within(document.querySelector<HTMLElement>('.nxd-row[data-ref="p1"]')!)
      .getByRole("button", { name: "1231_7000P" }));
    const inspector = await screen.findByRole("complementary", { name: "inspector: 1231_7000P" });
    expect(inspector.querySelector(".nx-chip")?.textContent).toBe("at stop · as valued at Fri 23:04");
  });

  it("on the phone's card", async () => {
    stamp = "2026-10-30 23:04:11+08:00";
    await open("phone", SUNDAY, true, "Live");
    const card = document.querySelector<HTMLElement>('article[data-ref="p1"]')!;
    expect(card.querySelector(".nx-chip")?.textContent).toBe("at stop · as valued at 30 Oct 23:04");
  });
});

describe("the saved picture says which valuation, outside the session only", () => {
  function picture(arrangement: Arrangement, mode: "live" | "review", session: boolean) {
    at(SUNDAY); // the stamp is today's, so its time alone
    render(<Still arrangement={arrangement} quotes={[spread] as never} monitors={[]}
                  holdings={[holding, due] as unknown as Holding[]} holdingsError={null} holdingsAt="23:04:15"
                  mode={mode} session={session} privacy={false} entryStyle="opportunity" needs={[]} health={null}
                  polledAt={null} error={null} references={[]} />);
  }

  for (const arrangement of ["desk", "phone"] as Arrangement[]) {
    for (const mode of ["live", "review"] as const) {
      it(`from the ${arrangement} in ${mode}`, () => {
        picture(arrangement, mode, false);
        expect(chipIn(document, "p1")).toBe("at stop · as valued at 23:04");
        expect(document.querySelector(".nx-mkt-closed")!.textContent).toBe("market closed — valued at 23:04");
        // nothing in a picture can be pressed
        expect(document.querySelector(".nx-mkt-closed button")).toBeNull();
        cleanup();
        picture(arrangement, mode, true);
        expect(chipIn(document, "p1")).toBe("at stop");
        expect(document.querySelector(".nx-mkt-closed")).toBeNull();
      });
    }
  }
});
