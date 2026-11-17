/** `PATCH /settings`: the sweep's interval, set from the page (#442, ADR 0025). */
import { afterEach, describe, expect, it } from "vitest";

import { readSweepInterval } from "../../../db/queries/index.ts";
import { type Harness, body, harness } from "../../../../testing/harness.ts";

let h: Harness;
const start = (...args: Parameters<typeof harness>) => (h = harness(...args));
afterEach(() => h?.close());

/** `.env` sweeps every 15s, as the live one does. */
const ENV_15 = { settings: { monitorIntervalSeconds: 15 } };

const patch = (sweep: unknown, init: { anonymous?: boolean } = {}) => h.call("/settings", {
  method: "PATCH", body: JSON.stringify(sweep), headers: { "Content-Type": "application/json" }, ...init,
});

const PRESETS = [5, 10, 15, 30, 60];

describe("choosing the sweep's interval", () => {
  it("stores a preset and answers the interval now in force", async () => {
    start(ENV_15);
    h.now = new Date("2026-11-17T10:00:00.000Z");
    const resp = await patch({ sweep_seconds: 5 });
    expect(resp.status).toBe(200);
    expect(await body(resp)).toEqual({
      sweep_seconds: 5, sweep_source: "settings", sweep_default_seconds: 15, sweep_presets: PRESETS,
      sweep_refused: null,
    });
    expect(readSweepInterval(h.db)).toEqual({ id: 1, seconds: 5, set_at: "2026-11-17 10:00:00.000000" });
  });

  it("goes back to .env's on null, by deleting the choice", async () => {
    start(ENV_15);
    await patch({ sweep_seconds: 60 });
    const resp = await patch({ sweep_seconds: null });
    expect(resp.status).toBe(200);
    expect(await body(resp)).toEqual({
      sweep_seconds: 15, sweep_source: "env", sweep_default_seconds: 15, sweep_presets: PRESETS,
      sweep_refused: null,
    });
    expect(readSweepInterval(h.db)).toBeUndefined();
  });

  it("refuses anything but a preset or null, in zod's words, and stores nothing", async () => {
    start(ENV_15);
    for (const refused of [{ sweep_seconds: 7 }, { sweep_seconds: 2 }, { sweep_seconds: "5" },
      { sweep_seconds: true }, {}]) {
      const resp = await patch(refused);
      expect(resp.status, JSON.stringify(refused)).toBe(422);
      expect((await body(resp)).detail).toBe(
        "✖ Invalid option: expected one of 5|10|15|30|60\n  → at sweep_seconds");
    }
    expect(readSweepInterval(h.db)).toBeUndefined();
  });

  it("needs the token, as every write does", async () => {
    start(ENV_15);
    const resp = await patch({ sweep_seconds: 5 }, { anonymous: true });
    expect(resp.status).toBe(401);
    expect(readSweepInterval(h.db)).toBeUndefined();
  });
});

describe("/health's sweep interval", () => {
  it("is .env's, said to be, with the default and the presets beside it", async () => {
    start(ENV_15);
    const data = await body(await h.call("/health", { anonymous: true }));
    expect(data.settings).toMatchObject({
      sweep_seconds: 15, sweep_source: "env", sweep_default_seconds: 15, sweep_presets: PRESETS,
      sweep_refused: null,
    });
  });

  it("is the page's choice the moment it is made, with no restart", async () => {
    start(ENV_15);
    await patch({ sweep_seconds: 30 });
    const data = await body(await h.call("/health", { anonymous: true }));
    expect(data.settings).toMatchObject({ sweep_seconds: 30, sweep_source: "settings", sweep_default_seconds: 15 });
  });

  it("is .env's when the stored value was edited by hand to something not a preset", async () => {
    start(ENV_15);
    h.db.prepare("insert into sweep_interval values (1, 2, '2026-11-17 10:00:00.000000')").run();
    const data = await body(await h.call("/health", { anonymous: true }));
    expect(data.settings).toMatchObject({ sweep_seconds: 15, sweep_source: "env", sweep_refused: "2" });
  });
});
