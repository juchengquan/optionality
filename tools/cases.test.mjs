import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** That `make check-cases` actually guards BOTH stamps (ADR 0016).
 *
 *  A sweep found it guarding neither claim that matters: deleting the Python stamp from the
 *  generator's output list left every suite green, because `--check` only inspects what the list
 *  names. The stamps are the one thing in this repository that is generated into two packages at
 *  once, so the check that they are current is worth a test of its own.
 *
 *  It runs the real generator as a subprocess — nothing else proves what `make check-cases` does —
 *  but into a temporary tree, via `--root`. It used to run it against THIS tree, and that was a
 *  hole rather than a shortcut: `make check` runs `test-tools` two targets after `check-cases`,
 *  so a stale corpus was reported and then silently repaired, leaving `cases.test.ts` — "holds
 *  exactly what the TypeScript computes now" — unable to fail inside the gate that runs it. It
 *  also left five regenerated files in the working tree that nobody had authored, which is how
 *  somebody commits golden cases they never looked at.
 */
const ROOT = new URL("..", import.meta.url).pathname;
const STAMPS = ["typescript/src/golden.ts", "python/src/optionality/_ported.py"];
const A_CASE_FILE = "testdata/golden/alarm.json";
/** One of the IB Gateway expectations (ADR 0021, Decision 7): generated in the same pass, into
 *  its own directory, from recordings the generator READS from this repository. */
const AN_EXPECTATION = "testdata/vendors/ibkr-gateway/expected/link-down.json";

let tree;

beforeEach(() => { tree = mkdtempSync(join(tmpdir(), "golden-")); });
afterEach(() => rmSync(tree, { recursive: true, force: true }));

/** TZ=UTC, exactly as the Makefile runs it: a default zone is the running machine's, so an
 *  unpinned corpus would say `+08:00` here and `+01:00` in Berlin (CLAUDE.md). */
const run = (...args) =>
  execFileSync("node", ["tools/cases.ts", "--root", tree, ...args], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, TZ: "UTC" },
  });
const regenerate = () => run();
const inTree = (path) => readFileSync(join(tree, path), "utf8");

describe("make check-cases", () => {
  it("passes on a tree that was just generated", () => {
    regenerate();
    expect(run("--check")).toContain("match the TypeScript");
  });

  it("fails when a golden file is missing, not only when one is wrong", () => {
    regenerate();
    unlinkSync(join(tree, A_CASE_FILE));
    expect(() => run("--check")).toThrow(/stale golden cases: alarm\.json/);
  });

  it("fails when an IB Gateway expectation is stale, and when one has no recording", () => {
    // the replayed batches are a third corpus with a third loop in the generator, and a loop that
    // wrote but never compared would leave `--check` green over any edit to a recording
    regenerate();
    const path = join(tree, AN_EXPECTATION);
    writeFileSync(path, inTree(AN_EXPECTATION).replace("answered none", "answered one"));
    expect(() => run("--check"))
      .toThrow(/stale golden cases:.*ibkr-gateway\/expected\/link-down\.json/);
    regenerate();
    const orphan = "testdata/vendors/ibkr-gateway/expected/nobody-recorded-this.json";
    writeFileSync(join(tree, orphan), "{}\n");
    expect(() => run("--check")).toThrow(/nobody-recorded-this\.json \(no recording\)/);
    // four runs of the generator, each replaying every conversation over a loopback socket
  }, 30_000);

  for (const stamp of STAMPS) {
    it(`fails when ${stamp} does not match the cases`, () => {
      regenerate();
      // the shape stays valid — a hand-edited hash, which is the realistic way either of these
      // goes wrong: `check-cases` compares, it does not repair
      const path = join(tree, stamp);
      writeFileSync(path, readFileSync(path, "utf8").replace(/"[0-9a-f]{12}"/, '"000000000000"'));
      expect(() => run("--check")).toThrow(new RegExp(`stale golden cases:.*${stamp}`));
    });
  }

  it("writes the same hash into both, so they cannot disagree", () => {
    regenerate();
    const hashes = STAMPS.map((s) => /"([0-9a-f]{12})"/.exec(inTree(s))[1]);
    expect(hashes[0]).toBe(hashes[1]);
    // and it is the hash the generator reports, so the number in the log is the number on disk
    expect(run("--check")).toContain(hashes[0]);
  });

  it("writes where it was told to and leaves this repository alone", () => {
    // The reason `--root` exists. Running the generator is the only honest way to test it, and a
    // test that repairs the corpus defeats the check it is testing — so this asserts the
    // separation itself rather than trusting the option.
    const committed = [A_CASE_FILE, AN_EXPECTATION, ...STAMPS];
    const digest = (path) => createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex");
    const before = committed.map(digest);
    regenerate();
    expect(committed.map(digest), "the generator wrote into this repository").toEqual(before);
    // and it really did write, so the comparison above is not vacuous
    expect(inTree(A_CASE_FILE).length).toBeGreaterThan(0);
    expect(inTree(AN_EXPECTATION)).toContain('"$throws"');
    for (const stamp of STAMPS) expect(inTree(stamp)).toMatch(/[0-9a-f]{12}/);
  });
});
