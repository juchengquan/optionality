/** `/schedules`. Ported from tests/test_schedules_api.py (ADR 0009, phase 5).
 *
 *  The Python test asserts on the live APScheduler — `scheduler.get_job("schedule-3") is not None`
 *  after a create, and None again once the row is disabled. There is no scheduler until phase 6, so
 *  what is asserted here is the half that belongs to the route: that every write tells the scheduler
 *  to reload. The other half — that a reload produces a job for an enabled row and none for a
 *  disabled one — is ported with `refreshJobs` itself.
 */
import { afterEach, describe, expect, it } from "vitest";

import { HOLDINGS_BODY } from "../fixtures.ts";
import { type Harness, body, harness, json } from "../testing.ts";

let h: Harness;
afterEach(() => h?.close());

const withConfig = async () => {
  h = harness();
  await h.call("/configs", json({ name: "spx", task_type: "holdings", body: HOLDINGS_BODY }));
  return h;
};

const schedule = (over: Record<string, unknown> = {}) =>
  ({ cron_expr: "35 9 * * mon-fri", task_type: "holdings", config_name: "spx", ...over });

describe("the round trip", () => {
  it("creates, lists, updates and deletes, reloading the scheduler each time", async () => {
    await withConfig();
    const created = await h.call("/schedules", json(schedule()));
    expect(created.status).toBe(201);
    const id = (await body(created)).id;
    expect(h.scheduler.refreshes).toBe(1);

    const listed = await body(await h.call("/schedules"));
    // the default the owner relies on: schedule cron tz stays America/New_York (CLAUDE.md)
    expect(listed[0].tz).toBe("America/New_York");
    expect(listed[0].enabled).toBe(true);

    const put = await h.call(`/schedules/${id}`, {
      ...json(schedule({ enabled: false })), method: "PUT",
    });
    expect(put.status).toBe(200);
    expect((await body(put)).enabled).toBe(false);
    expect(h.scheduler.refreshes).toBe(2);

    expect((await h.call(`/schedules/${id}`, { method: "DELETE" })).status).toBe(204);
    expect(h.scheduler.refreshes).toBe(3);
    expect(await body(await h.call("/schedules"))).toEqual([]);
  });

  it("round-trips enabled as a boolean, though the column holds 0 and 1", async () => {
    // node:sqlite refuses to bind a JavaScript boolean at all, so this is the conversion working
    await withConfig();
    const id = (await body(await h.call("/schedules", json(schedule({ enabled: false }))))).id;
    expect(h.db.prepare("select enabled from schedules where id = ?").get(id))
      .toMatchObject({ enabled: 0 });
    expect((await body(await h.call("/schedules")))[0].enabled).toBe(false);
  });

  it("is a 404 for a schedule that was never there, and does not reload", async () => {
    await withConfig();
    expect((await h.call("/schedules/99", { ...json(schedule()), method: "PUT" })).status).toBe(404);
    expect((await h.call("/schedules/99", { method: "DELETE" })).status).toBe(404);
    expect(h.scheduler.refreshes).toBe(0);
  });
});

describe("validation", () => {
  it("rejects an expression that cannot be scheduled", async () => {
    await withConfig();
    expect((await h.call("/schedules", json(schedule({ cron_expr: "nope" })))).status).toBe(422);
    expect((await h.call("/schedules", json(schedule({ cron_expr: "60 9 * * *" })))).status).toBe(422);
    expect(h.scheduler.refreshes).toBe(0);
  });

  it("rejects a timezone that does not exist", async () => {
    // accepted and then silently misfired is the worst outcome: the run just never happens
    await withConfig();
    expect((await h.call("/schedules", json(schedule({ tz: "Mars/Olympus" })))).status).toBe(422);
  });

  it("rejects a config that does not exist", async () => {
    await withConfig();
    const resp = await h.call("/schedules", json(schedule({ config_name: "ghost" })));
    expect(resp.status).toBe(422);
    expect(await body(resp)).toEqual({ detail: "config 'ghost' does not exist" });
  });

  it("accepts the named weekday form the owner's own schedule uses", async () => {
    await withConfig();
    expect((await h.call("/schedules", json(schedule({ cron_expr: "35 9 * * mon-fri" })))).status)
      .toBe(201);
    expect((await h.call("/schedules", json(schedule({ cron_expr: "35 9 * * 1-5" })))).status)
      .toBe(201);
  });
});
