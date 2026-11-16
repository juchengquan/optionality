import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEPENDS, PACKAGES as REAL_PACKAGES, SHARED as REAL_SHARED, crossings,
} from "./check-boundaries.mjs";

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

describe("the other spellings of the same reach", () => {
  it("refuses a dynamic import written as a template literal", () => {
    write("backend/src/a.ts", "const m = await import(`../../python/src/y.ts`);\n");
    expect(found()).toEqual([expect.stringContaining("leaves backend/")]);
  });

  it("refuses a Python path climbed by .parent rather than parents[n]", () => {
    write("python/tests/t.py", 'P = Path(__file__).resolve().parent.parent.parent / "backend" / "src"\n');
    expect(found()).toEqual([expect.stringContaining("another package's source")]);
  });

  it("refuses a path joined onto import.meta.dirname or __dirname", () => {
    write("backend/src/a.ts", 'const p = join(import.meta.dirname, "../../python/src/x.py");\n');
    write("backend/src/b.ts", 'const p = resolve(__dirname, "..", "..", "python", "src");\n');
    expect(found()).toEqual([
      expect.stringContaining("backend/src/a.ts"), expect.stringContaining("backend/src/b.ts"),
    ]);
  });

  it("refuses a path built in a template literal from import.meta.dirname", () => {
    write("backend/src/a.ts", "const t = readFileSync(`${import.meta.dirname}/../../python/src/x.py`);\n");
    write("backend/src/b.ts", 'const t = import.meta.dirname + "/../../python/src/x.py";\n');
    expect(found()).toEqual([
      expect.stringContaining("backend/src/a.ts"), expect.stringContaining("backend/src/b.ts"),
    ]);
  });

  it("refuses a file URL written with single quotes or backticks", () => {
    write("backend/src/a.ts", "const p = new URL('../../python/src/x.py', import.meta.url);\n");
    write("backend/src/b.ts", "const p = new URL(`../../python/src/x.py`, import.meta.url);\n");
    expect(found()).toEqual([
      expect.stringContaining("backend/src/a.ts"), expect.stringContaining("backend/src/b.ts"),
    ]);
  });

  // #422's review: what the first round still let through
  it("refuses a directory held in a variable, then joined into another package", () => {
    write("backend/src/a.ts", [
      'import { fileURLToPath } from "node:url";',
      "const here = dirname(fileURLToPath(import.meta.url));",
      'readFileSync(join(here, "../../python/src/x.py"));', "",
    ].join("\n"));
    write("backend/src/b.ts", [
      'const ROOT = join(import.meta.dirname, "../..");',
      'readFileSync(join(ROOT, "python/src/x.py"));', "",
    ].join("\n"));
    write("backend/src/c.ts", 'const p = "python/src/x.py";\nreadFileSync(join(import.meta.dirname, "../..", p));\n');
    expect(found()).toEqual([
      expect.stringContaining("backend/src/a.ts"), expect.stringContaining("backend/src/b.ts"),
      expect.stringContaining("backend/src/c.ts"),
    ]);
  });

  it("refuses require() and import.meta.resolve() into another package", () => {
    write("backend/src/a.ts", 'const x = require("../../python/src/x.py");\n');
    write("backend/src/b.ts", 'const u = import.meta.resolve("../../python/src/x.py");\n');
    expect(found()).toEqual([
      expect.stringContaining("backend/src/a.ts"), expect.stringContaining("backend/src/b.ts"),
    ]);
  });

  it("refuses the Python's joinpath, single quotes and os.path spellings", () => {
    write("python/tests/a.py", 'R = Path(__file__).resolve().parent.parent.parent.joinpath("backend", "src")\n');
    write("python/tests/b.py", 'P = os.path.join(os.path.dirname(__file__), "..", "..", "backend", "src")\n');
    write("python/tests/c.py", 'P = Path(__file__).parents[2].joinpath("backend/src")\n');
    write("python/tests/d.py", "P = Path(__file__).parent.parent.parent / 'backend' / 'src'\n");
    write("python/tests/e.py", 'P = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../backend")\n');
    expect(found()).toEqual(["a", "b", "c", "d", "e"].map((f) => expect.stringContaining(`python/tests/${f}.py`)));
  });

  it("stays quiet where a joined name cannot be read, and where a held directory stays home", () => {
    // gateway.test.ts's own shape: the root held in a variable, joined with an IMPORTED name
    write("backend/src/a.ts", [
      'import { CASES } from "./cases.ts";',
      'const ROOT = join(import.meta.dirname, "../..");',
      'const EXPECTED = join(ROOT, CASES, "expected");',
      'const DATA = join(ROOT, "testdata", "golden");', "",
    ].join("\n"));
    write("backend/src/cases.ts", 'export const CASES = "x";\n');
    write("python/tests/t.py", 'P = os.path.join(os.path.dirname(__file__), "..", "..", "testdata")\n');
    expect(found()).toEqual([]);
  });

  it("allows every one of those spellings where it stays home or reaches shared ground", () => {
    write("backend/src/a.ts", [
      "const m = await import(`./b.ts`);",
      'const p = join(import.meta.dirname, "../../testdata/x.json");',
      "const t = `${import.meta.dirname}/../../testdata/golden`;",
      "const u = new URL('../../testdata/x.json', import.meta.url);",
      "",
    ].join("\n"));
    write("backend/src/b.ts", "export const b = 1;\n");
    write("python/tests/t.py", 'P = Path(__file__).resolve().parent.parent.parent / "testdata" / "golden"\n');
    // and in Python a backtick is a docstring's markup, never a string
    write("python/src/m.py", '"""Ported from `../../backend/src/m.ts`."""\n');
    expect(found()).toEqual([]);
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

describe("which package may depend on which (ADR 0021)", () => {
  // the real shape: the library's directory and its npm name differ, which is the case a table
  // keyed by names would have got wrong
  const TREE = ["typescript", "backend", "frontend"];
  const ROWS = { typescript: [], backend: ["typescript"], frontend: ["backend"] };
  const named = (dir, name) => write(`${dir}/package.json`, JSON.stringify({ name }));
  const tree = () => {
    named("typescript", "optionality");
    named("backend", "backend");
    named("frontend", "frontend");
  };
  const byName = (depends = ROWS) => crossings(repo, TREE, SHARED, depends);

  it("refuses the library importing the backend, though the name is a published one", () => {
    // the hole the rules above leave: a published name passes every one of them
    tree();
    write("typescript/src/domain/alarm.ts", 'import type { Settings } from "backend";\n');
    expect(byName()).toEqual([expect.stringContaining("makes typescript/ depend on backend/")]);
  });

  it("sees a subpath and a dynamic import of a package as that package", () => {
    tree();
    write("typescript/src/a.ts", 'import { SOURCES } from "backend/schemas";\n');
    write("typescript/src/b.ts", 'const m = await import("frontend/src/api.ts");\n');
    expect(byName()).toHaveLength(2);
  });

  it("says what the package MAY import, so the message is actionable", () => {
    tree();
    write("typescript/src/a.ts", 'import { x } from "backend";\n');
    expect(byName()[0]).toMatch(/typescript\/ may import nothing by name/);
  });

  it("allows the backend importing the library by its npm name", () => {
    tree();
    write("backend/src/holdings.ts", 'import { costToClose } from "optionality/domain/position";\n');
    write("frontend/src/api.ts", 'import type { AppType } from "backend";\n');
    expect(byName()).toEqual([]);
  });

  it("resolves the name through package.json, not through the directory", () => {
    // `typescript` is the compiler, a third-party package like any other — not the library
    tree();
    write("backend/tools/t.ts", 'import ts from "typescript";\n');
    write("frontend/src/b.ts", 'import { x } from "optionality/quotes";\n');
    expect(byName()).toEqual([expect.stringContaining("makes frontend/ depend on typescript/")]);
  });

  it("allows a package importing itself by its own name", () => {
    tree();
    write("typescript/src/cases/build.ts", 'import * as alarm from "optionality/domain/alarm";\n');
    expect(byName()).toEqual([]);
  });

  it("lets a package with no row import nothing by name, rather than anything", () => {
    tree();
    write("backend/src/a.ts", 'import { x } from "optionality";\n');
    expect(byName({ typescript: [], frontend: ["backend"] }))
      .toEqual([expect.stringContaining("makes backend/ depend on typescript/")]);
  });

  it("is quiet about third-party packages, which are not this repository's to rule", () => {
    tree();
    write("typescript/src/a.ts", 'import { Socket } from "node:net";\nimport x from "moomoo-api";\n');
    expect(byName()).toEqual([]);
  });
});

describe("the table this repository declares", () => {
  it("keeps the library depending on nothing here, which is what the table is FOR", () => {
    // deleting the row would not do it — a missing row means nothing — but widening it would,
    // and a row that can be widened from the inside is the exemption-list failure check-seams met
    expect(DEPENDS.typescript, "the library may import another package by name again").toEqual([]);
  });

  it("has a row for every package, so none is ruled by the default by accident", () => {
    expect(Object.keys(DEPENDS).sort()).toEqual([...REAL_PACKAGES].sort());
  });

  it("shares the schema, which either backend builds its database from (ADR 0021)", () => {
    // one database file, one schema, the same migrations: inside backend/ the Python could read
    // them only by reaching into another package's source, which is what this whole file refuses
    expect(REAL_SHARED).toEqual(expect.arrayContaining(["testdata", "schema"]));
    expect(REAL_PACKAGES, "shared ground is nobody's package").not.toContain("schema");
  });
});

describe("the shared schema (ADR 0021)", () => {
  it("lets either backend read it by path, and refuses neither", () => {
    write("backend/src/db/open.ts", 'const S = new URL("../../../schema/schema.sql", import.meta.url);\n');
    write("python/tests/t.py", 'S = Path(__file__).resolve().parents[2] / "schema" / "migrations"\n');
    expect(crossings(repo, PACKAGES, ["testdata", "schema"])).toEqual([]);
  });
});
