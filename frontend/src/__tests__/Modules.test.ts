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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** `npm test --workspace frontend` runs from `frontend/`; running the suite from the repo root
 *  runs from there. Both reach the same directory, and a wrong guess must FAIL rather than
 *  silently find nothing to complain about. */
const SRC = ["src", "frontend/src"].map((d) => resolve(process.cwd(), d))
  .find((d) => existsSync(`${d}/columns.ts`))!;

/** every `from "./x"` in a module, as the file name it names */
function imports(file: string): string[] {
  const text = readFileSync(`${SRC}/${file}`, "utf8");
  return [...text.matchAll(/from\s+"\.\/([^"]+)"/g)].map((m) => m[1]!);
}

/** the module a specifier resolves to on disk — `./cells` is `cells.ts` */
function resolved(spec: string): string | null {
  const names = readdirSync(SRC);
  for (const ext of ["", ".ts", ".tsx"]) {
    if (names.includes(spec + ext)) return spec + ext;
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
const PURE = ["columns.ts", "format.ts", "cells.ts", "snapshot.ts", "useTableFit.ts",
  "useDismissOnBack.ts"];

describe("the measuring and formatting path", () => {
  for (const file of PURE) {
    it(`${file} needs no component module`, () => {
      const bad = imports(file)
        .map((spec) => resolved(spec))
        .filter((name): name is string => name !== null && name.endsWith(".tsx"));
      expect(bad).toEqual([]);
    });
  }

  it("has a row-to-text module of its own, which is what makes that possible", () => {
    expect(readdirSync(SRC)).toContain("cells.ts");
  });

  it("keeps the camera off the tree it points at", () => {
    // the hook takes a REF. Importing SnapshotView would make the flow and the picture one
    // module, and the picture is a second tree precisely so it can differ from the screen.
    const named = imports("useSnapshot.ts");
    expect(named).not.toContain("SnapshotView");
    expect(named).not.toContain("App");
  });

  it("no longer passes that function in as an argument to dodge the import", () => {
    // the parameter existed ONLY so `columns.ts` would not have to name `WatchlistTable.tsx`
    expect(readFileSync(`${SRC}/columns.ts`, "utf8")).not.toContain("cellText");
  });
});
