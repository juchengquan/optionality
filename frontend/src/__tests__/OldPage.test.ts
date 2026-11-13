/** What #301 deletes when `/opt` swaps to the new page (ADR 0023), stated as lists and held to the
 *  import graph, so the deletion is mechanical and checked rather than worked out again on the day.
 *
 *  - `OLD_PAGE`: today's page — every module at the top of `src/` except `vite-env.d.ts`, which
 *    `shared/api.ts` needs for `import.meta.env`. Nothing `/opt/next` runs, nothing in `shared/`,
 *    `testing/` or `components/` may reach one.
 *  - `OLD_PAGE_TESTS`: the tests that reach one, and so go with it. Everything else under
 *    `__tests__/` and `__browser__/` stays: the `Next*` suites and the shared modules' own.
 *  - `TRIM`: tests that stay but NAME an old-page file by path, which a deletion breaks.
 *
 *  A new test of the old page, or a shared module that starts leaning on it, fails here first.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = ["src", "frontend/src"].map((d) => resolve(process.cwd(), d))
  .find((d) => existsSync(`${d}/shared/api.ts`))!;

const OLD_PAGE = [
  "AddForms.tsx", "AddPanel.tsx", "App.tsx", "Holdings.tsx", "MutedTables.tsx", "OpenedField.tsx",
  "PaceLine.tsx", "RowActions.tsx", "RowDetail.tsx", "ServicePanel.tsx", "SnapshotView.tsx",
  "TopLine.tsx", "WatchlistTable.tsx", "main.tsx", "useSnapshot.ts", "useTableFit.ts",
];

const OLD_PAGE_TESTS = [
  "__browser__/AddCombo.test.tsx", "__browser__/Bands.test.tsx", "__browser__/Chrome.test.tsx",
  "__browser__/Fitting.test.tsx", "__browser__/Grouping.test.tsx", "__browser__/Holdings.test.tsx",
  "__browser__/LegBadge.test.tsx", "__browser__/OpenedField.test.tsx", "__browser__/Palette.test.tsx",
  "__browser__/PollWhileOpen.test.tsx", "__browser__/Rasterize.test.tsx",
  "__browser__/References.test.tsx", "__browser__/SheetLayout.test.tsx",
  "__browser__/Snapshot.test.tsx", "__browser__/Sticky.test.tsx",
  "__tests__/AddForms.test.tsx", "__tests__/App.test.tsx", "__tests__/BackButton.test.tsx",
  "__tests__/Clock.test.tsx", "__tests__/Columns.test.tsx", "__tests__/ExitSchedule.test.tsx",
  "__tests__/GroupedTable.test.tsx", "__tests__/HoldingList.test.tsx", "__tests__/Holdings.test.tsx",
  "__tests__/Interval.test.tsx", "__tests__/LegBadge.test.tsx", "__tests__/Mutations.test.tsx",
  "__tests__/Muted.test.tsx", "__tests__/Opened.test.tsx", "__tests__/PageChrome.test.tsx",
  "__tests__/PollGuard.test.tsx", "__tests__/RecordHolding.test.tsx",
  "__tests__/References.test.tsx", "__tests__/Refresh.test.tsx", "__tests__/RowDetail.test.tsx",
  "__tests__/ScreenUpdated.test.tsx", "__tests__/ServicePanel.test.tsx",
  "__tests__/SignalSetting.test.tsx", "__tests__/SlowReferences.test.tsx",
  "__tests__/Snapshot.test.tsx", "__tests__/TopLine.test.tsx", "__tests__/UseSnapshot.test.tsx",
  "__tests__/Wipe.test.tsx",
];

/** `Modules.test.ts` reads `App.tsx`, `useTableFit.ts` and `useSnapshot.ts` as text: its claims about
 *  them go with them, and its claims about `shared/` stay. This file names them all, and #301
 *  deletes it once the lists above are empty. */
const TRIM = ["__tests__/Modules.test.ts", "__tests__/OldPage.test.ts"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(path);
  }
  return out;
}

/** every relative module a file imports, as a path */
function deps(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)].flatMap((m) => {
    const base = resolve(dirname(file), m[1]!);
    const hit = ["", ".ts", ".tsx", ".css"].map((e) => base + e)
      .find((p) => existsSync(p) && statSync(p).isFile());
    return hit ? [hit] : [];
  });
}

function reaches(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const d of deps(file)) reaches(d, seen);
  return seen;
}

const old = new Set(OLD_PAGE.map((f) => join(SRC, f)));
const touchesOld = (file: string) => [...reaches(file)].some((f) => old.has(f));
const rel = (f: string) => relative(SRC, f);
const tests = () => walk(SRC).filter((f) => /(^|\/)__(tests|browser)__\//.test(rel(f)));

describe("what the swap (#301) deletes", () => {
  it("is every module at the top of src/ but vite-env.d.ts", () => {
    const top = readdirSync(SRC).filter((n) => /\.tsx?$/.test(n) && n !== "vite-env.d.ts").sort();
    expect(top).toEqual([...OLD_PAGE].sort());
  });

  it("is reached by nothing that stays", () => {
    const staying = ["next", "shared", "testing", "components"].flatMap((d) => walk(join(SRC, d)));
    expect(staying.filter(touchesOld).map(rel)).toEqual([]);
  });

  it("takes exactly these tests with it", () => {
    expect(tests().filter(touchesOld).map(rel).sort()).toEqual([...OLD_PAGE_TESTS].sort());
  });

  it("leaves only these tests naming an old-page file", () => {
    const named = new RegExp(`"(${OLD_PAGE.map((f) => f.replace(".", "\\.")).join("|")})"`);
    const naming = tests().filter((f) => !OLD_PAGE_TESTS.includes(rel(f)))
      .filter((f) => named.test(readFileSync(f, "utf8"))).map(rel).sort();
    expect(naming).toEqual([...TRIM].sort());
  });
});
