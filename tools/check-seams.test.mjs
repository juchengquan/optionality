import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SEAMS, breaches, walk } from "./check-seams.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/** The guard, against a fixture tree rather than against this repository — the arrangement
 *  `check-boundaries.test.mjs` and `check-test-support.test.mjs` arrived at, and for their reason:
 *  "add a crossing and watch it fail" is the right check, and doing it by hand is what lets a hole
 *  last. A sweep of the first found three ways to gut it with every suite green.
 */
let repo;

beforeEach(() => { repo = mkdtempSync(join(tmpdir(), "seams-")); });
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function write(path, text) {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

/** One seam, shaped like the real one but under names that say nothing about it: the rule is about
 *  a DIRECTORY with a door, not about vendors. */
const SEAM = [{ dir: "pkg/src/things", doors: ["index.ts"], why: "one door" }];
/** Just the lines: `breaches` returns `{ seam, line }` so the runner can print the right
 *  reason, and every assertion here is about the line. */
const lines = (seams = SEAM) => breaches(repo, seams).map((b) => b.line);
const found = () => lines();

describe("a seam's interior is private", () => {
  it("refuses a reach past the door", () => {
    write("pkg/src/things/index.ts", "export const open = () => {};\n");
    write("pkg/src/things/one/client.ts", "export const c = 1;\n");
    write("pkg/src/caller.ts", 'import { c } from "./things/one/client.ts";\n');
    expect(found()).toEqual([expect.stringContaining("pkg/src/caller.ts")]);
  });

  it("names what was reached for and where the door is", () => {
    write("pkg/src/things/index.ts", "export const open = () => {};\n");
    write("pkg/src/things/one/client.ts", "export const c = 1;\n");
    write("pkg/src/caller.ts", 'import { c } from "./things/one/client.ts";\n');
    expect(found()[0]).toMatch(/things\/one\/client\.ts is inside pkg\/src\/things\/.*index\.ts/);
  });

  it("allows the door itself, which is the point of having one", () => {
    write("pkg/src/things/index.ts", "export const open = () => {};\n");
    write("pkg/src/caller.ts", 'import { open } from "./things/index.ts";\n');
    expect(found()).toEqual([]);
  });

  it("allows the interior to import itself", () => {
    write("pkg/src/things/index.ts", 'import { c } from "./one/client.ts";\n');
    write("pkg/src/things/one/client.ts", 'import { w } from "../wire.ts";\n');
    write("pkg/src/things/wire.ts", "export const w = 1;\n");
    expect(found()).toEqual([]);
  });

  it("allows the interior to reach back out, which is not what this guards", () => {
    // a vendor's client importing `../../quotes.ts` is the port it implements, not a bypass
    write("pkg/src/things/one/client.ts", 'import { q } from "../../quotes.ts";\n');
    write("pkg/src/quotes.ts", "export const q = 1;\n");
    expect(found()).toEqual([]);
  });

  it("sees a dynamic import too, which is how a bypass would hide", () => {
    write("pkg/src/things/index.ts", "export const open = () => {};\n");
    write("pkg/src/things/one/client.ts", "export const c = 1;\n");
    write("pkg/src/caller.ts", 'const c = await import("./things/one/client.ts");\n');
    expect(found()).toEqual([expect.stringContaining("pkg/src/caller.ts")]);
  });

  it("refuses a TEST that reaches past the door as well", () => {
    // deliberately NOT exempt, unlike check-test-support's rule: a suite that drives a client
    // directly is how the seam stops being the only way in, and the vendor suites do not need to
    write("pkg/src/things/index.ts", "export const open = () => {};\n");
    write("pkg/src/things/one/client.ts", "export const c = 1;\n");
    write("pkg/src/caller.test.ts", 'import { c } from "./things/one/client.ts";\n');
    expect(found()).toEqual([expect.stringContaining("pkg/src/caller.test.ts")]);
  });

  it("honours a second declared door, and only the one declared", () => {
    const seam = [{ dir: "pkg/src/things", doors: ["index.ts", "one/fake.ts"], why: "two doors" }];
    write("pkg/src/things/one/fake.ts", "export const f = 1;\n");
    write("pkg/src/things/one/client.ts", "export const c = 1;\n");
    write("pkg/src/a.ts", 'import { f } from "./things/one/fake.ts";\n');
    write("pkg/src/b.ts", 'import { c } from "./things/one/client.ts";\n');
    expect(lines(seam)).toEqual([expect.stringContaining("pkg/src/b.ts")]);
  });

  it("is quiet about a package specifier, which is check-boundaries' business", () => {
    write("pkg/src/caller.ts", 'import { x } from "backend/schemas";\n');
    expect(found()).toEqual([]);
  });

  it("is quiet where the seam does not exist at all", () => {
    write("pkg/src/caller.ts", 'import { x } from "./x.ts";\n');
    write("pkg/src/x.ts", "export const x = 1;\n");
    expect(found()).toEqual([]);
  });
});

describe("a door the seam itself forbids", () => {
  it("is a breach, so the rule cannot be relaxed by relaxing the rule", () => {
    // the mutation that found this: adding "one/client.ts" to the door list passed every test
    // here, because the fixtures declare their own seam and nothing looked at the list itself
    const seam = [{
      dir: "pkg/src/things", doors: ["index.ts", "one/client.ts"],
      never: /\/client\.ts$/, why: "one door",
    }];
    write("pkg/src/things/index.ts", "export const open = () => {};\n");
    write("pkg/src/things/one/client.ts", "export const c = 1;\n");
    expect(lines(seam)).toEqual([
      expect.stringContaining('"one/client.ts" is named as a door'),
    ]);
  });

  it("says nothing when every door is allowed", () => {
    const seam = [{
      dir: "pkg/src/things", doors: ["index.ts", "one/fake.ts"],
      never: /\/client\.ts$/, why: "two doors",
    }];
    write("pkg/src/things/index.ts", "export const open = () => {};\n");
    write("pkg/src/things/one/fake.ts", "export const f = 1;\n");
    expect(lines(seam)).toEqual([]);
  });
});

describe("who may knock", () => {
  const seam = () => [{
    dir: "pkg/src/things", doors: ["index.ts"], importableBy: ["pkg/src/main.ts"],
    never: /\/client\.ts$/, why: "one caller",
  }];

  it("allows the declared caller through the door", () => {
    write("pkg/src/things/index.ts", "export const open = () => {};\n");
    write("pkg/src/main.ts", 'import { open } from "./things/index.ts";\n');
    expect(lines(seam())).toEqual([]);
  });

  it("refuses anybody else, even at the door", () => {
    // the whole point of the field: the file is the right one, the CALLER is not. A service that
    // could import a delivery surface is a library that depends on delivery (ADR 0020).
    write("pkg/src/things/index.ts", "export const open = () => {};\n");
    write("pkg/src/service.ts", 'import { open } from "./things/index.ts";\n');
    expect(lines(seam())).toEqual([
      expect.stringContaining("pkg/src/service.ts: imports \"./things/index.ts\""),
    ]);
  });

  it("says who the seam IS reached by, so the message is actionable", () => {
    write("pkg/src/things/index.ts", "export const open = () => {};\n");
    write("pkg/src/service.ts", 'import { open } from "./things/index.ts";\n');
    expect(lines(seam())[0]).toMatch(/reached only by pkg\/src\/main\.ts/);
  });

  it("lets anyone through when the field is absent, which is the other three seams", () => {
    const open = [{ dir: "pkg/src/things", doors: ["index.ts"], never: /\/x$/, why: "any" }];
    write("pkg/src/things/index.ts", "export const open = () => {};\n");
    write("pkg/src/service.ts", 'import { open } from "./things/index.ts";\n');
    expect(lines(open)).toEqual([]);
  });

  it("still refuses a reach PAST the door from a declared caller", () => {
    // `importableBy` widens nothing: the door rule and the caller rule both apply
    write("pkg/src/things/index.ts", "export const open = () => {};\n");
    write("pkg/src/things/deep.ts", "export const d = 1;\n");
    write("pkg/src/main.ts", 'import { d } from "./things/deep.ts";\n');
    expect(lines(seam())).toEqual([expect.stringContaining("is inside pkg/src/things/")]);
  });
});

describe("the seams this repository declares", () => {
  it("names a door for every seam, and gives a reason", () => {
    // a seam with no `why` prints nothing when it fails, which is how a guard gets deleted
    for (const seam of SEAMS) {
      expect(seam.doors.length, `${seam.dir} has no door`).toBeGreaterThan(0);
      expect(seam.why, `${seam.dir} has no reason`).toBeTruthy();
      expect(seam.never, `${seam.dir} says nothing about what may not be a door`).toBeTruthy();
    }
    expect(SEAMS.length).toBeGreaterThan(0);
  });

  it("keeps SweepHealth behind the engine's door, which is what that seam is FOR", async () => {
    // #230's mutation M7: `sweeper: new SweepHealth({...})` in main.ts typechecked and passed all
    // 143 route, app and boot tests, and described a service whose /health says "starting" for
    // ever while the sweeps run. Catching it needed a boot test that sweeps, which needs a fake
    // provider in production code. Withholding the class closes it instead — but only while the
    // door keeps withholding it, which is this test.
    const door = await import("../backend/src/engine/index.ts");
    expect(Object.keys(door), "the engine's door exports SweepHealth again — M7 is reopened")
      .not.toContain("SweepHealth");
    // and it still hands out what main.ts actually needs, so this is not passing by exporting nothing
    for (const name of ["MonitorSweeper", "Scheduler", "STALE_AFTER_SWEEPS"]) {
      expect(Object.keys(door), `the engine's door no longer exports ${name}`).toContain(name);
    }
  });

  it("keeps the two main-only seams main-only, which deleting a field would not", () => {
    // Found by a mutation sweep: removing `importableBy` from the entrypoints seam altogether
    // passed all 21 tests, because "unset means anyone may" is a legitimate state for the other
    // seams. Same shape as #235's finding that WIDENING the door list passed everything — an
    // exemption that can be deleted from the inside is not a rule. Both seams claim main-only in
    // their own `why`; this is what holds them to it.
    for (const dir of ["backend/src/entrypoints", "backend/src/engine"]) {
      const seam = SEAMS.find((x) => x.dir === dir);
      expect(seam, `${dir} is no longer a declared seam`).toBeTruthy();
      expect(seam.importableBy, `${dir} no longer says who may knock`).toBeTruthy();
      expect(seam.importableBy, `${dir} is no longer reached by main.ts`)
        .toContain("backend/src/main.ts");
      // and no delivery surface or library module has been quietly added to the list: the only
      // other callers allowed are test support and this guard's own suite
      const extra = seam.importableBy.filter((f) => f !== "backend/src/main.ts");
      expect(extra.filter((f) => !/(^|\/)(testing|tools)\//.test(f)),
        `${dir} admits a caller that is neither main.ts nor test support`).toEqual([]);
    }
  });

  it("declares a door for every surface in entrypoints/, so a new one cannot arrive unguarded", () => {
    // ADR 0020's reason for putting the rule on `entrypoints/` rather than on each surface: a
    // third entrypoint — a CLI, a worker — added with no `SEAMS` line would be unguarded until
    // somebody remembered. That is exactly `hc.types.ts`'s "complete by diligence" failure, which
    // was true for sixteen endpoints and held by nobody. This closes it before it happens.
    const seam = SEAMS.find((x) => x.dir === "backend/src/entrypoints");
    expect(seam, "the entrypoints seam is gone").toBeTruthy();
    const dir = join(ROOT, seam.dir);
    const surfaces = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const undoored = surfaces
      .filter((name) => !seam.doors.some((d) => d.startsWith(`${name}/`)));
    expect(undoored, "an entrypoint with no door in SEAMS — add one, with its reason")
      .toEqual([]);
    expect(surfaces.length, "entrypoints/ holds no surfaces at all").toBeGreaterThanOrEqual(2);
  });

  it("has a `never` that actually matches something in the tree it guards", () => {
    // the half a filter can fail silently: a pattern matching NOTHING forbids nothing, and would
    // pass the test above while leaving every door open. This is cases.test.ts's lesson — the
    // coverage guard that filtered on `typeof v === "function"` and quietly compared nothing.
    for (const seam of SEAMS) {
      const inTree = walk(join(ROOT, seam.dir)).map((f) => relative(join(ROOT, seam.dir), f));
      const forbidden = inTree.filter((f) => seam.never.test(`/${f}`));
      expect(forbidden.length, `${seam.dir}: ${seam.never} matches no file there`)
        .toBeGreaterThan(0);
      // and what it forbids is not already a door
      expect(forbidden.filter((f) => seam.doors.includes(f))).toEqual([]);
    }
  });
});
