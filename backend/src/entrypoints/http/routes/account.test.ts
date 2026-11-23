/** `GET /account`: the IBKR account, through the app (ADR 0030, #470). What each read comes to and
 *  how one is shared are `account.test.ts`'s; this holds the door — the token, the shape, the
 *  statuses, and one book per app. */
import { afterEach, describe, expect, it } from "vitest";

import type { AccountReading, ReadAccount } from "../../../ports.ts";
import { type Harness, body, harness } from "../../../../testing/harness.ts";

let h: Harness;
afterEach(() => h?.close());

const ACCOUNT = {
  account: "masked-by-the-library", paper: true, base_currency: "USD", updated_at: "09:41",
  totals: { net_liquidation: 1000, total_cash: 1000, unrealized_pnl: 0, realized_pnl: 0 },
  exchange_rates: { USD: 1 },
  holdings: [],
};

function reading(answer: AccountReading) {
  const asked: (string | null)[] = [];
  const read: ReadAccount = (wanted) => {
    asked.push(wanted);
    return Promise.resolve(answer);
  };
  return { read, asked };
}

describe("GET /account", () => {
  it("is behind the token, and reads nothing for a caller without one", async () => {
    const r = reading({ account: ACCOUNT });
    h = harness({ account: r.read });
    const resp = await h.call("/account", { anonymous: true });
    expect(resp.status).toBe(401);
    expect(r.asked).toEqual([]);
  });

  it("answers the account in the route's shape, IBKR_ACCOUNT handed to the read", async () => {
    const r = reading({ account: ACCOUNT });
    h = harness({ account: r.read, settings: { ibkrAccount: "DU0000000" } });
    const resp = await h.call("/account");
    expect(resp.status).toBe(200);
    expect(await body(resp)).toEqual({
      account: "masked-by-the-library", paper: true, base_currency: "USD", updated_at: "09:41",
      read_at: "2026-10-02 13:26:06+08:00",
      totals: ACCOUNT.totals, exchange_rates: { USD: 1 }, stocks: [], options: [], other: [],
    });
    expect(r.asked).toEqual(["DU0000000"]);
  });

  it("shares one read between two requests to the same app", async () => {
    const r = reading({ account: ACCOUNT });
    h = harness({ account: r.read });
    await h.call("/account");
    await h.call("/account");
    expect(r.asked).toHaveLength(1);
  });

  it("is a 503 where IB Gateway is not configured", async () => {
    h = harness();
    const resp = await h.call("/account");
    expect(resp.status).toBe(503);
    expect(await body(resp)).toEqual({ detail: "IB Gateway is not configured" });
  });

  it("is a 502 where the gateway does not answer, and a 422 where the account is refused", async () => {
    h = harness({ account: reading({ unreachable: "could not reach IB Gateway at 127.0.0.1:4001: connect ECONNREFUSED 127.0.0.1:4001" }).read });
    expect((await h.call("/account")).status).toBe(502);
    h.close();
    h = harness({ account: reading({ refused: "several accounts on this login" }).read });
    const resp = await h.call("/account");
    expect(resp.status).toBe(422);
    expect(await body(resp)).toEqual({ detail: "several accounts on this login" });
  });
});
