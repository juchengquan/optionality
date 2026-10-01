/** `/spx/quote`. Ported from tests/test_spx_api.py (ADR 0009, phase 5).
 *
 *  Its `test_build_spx_code` landed in domain/contract.test.ts, where the function lives.
 */
import { afterEach, describe, expect, it } from "vitest";

import { type Harness, body, harness } from "../testing.ts";

let h: Harness;
afterEach(() => h?.close());

const ask = (query: string) => h.call(`/spx/quote?${query}`);
const CALL_6500 = "strike_date=2026-12-18&option_type=CALL&strike=6500";

describe("one live quote", () => {
  it("builds the code and returns the contract's figures", async () => {
    h = harness({
      fetchQuotes: (codes) => Promise.resolve([
        { code: codes[0]!, last_price: 12.3, update_time: "2026-08-09 20:15:00" },
      ]),
    });
    const resp = await ask(CALL_6500);
    expect(resp.status).toBe(200);
    const data = await body(resp);
    expect(data.code).toBe("US.SPXW261218C6500000");
    expect(data.snapshot.last_price).toBe(12.3);
    // the market timestamp is Eastern on the wire and the display zone on the way out
    expect(data.snapshot.update_time).toBe("2026-08-10 08:15:00+08:00");
    // the call-time stamp beside the last-trade time: update_time means LAST TRADE, not freshness
    expect(data.snapshot.fetched_at).toMatch(/\+08:00$/);
  });

  it("leaves a quote with no update_time alone", async () => {
    h = harness({ fetchQuotes: (codes) => Promise.resolve([{ code: codes[0]!, last_price: 1 }]) });
    const data = await body(await ask(CALL_6500));
    expect(data.snapshot.update_time).toBeUndefined();
    expect(data.snapshot.fetched_at).toMatch(/\+08:00$/);
  });

  it("validates the parameters", async () => {
    h = harness();
    expect((await ask("strike_date=2026-12-18&option_type=FOO&strike=6500")).status).toBe(422);
    expect((await ask("strike_date=18-12-2026&option_type=CALL&strike=6500")).status).toBe(422);
    expect((await ask("strike_date=2026-02-30&option_type=CALL&strike=6500")).status).toBe(422);
    expect((await ask("strike_date=2026-12-18&option_type=CALL&strike=nope")).status).toBe(422);
    expect((await ask("option_type=CALL&strike=6500")).status).toBe(422);
  });

  it("is a 404 when there is no data for the contract", async () => {
    h = harness({ fetchQuotes: () => Promise.resolve([]) });
    const resp = await ask(CALL_6500);
    expect(resp.status).toBe(404);
    expect((await body(resp)).detail).toBe("no data for US.SPXW261218C6500000");
  });

  it("is a 502 when the OpenD call fails, not a 500", async () => {
    h = harness({ fetchQuotes: () => Promise.reject(new Error("Client connection failed!")) });
    const resp = await ask(CALL_6500);
    expect(resp.status).toBe(502);
    expect((await body(resp)).detail).toMatch(/OpenD call failed/);
  });

  it("takes a fractional strike and truncates it in the code, as the Python does", async () => {
    h = harness({ fetchQuotes: (codes) => Promise.resolve([{ code: codes[0]! }]) });
    const data = await body(await ask("strike_date=2026-12-18&option_type=PUT&strike=6425.9"));
    expect(data.code).toBe("US.SPXW261218P6425000");
  });
});
