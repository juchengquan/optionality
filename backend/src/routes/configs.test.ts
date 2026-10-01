/** `/configs`. Ported from tests/test_configs_api.py (ADR 0009, phase 5). */
import { afterEach, describe, expect, it } from "vitest";

import { HOLDINGS_BODY, STRATEGY_BODY } from "../fixtures.ts";
import { type Harness, body, harness, json } from "../testing.ts";

let h: Harness;
afterEach(() => h?.close());

const config = (over: Record<string, unknown> = {}) =>
  ({ name: "spx", task_type: "holdings", body: HOLDINGS_BODY, ...over });

describe("the round trip", () => {
  it("creates, lists, reads, updates and deletes", async () => {
    h = harness();
    expect((await h.call("/configs", json(config()))).status).toBe(201);
    // the name is unique, and a second POST is a mistake rather than an update
    expect((await h.call("/configs", json(config()))).status).toBe(409);

    const listed = await body(await h.call("/configs"));
    expect(listed.map((c: { name: string }) => c.name)).toEqual(["spx"]);

    const got = await body(await h.call("/configs/spx"));
    expect(got.body.code_information.name).toBe("SPX");

    const put = await h.call("/configs/spx", { ...json(config()), method: "PUT" });
    expect(put.status).toBe(200);

    expect((await h.call("/configs/spx", { method: "DELETE" })).status).toBe(204);
    expect((await h.call("/configs/spx")).status).toBe(404);
  });

  it("lists a summary without the body, and reads one with it", async () => {
    // the list is for a picker; a body can be kilobytes of strategy
    h = harness();
    await h.call("/configs", json(config()));
    const [listed] = await body(await h.call("/configs"));
    expect(Object.keys(listed).sort()).toEqual(["created_at", "name", "task_type", "updated_at"]);
    expect(Object.keys(await body(await h.call("/configs/spx"))).sort())
      .toEqual(["body", "created_at", "name", "task_type", "updated_at"]);
  });

  it("stamps created_at and updated_at in the display zone", async () => {
    h = harness();
    h.now = new Date("2026-08-10T03:35:32Z");
    const created = await body(await h.call("/configs", json(config())));
    expect(created.created_at).toBe("2026-08-10 11:35:32+08:00");
    expect(created.updated_at).toBe("2026-08-10 11:35:32+08:00");

    h.now = new Date("2026-08-11T03:35:32Z");
    const updated = await body(await h.call("/configs/spx", { ...json(config()), method: "PUT" }));
    // created_at must not move: it is when the owner wrote it, not when they last touched it
    expect(updated.created_at).toBe("2026-08-10 11:35:32+08:00");
    expect(updated.updated_at).toBe("2026-08-11 11:35:32+08:00");
  });
});

describe("validation", () => {
  it("rejects a body that is not a config of that type", async () => {
    h = harness();
    expect((await h.call("/configs", json({ name: "x", task_type: "holdings", body: { nope: true } })))
      .status).toBe(422);
  });

  it("rejects a strategy body sent as holdings", async () => {
    // the two shapes share a notification and a code_information and differ in the rest, so the
    // task type decides which schema applies
    h = harness();
    expect((await h.call("/configs", json({ name: "x", task_type: "holdings", body: STRATEGY_BODY })))
      .status).toBe(422);
    expect((await h.call("/configs", json({ name: "y", task_type: "strategy", body: STRATEGY_BODY })))
      .status).toBe(201);
  });

  it("rejects an unknown key inside notification, where a typo means silence", async () => {
    h = harness();
    const sent = { ...HOLDINGS_BODY, notification: { file: { file_path: "./out.html" }, slak: {} } };
    expect((await h.call("/configs", json({ name: "x", task_type: "holdings", body: sent }))).status)
      .toBe(422);
  });

  it("rejects an unknown task type", async () => {
    h = harness();
    expect((await h.call("/configs", json(config({ task_type: "wishful" })))).status).toBe(422);
  });

  it("validates on update too, and leaves the stored config alone when it fails", async () => {
    h = harness();
    await h.call("/configs", json(config()));
    expect((await h.call("/configs/spx", { ...json(config({ body: { nope: true } })), method: "PUT" }))
      .status).toBe(422);
    expect((await body(await h.call("/configs/spx"))).body.code_information.name).toBe("SPX");
  });

  it("stores the body exactly as sent, including keys the schema does not name", async () => {
    // Pydantic ignores unknown keys and Zod strips them, so storing the PARSED value would quietly
    // delete something the owner wrote. Validation is a gate here, not a transform.
    h = harness();
    const sent = { ...HOLDINGS_BODY, note: "mine" };
    await h.call("/configs", json({ name: "spx", task_type: "holdings", body: sent }));
    expect((await body(await h.call("/configs/spx"))).body.note).toBe("mine");
  });
});

describe("deleting", () => {
  it("refuses while a schedule points at it", async () => {
    // a schedule whose config is gone fires into nothing, in the background, where nobody looks
    h = harness();
    await h.call("/configs", json(config()));
    h.db.prepare(
      "insert into schedules (cron_expr, tz, task_type, config_name, enabled) values (?, ?, ?, ?, ?)",
    ).run("0 9 * * *", "America/New_York", "holdings", "spx", 1);
    const resp = await h.call("/configs/spx", { method: "DELETE" });
    expect(resp.status).toBe(409);
    expect(await body(resp)).toEqual({ detail: "config is referenced by a schedule" });
  });

  it("is a 404 for one that was never there", async () => {
    h = harness();
    expect((await h.call("/configs/ghost", { method: "DELETE" })).status).toBe(404);
  });
});
