/** `GET /account`: the IBKR account, through the app (ADR 0031, #477). What a start comes to and how
 *  the hold is kept are `account.test.ts`'s; this holds the door — the token, the shape, the
 *  statuses, and one hold per app. */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccountSource, AccountWatching, IbkrLiveAccount } from "../../../ports.ts";
import { type Harness, body, harness } from "../../../../testing/harness.ts";

let h: Harness;
afterEach(() => h?.close());

const ACCOUNT: IbkrLiveAccount = {
  account: "masked-by-the-library", paper: true, base_currency: "USD", updated_at: "09:41",
  totals: { net_liquidation: 1000, total_cash: 1000, unrealized_pnl: 0, realized_pnl: 0 },
  exchange_rates: { USD: 1 },
  holdings: [{
    sec_type: "OPT", symbol: "ACME", currency: "USD", expiry: "20261218", strike: 45, right: "C",
    multiplier: 100, position: 1, market_price: 1.5, market_value: 150, average_cost: 1.25,
    unrealized_pnl: 25, realized_pnl: 0, daily_pnl: -5,
  }],
  pnl: { daily_pnl: -5, unrealized_pnl: 25, realized_pnl: null },
  pnl_at: new Date("2026-10-02T05:26:01Z").getTime(),
};

function watching(answer: AccountWatching | "watch") {
  const asked: (string | null)[] = [];
  const source: AccountSource = {
    watch(wanted) {
      asked.push(wanted);
      return Promise.resolve(answer !== "watch" ? answer : {
        watch: { picture: () => structuredClone(ACCOUNT), lost: null, onLost: () => {}, stop: () => Promise.resolve() },
      });
    },
    onAnswered: () => {},
  };
  return { source, asked };
}

describe("GET /account", () => {
  it("is behind the token, and starts nothing for a caller without one", async () => {
    const w = watching("watch");
    h = harness({ account: w.source });
    const resp = await h.call("/account", { anonymous: true });
    expect(resp.status).toBe(401);
    expect(w.asked).toEqual([]);
  });

  it("answers the account in the route's shape, IBKR_ACCOUNT handed to the watch", async () => {
    const w = watching("watch");
    h = harness({ account: w.source, settings: { ibkrAccount: "DU0000000" } });
    const resp = await h.call("/account");
    expect(resp.status).toBe(200);
    expect(await body(resp)).toEqual({
      account: "masked-by-the-library", paper: true, base_currency: "USD", updated_at: "09:41",
      read_at: "2026-10-02 13:26:06+08:00",
      // the stream's realised unset: the account update's
      totals: { net_liquidation: 1000, total_cash: 1000, unrealized_pnl: 25, realized_pnl: 0, daily_pnl: -5 },
      exchange_rates: { USD: 1 }, stocks: [], options: [ACCOUNT.holdings[0]], other: [],
      live: { updated_at: "2026-10-02 13:26:01+08:00" },
    });
    expect(w.asked).toEqual(["DU0000000"]);
  });

  it("holds one watch for two requests to the same app", async () => {
    const w = watching("watch");
    h = harness({ account: w.source });
    await h.call("/account");
    await h.call("/account");
    expect(w.asked).toHaveLength(1);
  });

  it("is a 503 where IB Gateway is not configured", async () => {
    h = harness();
    const resp = await h.call("/account");
    expect(resp.status).toBe(503);
    expect(await body(resp)).toEqual({ detail: "IB Gateway is not configured" });
  });

  it("is a 502 where the gateway does not answer, and a 422 where the account is refused", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    h = harness({ account: watching({ unreachable: "could not reach IB Gateway at 127.0.0.1:4001: connect ECONNREFUSED 127.0.0.1:4001" }).source });
    expect((await h.call("/account")).status).toBe(502);
    h.close();
    quiet.mockRestore();
    h = harness({ account: watching({ refused: "several accounts on this login" }).source });
    const resp = await h.call("/account");
    expect(resp.status).toBe(422);
    expect(await body(resp)).toEqual({ detail: "several accounts on this login" });
  });
});
