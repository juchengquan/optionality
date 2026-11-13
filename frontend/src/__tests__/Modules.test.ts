/** Which modules are allowed to need which.
 *
 *  Not style. The old page's column fitting (ADR 0008) reached its row-to-text function by
 *  importing a table component, which pulled a React tree's worth of module onto the hottest path
 *  on the page — every poll and every resize — to call one `switch`. That page and its fitting went
 *  with the swap (#301); the claim stays for the shared modules the page reads on the same path: the
 *  formatting, the snapshot's arithmetic and the preferences need no component module.
 *
 *  `backend` has `tools/check-boundaries.mjs` for the same question between packages; this is the
 *  same claim one level down, inside the frontend, and it is asserted rather than hoped for.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** `npm test --workspace frontend` runs from `frontend/`; running the suite from the repo root
 *  runs from there. Both reach the same directory, and a wrong guess must FAIL rather than
 *  silently find nothing to complain about. */
const SRC = ["src", "frontend/src"].map((d) => resolve(process.cwd(), d))
  .find((d) => existsSync(`${d}/shared/prefs.ts`))!;

/** every relative `from "..."` in a module (a path under `src/`), as the module it names, also
 *  under `src/` — `./format` in `shared/prefs.ts` is `shared/format`, so a name is a path rather
 *  than a bare file name. */
function imports(file: string): string[] {
  const text = readFileSync(`${SRC}/${file}`, "utf8");
  return [...text.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)]
    .map((m) => posix.join(dirname(file), m[1]!));
}

/** the module a path resolves to on disk — `shared/format` is `shared/format.ts` */
function resolved(spec: string): string | null {
  for (const ext of ["", ".ts", ".tsx"]) {
    if (existsSync(`${SRC}/${spec}${ext}`) && /\.\w+$/.test(spec + ext)) return spec + ext;
  }
  return null;
}

/** The modules that may not reach a component: pure data, measuring and formatting, plus the hook
 *  that runs React's machinery without rendering anything. */
const PURE = ["shared/format.ts", "shared/snapshot.ts", "shared/useDismissOnBack.ts",
  "shared/prefs.ts", "shared/groups.ts"];

describe("the measuring and formatting path", () => {
  for (const file of PURE) {
    it(`${file} needs no component module`, () => {
      const bad = imports(file)
        .map((spec) => resolved(spec))
        .filter((name): name is string => name !== null && name.endsWith(".tsx"));
      expect(bad).toEqual([]);
    });
  }
});

/** What the browser remembers.
 *
 *  The preferences were once written by hand where they were used — four of them in the old page's
 *  `columns.ts`, the poll cadence inline in its `App.tsx` with no test at all — and each copy of the
 *  attribute string was a chance to drop a `max-age`. Asserted structurally because that is where it
 *  can be asserted: a preference added the old way would round-trip perfectly in its own test and
 *  still be a second copy.
 */
describe("the viewer's preferences", () => {
  it("reach the cookie through one pair of functions", () => {
    // the plumbing itself: one reader, one writer, and every preference on top of them
    const text = readFileSync(`${SRC}/shared/prefs.ts`, "utf8");
    expect(text.match(/document\.cookie/g)).toHaveLength(2);
  });
});
