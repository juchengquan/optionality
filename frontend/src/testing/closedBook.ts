/** Closed holdings for the suites of REVIEW's journal (#296): the owner's book (`ownerBook.ts`) with
 *  three trades it has closed — two on one day, one with no Exit — behind a service that remembers
 *  writes (`holdingService.ts`). One trade has a week of samples, two days of them written after
 *  the day it is closed on, which the service hides as the route does (a backdated close, ADR 0022).
 */
import type { Holding, Sample, Samples } from "../api";
import { holdingService, type HoldingService } from "./holdingService";
import { HOLDINGS } from "./ownerBook";

const put = (side: "short" | "long", strike: number) => ({ side, option_type: "PUT", strike });
const call = (side: "short" | "long", strike: number) => ({ side, option_type: "CALL", strike });

/** A closed holding as `/positions/values` would never serve it and `/positions` does: kept. */
function closed(id: string, over: Partial<Holding>): Holding {
  return { ...HOLDINGS[0]!, id, name: id, contracts: 1, cost_to_close: null, pnl: null, captured: null, ...over } as Holding;
}

const OLD = closed("c-old", {
  name: "1120_P6000", strike_date: "2026-11-20", opened_at: "2026-11-01", closed_on: "2026-11-06",
  entry: 2, exit: 0.5, contracts: 3, legs: [put("short", 6000), put("long", 5950)] as Holding["legs"],
});
// two closed on one day: by name
const TIE = closed("c-tie", {
  name: "1204_P6500", strike_date: "2026-12-04", opened_at: "2026-11-02", closed_on: "2026-11-10",
  entry: 1.8, exit: 2.4, legs: [put("short", 6500), put("long", 6450)] as Holding["legs"],
});
// closed with no Exit: what it made is unknown
const BLANK = closed("c-blank", {
  name: "1204_C7500", strike_date: "2026-12-04", opened_at: "2026-11-02", closed_on: "2026-11-10",
  entry: 1.5, exit: null, legs: [call("short", 7500), call("long", 7550)] as Holding["legs"],
});

export const days = (from: string, n: number) => Array.from({ length: n }, (_, i) =>
  new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
const dteOf = (on: string, expiry: string) =>
  Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${on}T00:00:00Z`)) / 86_400_000);

/** c-old's history as the sweep wrote it: every day from its open to the 8th — two days past the
 *  close it was given, which the service hides (a backdated close, ADR 0022). */
const OLD_SAMPLES: Samples = {
  levels: { dte_at_open: 19, target: 1, stop: 4, target_dte: 5, manage_by_dte: 21 },
  plan: Array.from({ length: 20 }, (_, i) => ({ dte: 19 - i, on_pace: 2 * Math.sqrt((19 - i) / 19) })),
  samples: days("2026-11-01", 8).map((on, i): Sample => ({
    observed_on: on, observed_at: `${on} 05:00:00+08:00`, timing: "close", dte: dteOf(on, "2026-11-20"),
    cost_to_close: 2 - i * 0.2, on_pace: null,
    legs_iv: { "US.SPXW261120P6000000": 20 - i, "US.SPXW261120P5950000": 22 - i },
    // SPX as each day's batch implied it (ADR 0024), walking up towards the short put's 6000
    legs_vega: null, legs_delta: null, spx: 6120 - i * 12,
  })),
};
const EMPTY: Samples = { levels: null, plan: [], samples: [] };

/** The book behind a service; `over` changes a closed trade as stored, by its id. */
export function closedBookService(over: Record<string, Partial<Holding>> = {}): HoldingService {
  return holdingService({
    holdings: [...HOLDINGS, ...[OLD, TIE, BLANK].map((h) => ({ ...h, ...over[h.id] }))],
    samples: { "c-old": OLD_SAMPLES, "c-tie": EMPTY, "c-blank": EMPTY },
  });
}
