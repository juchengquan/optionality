/** `/runs`. Ported from tests/test_runs_api.py (ADR 0009, phase 5).
 *
 *  Two of the Python's four tests drive a run all the way through the worker and then read the
 *  report it wrote. There is no worker until phase 6, so the split here is by ownership: these
 *  assert that the route validates, creates a run and hands the id over, and that the report routes
 *  serve what is stored. That a run actually executes and stores that report is ported with the
 *  worker.
 */
import { afterEach, describe, expect, it } from "vitest";

import { HOLDINGS_BODY } from "../fixtures.ts";
import { type Harness, body, harness, json } from "../testing.ts";

let h: Harness;
afterEach(() => h?.close());

const SUMMARY = {
  summary: [{ strike_date: "2026-12-18" }],
  details: [
    { strike_date: "2026-12-18", group: "ab12", code: "US.SPXW261218C6500000", mid_price: 1377.6 },
    { strike_date: "2026-12-18", group: "ab12", code: "US.SPXW261218P6425000", mid_price: 12.4 },
  ],
};

const withConfig = async () => {
  h = harness();
  await h.call("/configs", json({ name: "spx", task_type: "holdings", body: HOLDINGS_BODY }));
  return h;
};

/** A finished run and its report, as the worker will leave them in phase 6. */
const seedRun = (id: string, status = "succeeded") => {
  h.db.prepare(
    `insert into runs (id, task_type, config_name, trigger, notify, attempt, status, created_at,
       started_at, finished_at)
     values (?, 'holdings', 'spx', 'api', 0, 1, ?, ?, ?, ?)`,
  ).run(id, status, "2026-08-10 03:35:32.000000", "2026-08-10 03:35:33.000000",
    "2026-08-10 03:35:34.000000");
  h.db.prepare("insert into reports (run_id, summary, html, created_at) values (?, ?, ?, ?)")
    .run(id, JSON.stringify(SUMMARY), "<p>stub</p>", "2026-08-10 03:35:34.000000");
};

describe("triggering", () => {
  it("accepts the run and hands the id to the worker", async () => {
    await withConfig();
    const resp = await h.call("/runs", json({ task: "holdings", config: "spx" }));
    expect(resp.status).toBe(202);
    const { run_id, status } = await body(resp);
    expect(status).toBe("queued");
    // creating the row and running it are separate because one worker thread owns execution
    expect(h.runs.created).toEqual([
      { taskType: "holdings", configName: "spx", trigger: "api", notify: false },
    ]);
    expect(h.worker.submitted).toEqual([run_id]);
  });

  it("carries notify through, since it decides whether a phone buzzes", async () => {
    await withConfig();
    await h.call("/runs", json({ task: "holdings", config: "spx", notify: true }));
    expect(h.runs.created[0]!.notify).toBe(true);
  });

  it("is a 404 for a config that does not exist", async () => {
    await withConfig();
    const resp = await h.call("/runs", json({ task: "holdings", config: "ghost" }));
    expect(resp.status).toBe(404);
    expect(await body(resp)).toEqual({ detail: "config 'ghost' not found" });
    expect(h.worker.submitted).toEqual([]);
  });

  it("is a 422 when the task does not match the config's own type", async () => {
    await withConfig();
    const resp = await h.call("/runs", json({ task: "strategy", config: "spx" }));
    expect(resp.status).toBe(422);
    expect(await body(resp))
      .toEqual({ detail: "config 'spx' is a 'holdings' config, not 'strategy'" });
    expect(h.worker.submitted).toEqual([]);
  });
});

describe("listing", () => {
  it("returns the newest first and filters by status", async () => {
    await withConfig();
    seedRun("a".repeat(32), "succeeded");
    seedRun("b".repeat(32), "failed");
    h.db.prepare("update runs set created_at = ? where id = ?")
      .run("2026-08-11 03:35:32.000000", "b".repeat(32));

    const all = await body(await h.call("/runs"));
    expect(all.map((r: { id: string }) => r.id)).toEqual(["b".repeat(32), "a".repeat(32)]);

    const ok = await body(await h.call("/runs?status=succeeded"));
    expect(ok.map((r: { id: string }) => r.id)).toEqual(["a".repeat(32)]);
  });

  it("caps the limit rather than refusing a silly one", async () => {
    // the dashboard asks for a page; an absurd number is a client bug the API should survive
    await withConfig();
    seedRun("a".repeat(32));
    expect((await h.call("/runs?limit=100000")).status).toBe(200);
    expect((await body(await h.call("/runs?limit=0"))).length).toBe(0);
  });

  it("reports notify as a boolean and the three timestamps in the display zone", async () => {
    await withConfig();
    seedRun("a".repeat(32));
    const [run] = await body(await h.call("/runs"));
    expect(run.notify).toBe(false);
    expect(run.created_at).toBe("2026-08-10 11:35:32+08:00");
    expect(run.started_at).toBe("2026-08-10 11:35:33+08:00");
    expect(run.finished_at).toBe("2026-08-10 11:35:34+08:00");
    expect(run.error).toBeNull();
  });

  it("is a 404 for a run that was never there", async () => {
    await withConfig();
    expect((await h.call("/runs/nope")).status).toBe(404);
  });
});

describe("the report", () => {
  it("serves the stored summary", async () => {
    await withConfig();
    seedRun("a".repeat(32));
    const report = await body(await h.call(`/runs/${"a".repeat(32)}/report`));
    expect(report.summary).toEqual([{ strike_date: "2026-12-18" }]);
  });

  it("serves the details, and filters them by contract", async () => {
    await withConfig();
    const id = "a".repeat(32);
    seedRun(id);
    expect((await body(await h.call(`/runs/${id}/details`))).length).toBe(2);
    expect((await body(await h.call(`/runs/${id}/details`)))[0].code)
      .toBe("US.SPXW261218C6500000");

    const filtered = await body(await h.call(`/runs/${id}/details?code=US.SPXW261218P6425000`));
    expect(filtered.length).toBe(1);
    expect(filtered[0].mid_price).toBe(12.4);

    expect(await body(await h.call(`/runs/${id}/details?code=US.NOPE`))).toEqual([]);
  });

  it("serves an empty list when the report has no details at all", async () => {
    await withConfig();
    const id = "a".repeat(32);
    seedRun(id);
    h.db.prepare("update reports set summary = ? where run_id = ?").run("{}", id);
    expect(await body(await h.call(`/runs/${id}/details`))).toEqual([]);
  });

  it("serves the HTML as a document", async () => {
    await withConfig();
    const id = "a".repeat(32);
    seedRun(id);
    const resp = await h.call(`/runs/${id}/report.html`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await resp.text()).toContain("<p>stub</p>");
  });

  it("is a 404 before the run has produced one", async () => {
    await withConfig();
    for (const path of ["/report", "/details", "/report.html"]) {
      const resp = await h.call(`/runs/doesnotexist${path}`);
      expect(resp.status, path).toBe(404);
      expect(await body(resp)).toEqual({ detail: "report not found" });
    }
  });
});
