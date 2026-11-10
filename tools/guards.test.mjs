/** Every tree-walking guard skips the same directories.
 *
 *  `SKIP_DIRS` is copied in five files, each with its own `walk`. That duplication is why `.claude`
 *  was missing from ALL FIVE at once: `.claude/worktrees/<agent>` is a checkout of this same
 *  repository on another branch, registered with git and live, and walking into one lints that
 *  branch's code against this branch's rules. On 2026-11-10 a leftover worktree on
 *  `feat/redesign-figures` made `make check` red on a clean main — five guards, one omission.
 *
 *  The real fix is one shared walk. That is a refactor across five files and was not taken while
 *  other branches are in flight, so this is the guard on the duplication instead: a floor every
 *  list must contain, checked against the actual Sets rather than their source text.
 */
import { describe, expect, it } from "vitest";

import { SKIP_DIRS as boundaries } from "./check-boundaries.mjs";
import { SKIP_DIRS as makeTargets } from "./check-make-targets.mjs";
import { SKIP_DIRS as moduleMap } from "./check-module-map.mjs";
import { SKIP_DIRS as seams } from "./check-seams.mjs";
import { SKIP_DIRS as testSupport } from "./check-test-support.mjs";

/** Each guard's list, by the name a failure should print. */
const GUARDS = {
  "check-boundaries": boundaries,
  "check-make-targets": makeTargets,
  "check-module-map": moduleMap,
  "check-seams": seams,
  "check-test-support": testSupport,
};

/** What no guard may walk into, whatever else it skips.
 *
 *  Not the UNION of the five, deliberately: `.out` is in four of them and absent from
 *  `check-module-map`, which walks a narrower tree and has no reason for it. A floor says what
 *  every guard must have; it does not flatten them into one list.
 */
const FLOOR = [
  "node_modules",     // installed code is nobody's source
  "__pycache__",      // generated
  ".venv",            // installed code again
  "dist",             // built output; `frontend/dist` is committed and is not source
  ".claude",          // agent worktrees: this repo, another branch, live
];

describe("the guards' skip lists", () => {
  it("names at least one guard, so the floor below is checked against something", () => {
    expect(Object.keys(GUARDS).length).toBeGreaterThanOrEqual(5);
  });

  for (const [name, list] of Object.entries(GUARDS)) {
    it(`${name} skips every directory on the floor`, () => {
      const missing = FLOOR.filter((dir) => !list.has(dir));
      expect(missing, `${name} would walk into ${missing.join(", ")}`).toEqual([]);
    });
  }

  it("holds `.claude` specifically, which is the one that cost a red main", () => {
    // named on its own rather than trusted to the loop above: the loop would still pass if
    // `.claude` were quietly dropped from FLOOR, and an exemption list that can be shortened from
    // inside is not a rule
    expect(FLOOR).toContain(".claude");
    for (const [name, list] of Object.entries(GUARDS)) {
      expect(list.has(".claude"), `${name} does not skip .claude`).toBe(true);
    }
  });
});
