/** Which modules are allowed to need which.
 *
 *  Not style. The column fitting (ADR 0008) is pure arithmetic over rows and a character width,
 *  and it is the hottest path on the page — it runs on every poll, for both tables, and again
 *  on every resize. It reached its row-to-text function by importing `WatchlistTable.tsx`, a
 *  component module, which meant the measuring path pulled a React tree's worth of module in to
 *  call one `switch`. `columns.ts` worked around that by taking the function as an ARGUMENT, so
 *  the dodge was visible in the signature and every caller had to carry it.
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
  .find((d) => existsSync(`${d}/shared/columns.ts`))!;

/** every relative `from "..."` in a module (a path under `src/`), as the module it names, also
 *  under `src/` — `./cells` in `shared/columns.ts` is `shared/cells`. Both pages' shared modules
 *  live in `shared/` since #337, so a name is a path rather than a bare file name. */
function imports(file: string): string[] {
  const text = readFileSync(`${SRC}/${file}`, "utf8");
  return [...text.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)]
    .map((m) => posix.join(dirname(file), m[1]!));
}

/** the module a path resolves to on disk — `shared/cells` is `shared/cells.ts` */
function resolved(spec: string): string | null {
  for (const ext of ["", ".ts", ".tsx"]) {
    if (existsSync(`${SRC}/${spec}${ext}`) && /\.\w+$/.test(spec + ext)) return spec + ext;
  }
  return null;
}

/** The modules that may not reach a component: pure data, measuring and formatting, plus the two
 *  hooks that run React's machinery without rendering anything.
 *
 *  `useSnapshot.ts` is deliberately NOT here. It owns the press that saves the page as an image,
 *  and that includes the rule the feature was twice bitten by — a press must never answer with
 *  silence — so it reaches the toast store, which lives in a component module. What it must not
 *  do is name the TREE it photographs, and that has a claim of its own below.
 */
const PURE = ["shared/columns.ts", "shared/format.ts", "shared/cells.ts", "shared/snapshot.ts",
  "useTableFit.ts", "shared/useDismissOnBack.ts", "shared/prefs.ts"];

describe("the measuring and formatting path", () => {
  for (const file of PURE) {
    it(`${file} needs no component module`, () => {
      const bad = imports(file)
        .map((spec) => resolved(spec))
        .filter((name): name is string => name !== null && name.endsWith(".tsx"));
      expect(bad).toEqual([]);
    });
  }

  it("keeps the camera off the tree it points at", () => {
    // the hook takes a REF. Importing SnapshotView would make the flow and the picture one
    // module, and the picture is a second tree precisely so it can differ from the screen.
    const named = imports("useSnapshot.ts");
    expect(named).not.toContain("SnapshotView");
    expect(named).not.toContain("App");
    expect(named).toContain("shared/snapshot"); // the reader still reads: a dead pattern passes the two above
  });

  it("reaches its row-to-text helpers by importing them, not by being handed them", () => {
    // The parameter existed ONLY so `columns.ts` would not have to name `WatchlistTable.tsx`, and
    // it is gone twice over now: a column's text sits on the column, and what is left of the
    // row-reading is imported from `cells.ts` directly.
    //
    // This read `not.toContain("cellText")`, which could not fail — the function had been called
    // `cellValue` for two releases, and the only occurrence of "cellText" in the repository was
    // this assertion, so reintroducing the dodge under the real name would have passed.
    expect(imports("shared/columns.ts")).toContain("shared/cells");
  });
});

/** The second half of what `columns.ts` was: what the browser remembers.
 *
 *  Four of the six preferences were read and written in that module, between the column
 *  definitions and the fitting arithmetic, for one reason — two of them happen to be ABOUT
 *  columns. The other two (the signal and its band) were only there for company, and the
 *  sixth, the poll cadence, sat inline in `App.tsx` and so had no test at all. Written out
 *  five times, the attribute string was five chances to drop a `max-age`.
 *
 *  Asserted structurally because that is where it can be asserted: a seventh preference added
 *  the old way would round-trip perfectly in its own test and still be the sixth copy.
 */
describe("the viewer's preferences", () => {
  // "live in a module of their own" was a `readdirSync(SRC)).toContain("prefs.ts")` and has gone,
  // as the same check for `cells.ts` did: every other claim below reads that file, so a module that
  // vanished would fail them — and fail collection in the PURE loop above — before this noticed.
  for (const file of ["shared/columns.ts", "App.tsx"]) {
    it(`are no longer spelled out in ${file}`, () => {
      expect(readFileSync(`${SRC}/${file}`, "utf8")).not.toContain("document.cookie");
    });
  }

  it("reach the cookie through one pair of functions", () => {
    // the plumbing itself: one reader, one writer, and every preference on top of them
    const text = readFileSync(`${SRC}/shared/prefs.ts`, "utf8");
    expect(text.match(/document\.cookie/g)).toHaveLength(2);
  });
});
