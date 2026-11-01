import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

/** That `make check-cases` actually guards BOTH stamps (ADR 0016).
 *
 *  A sweep found it guarding neither claim that matters: deleting the Python stamp from the
 *  generator's output list left every suite green, because `--check` only inspects what the list
 *  names. The stamps are the one thing in this repository that is generated into two packages at
 *  once, so the check that they are current is worth a test of its own.
 *
 *  It runs the real generator as a subprocess, against the real tree, and puts back what it moved.
 */
const ROOT = new URL("..", import.meta.url).pathname;
const STAMPS = ["backend/src/golden.ts", "python/src/optionality/_ported.py"];

/** TZ=UTC, exactly as the Makefile runs it. Without it this test regenerated the corpus in the
 *  MACHINE's zone and left it there — and the backend suite, which pins UTC, then read its own
 *  shared ground as stale. `make check` runs test-tools before test-api, so the failure landed two
 *  targets away from its cause. */
const run = (...args) =>
  execFileSync("node", ["tools/cases.ts", ...args], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, TZ: "UTC" },
  });
const regenerate = () => run();

afterEach(regenerate);

describe("make check-cases", () => {
  it("passes on a tree that was just generated", () => {
    regenerate();
    expect(run("--check")).toContain("match the TypeScript");
  });

  for (const stamp of STAMPS) {
    it(`fails when ${stamp} does not match the cases`, () => {
      const path = `${ROOT}${stamp}`;
      const original = readFileSync(path, "utf8");
      // the shape stays valid — a hand-edited hash, which is the realistic way either of these
      // goes wrong: `check-cases` compares, it does not repair
      writeFileSync(path, original.replace(/"[0-9a-f]{12}"/, '"000000000000"'));
      try {
        expect(() => run("--check")).toThrow(/stale/);
      } finally {
        writeFileSync(path, original);
      }
    });
  }

  it("writes the same hash into both, so they cannot disagree", () => {
    regenerate();
    const hashes = STAMPS.map((s) => /"([0-9a-f]{12})"/.exec(readFileSync(`${ROOT}${s}`, "utf8"))[1]);
    expect(hashes[0]).toBe(hashes[1]);
    // and it is the hash the generator reports, so the number in the log is the number on disk
    expect(run("--check")).toContain(hashes[0]);
  });
});
