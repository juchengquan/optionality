import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { crossings } from "./check-boundaries.mjs";

/** The guard, against a fixture tree rather than against this repository (ADR 0016).
 *
 *  It had no test at all. Its header said the right check was "add a crossing and watch it fail",
 *  and doing that by hand is precisely what let a hole last its whole life: `python` was named
 *  among the packages while the file pattern admitted only TypeScript, so no Python file was ever
 *  read. A sweep found three separate ways to gut this with every suite green — dropping `.py`,
 *  accepting any path, and never resolving a Python import.
 */
let repo;
const PACKAGES = ["backend", "python"];
const SHARED = ["testdata"];

beforeEach(() => { repo = mkdtempSync(join(tmpdir(), "boundaries-")); });
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function write(path, text) {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}
const found = () => crossings(repo, PACKAGES, SHARED);

describe("what a package may not do", () => {
  it("refuses a TypeScript import that climbs into another package", () => {
    write("backend/src/a.ts", 'import { x } from "../../python/src/y.ts";\n');
    expect(found()).toEqual([expect.stringContaining("leaves backend/")]);
  });

  it("refuses a Python relative import that climbs out of the package", () => {
    // no quotes anywhere, which is why the TypeScript specifier pattern cannot see it
    write("python/tests/t.py", "from ...backend.src import thing\n");
    expect(found()).toEqual([expect.stringContaining("leaves python/")]);
  });

  it("refuses a Python path that lands in another package's source", () => {
    write("python/tests/t.py", 'P = Path(__file__).resolve().parents[2] / "backend" / "src"\n');
    expect(found()).toEqual([expect.stringContaining("another package's source")]);
  });

  it("refuses a TypeScript file URL that reads another package", () => {
    write("backend/src/a.ts", 'const p = new URL("../../python/src/optionality/vol.py", import.meta.url);\n');
    expect(found()).toEqual([expect.stringContaining("another package's source")]);
  });
});

describe("what it must allow, or the repository cannot work", () => {
  it("allows the shared test data, which both suites read by path", () => {
    write("python/tests/t.py", 'CASES = Path(__file__).resolve().parents[2] / "testdata" / "golden"\n');
    write("backend/src/a.ts", 'const f = new URL("../../testdata/zone-abbreviations.json", import.meta.url);\n');
    expect(found()).toEqual([]);
  });

  it("allows a climb to the repository root, which is nobody's source", () => {
    // tools resolve it to print repo-relative names, and check-loads did it for years
    write("backend/tools/t.ts", 'const ROOT = new URL("../..", import.meta.url).pathname;\n');
    expect(found()).toEqual([]);
  });

  it("allows a package's own relative imports and its own deep paths", () => {
    write("python/src/optionality/a.py", "from .b import thing\nfrom ..optionality import other\n");
    write("backend/src/a.ts", 'import { x } from "./sub/y.ts";\n');
    expect(found()).toEqual([]);
  });

  it("allows an absolute import of a package by its published name", () => {
    // `from optionality.position import ...` is a consumer importing the package, which is the point
    write("python/tests/t.py", "from optionality.position import cost_to_close\n");
    expect(found()).toEqual([]);
  });

  it("says nothing about a package that is not there", () => {
    // `frontend` is in the real list and absent from this fixture; a missing directory is not a
    // crossing, and throwing on one would make the guard fail in a partial checkout
    expect(crossings(repo, ["backend", "python", "frontend"], SHARED)).toEqual([]);
  });
});

describe("the files it reads", () => {
  it("reads Python as well as TypeScript, which is the hole it shipped with", () => {
    write("python/tests/t.py", "from ...backend.src import thing\n");
    write("backend/src/a.ts", 'import { x } from "../../python/src/y.ts";\n');
    expect(found()).toHaveLength(2);
  });

  it("ignores a file that is neither", () => {
    // a README quoting a bad import is documentation, not a dependency
    write("python/README.md", 'from ...backend.src import thing\nparents[2] / "backend" / "src"\n');
    expect(found()).toEqual([]);
  });
});
