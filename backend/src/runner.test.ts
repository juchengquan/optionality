/** Calling the Python run pipeline (ADR 0009, phase 6c).
 *
 *  Mostly against a stand-in process rather than Python: what is under test is the boundary — the file
 *  protocol, the three ways it can fail, and the distinction between a failed TASK and a bridge that
 *  could not run at all. One test does call the real bridge, with a config that fails validation, so
 *  the two halves are known to agree on the protocol without needing OpenD.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PythonRunner, TaskFailed } from "./runner.ts";

const ROOT = new URL("../..", import.meta.url).pathname;

/** A stand-in for `python -m optionality.runner`: Node, running a script that writes the response. */
function standIn(script: string, extra: Record<string, unknown> = {}) {
  // the runner appends only the two file paths, so the stand-in reads the last two arguments —
  // the same contract the Python entry point has
  return new PythonRunner({
    cwd: ROOT,
    command: ["node", "--input-type=module", "-e", script],
    ...extra,
  });
}

const WRITE_OK = `
import { writeFileSync, readFileSync } from "node:fs";
const [input, output] = process.argv.slice(-2);
const request = JSON.parse(readFileSync(input, "utf8"));
writeFileSync(output, JSON.stringify({
  ok: true, html: "<p>" + request.task + "</p>", summary: [1], warnings: null,
  details: [{ code: "x" }], notify_error: null,
}));
`;

const request = {
  task: "holdings", config: { a: 1 }, notify: true, opendHost: "127.0.0.1", opendPort: 11111,
};

describe("a run that works", () => {
  it("passes the request through and reads the response back", async () => {
    const outcome = await standIn(WRITE_OK).run(request);
    expect(outcome.html).toBe("<p>holdings</p>");
    expect(outcome.summary).toEqual([1]);
    expect(outcome.details).toEqual([{ code: "x" }]);
    expect(outcome.notifyError).toBeNull();
  });

  it("reports a report that could not be sent, without failing", async () => {
    const script = WRITE_OK.replace("notify_error: null", 'notify_error: "smtp refused"');
    expect((await standIn(script).run(request)).notifyError).toBe("smtp refused");
  });

  it("leaves no temporary files behind", async () => {
    // the request carries the whole config body, and a run happens every scheduled morning
    const script = `
      import { writeFileSync, readFileSync } from "node:fs";
      const [input, output] = process.argv.slice(-2);
      writeFileSync("${ROOT}/.runner-dir", input);
      writeFileSync(output, JSON.stringify({ ok: true, html: "x" }));
    `;
    await standIn(script).run(request);
    const used = readFileSync(`${ROOT}/.runner-dir`, "utf8");
    const { rmSync, existsSync } = await import("node:fs");
    expect(existsSync(used)).toBe(false);
    rmSync(`${ROOT}/.runner-dir`, { force: true });
  });
});

describe("a run that fails", () => {
  it("raises what the task said, as a task failure", async () => {
    const script = `
      import { writeFileSync } from "node:fs";
      writeFileSync(process.argv.at(-1), JSON.stringify({ ok: false, error: "Client connection failed!", type: "RuntimeError" }));
    `;
    await expect(standIn(script).run(request)).rejects.toThrow(TaskFailed);
    await expect(standIn(script).run(request)).rejects.toThrow("Client connection failed!");
  });

  it("says something when the task failed without saying why", async () => {
    const script = `
      import { writeFileSync } from "node:fs";
      writeFileSync(process.argv.at(-1), JSON.stringify({ ok: false }));
    `;
    await expect(standIn(script).run(request)).rejects.toThrow(/without saying why/);
  });
});

describe("a bridge that cannot run", () => {
  it("is a different failure from a failed task", async () => {
    // only a failed task carries an error worth showing on the run; this is the service being broken
    const runner = new PythonRunner({ cwd: ROOT, command: ["definitely-not-a-program"] });
    const error = await runner.run(request).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TaskFailed);
    expect((error as Error).message).toMatch(/could not start the run pipeline/);
  });

  it("reports the exit code and the last of what it said", async () => {
    const script = `
      process.stderr.write("line one\\nline two\\nthe actual reason\\n");
      process.exit(3);
    `;
    await expect(standIn(script).run(request)).rejects.toThrow(/exited 3.*the actual reason/s);
  });

  it("gives up rather than waiting for ever", async () => {
    // a strategy scan takes minutes; one that takes for ever would hold the queue closed and the
    // dashboard would show a run that is still "running" from yesterday
    const runner = standIn("setInterval(() => {}, 1000);", { timeoutMs: 150 });
    await expect(runner.run(request)).rejects.toThrow(/did not finish within 150ms/);
  });

  it("fails rather than hanging when the response file is never written", async () => {
    await expect(standIn("process.exit(0);").run(request)).rejects.toThrow(/ENOENT|no such file/);
  });
});

describe("the alert mode", () => {
  it("reports whether an email was actually sent", async () => {
    const script = `
      import { writeFileSync } from "node:fs";
      writeFileSync(process.argv.at(-1), JSON.stringify({ ok: true, sent: true }));
    `;
    expect(await standIn(script).alert({ task: "holdings", config: {}, subject: "s", message: "m" }))
      .toEqual({ sent: true });
  });

  it("carries the reason when the config wants no email", async () => {
    const script = `
      import { writeFileSync } from "node:fs";
      writeFileSync(process.argv.at(-1), JSON.stringify({ ok: true, sent: false, reason: "no gmail block" }));
    `;
    expect(await standIn(script).alert({ task: "holdings", config: {}, subject: "s", message: "m" }))
      .toEqual({ sent: false, reason: "no gmail block" });
  });
});

describe("against the real bridge", () => {
  it("agrees on the protocol, using a config that fails before OpenD is touched", async () => {
    // the one test that crosses for real. An invalid config fails in load_config, so this needs no
    // OpenD and no market — and it proves the two halves agree about files, modes and ok:false.
    const runner = new PythonRunner({ cwd: ROOT, timeoutMs: 90_000 });
    const error = await runner.run({ ...request, config: { nope: true } })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TaskFailed);
    expect((error as Error).message).toMatch(/validation error/i);
  }, 120_000);
});
