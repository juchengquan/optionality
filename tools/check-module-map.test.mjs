import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BACKLOG, PY_ONLY, RENAMED, TS_ONLY, findings, pythonFor, unported } from "./check-module-map.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/** Against a fixture tree, as the other guards in this directory are: "add a module and watch it
 *  fail" is the check, and doing that by hand is what lets a hole last. */
let repo;
beforeEach(() => { repo = mkdtempSync(join(tmpdir(), "module-map-")); });
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function write(path, text = "") {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}
const ts = (rel) => write(`backend/src/${rel}`, "export {};\n");
const py = (rel) => write(`python-backend/src/optionality_backend/${rel}`, '"""a port."""\n');

/** An empty table, with whatever a case needs laid over it. */
const table = (over = {}) => ({ tsOnly: {}, renamed: {}, pyOnly: {}, backlog: [], ...over });
const found = (over) => findings(repo, table(over));

describe("the Python name for a TypeScript module", () => {
  it("is the same path, snake_case, with a directory's door as its package's __init__", () => {
    expect(pythonFor("holdings.ts", {})).toBe("holdings.py");
    expect(pythonFor("create-monitor.ts", {})).toBe("create_monitor.py");
    expect(pythonFor("db/queries/index.ts", {})).toBe("db/queries/__init__.py");
    expect(pythonFor("entrypoints/http/routes/monitors.ts", {}))
      .toBe("entrypoints/http/routes/monitors.py");
  });

  it("is the table's where the translation is not the name", () => {
    expect(pythonFor("main.ts", { "main.ts": "__main__.py" })).toBe("__main__.py");
  });
});

describe("every TypeScript backend module has a Python counterpart, or says why not", () => {
  it("refuses a TypeScript module with no port that is not on the backlog: lockstep", () => {
    ts("holdings.ts");
    expect(found()).toEqual([expect.stringMatching(/holdings\.ts has no Python counterpart.*lockstep/)]);
  });

  it("accepts a module the backlog names and nothing has ported yet", () => {
    ts("holdings.ts");
    expect(found({ backlog: ["holdings.ts"] })).toEqual([]);
  });

  it("accepts a ported module off the backlog", () => {
    ts("db/queries/index.ts"); py("db/queries/__init__.py");
    expect(found()).toEqual([]);
  });

  it("refuses a ported module still on the backlog, so the list shrinks as the port lands", () => {
    ts("holdings.ts"); py("holdings.py");
    expect(found({ backlog: ["holdings.ts"] }))
      .toEqual([expect.stringMatching(/holdings\.ts is ported.*take it off the backlog/)]);
  });

  it("refuses a backlog entry for a module that no longer exists", () => {
    expect(found({ backlog: ["gone.ts"] })).toEqual([expect.stringMatching(/backlog names gone\.ts/)]);
  });

  it("accepts a TypeScript-only module, and refuses one that is also on the backlog", () => {
    ts("entrypoints/http/hc.types.ts");
    const tsOnly = { "entrypoints/http/hc.types.ts": "a compile-time check" };
    expect(found({ tsOnly })).toEqual([]);
    expect(found({ tsOnly, backlog: ["entrypoints/http/hc.types.ts"] }))
      .toEqual([expect.stringMatching(/both TypeScript-only and on the backlog/)]);
  });

  it("refuses a TypeScript-only entry or a rename for a module that no longer exists", () => {
    expect(found({ tsOnly: { "gone.ts": "why" } })).toEqual([expect.stringMatching(/TS_ONLY names gone\.ts/)]);
    expect(found({ renamed: { "gone.ts": "x.py" } })).toEqual([expect.stringMatching(/RENAMED names gone\.ts/)]);
  });

  it("refuses a TypeScript-only module that has a Python port after all", () => {
    ts("entrypoints/http/hc.types.ts"); py("entrypoints/http/hc_types.py");
    expect(found({ tsOnly: { "entrypoints/http/hc.types.ts": "why" } }))
      .toEqual([expect.stringMatching(/hc_types\.py has no TypeScript counterpart/)]);
  });

  it("follows a rename", () => {
    ts("main.ts"); py("__main__.py");
    expect(found({ renamed: { "main.ts": "__main__.py" } })).toEqual([]);
  });

  it("ignores tests and declaration files", () => {
    write("backend/src/holdings.test.ts"); write("backend/src/types.d.ts");
    expect(found()).toEqual([]);
  });
});

describe("every Python backend module has a TypeScript counterpart, or says why not", () => {
  it("refuses a Python module with no TypeScript counterpart: module for module", () => {
    py("helpers.py");
    expect(found()).toEqual([expect.stringMatching(/helpers\.py has no TypeScript counterpart/)]);
  });

  it("accepts one the table names, with its reason", () => {
    py("helpers.py");
    expect(found({ pyOnly: { "helpers.py": "why" } })).toEqual([]);
  });

  it("accepts the package's own __init__, and a directory's __init__ where the TypeScript has no door", () => {
    py("__init__.py"); ts("db/rows.ts"); py("db/rows.py"); py("db/__init__.py");
    expect(found()).toEqual([]);
  });

  it("ignores caches", () => {
    write("python-backend/src/optionality_backend/__pycache__/holdings.cpython-312.pyc");
    expect(found()).toEqual([]);
  });
});

describe("what has no port yet, measured from the tree rather than read off the list", () => {
  // `make use`'s guard asks this: the list is held to the tree by `findings`, in `make check`, but a
  // switch runs on whatever tree is checked out, and the list is to be deleted when the port is done
  const missing = (over = {}) => unported(repo, { tsOnly: {}, renamed: {}, ...over });

  it("names each TypeScript module with no Python file, and where the port would be", () => {
    ts("holdings.ts"); ts("db/queries/index.ts"); py("db/queries/__init__.py");
    expect(missing()).toEqual({ portable: 2, missing: [{ ts: "holdings.ts", py: "holdings.py" }] });
  });

  it("counts a module whatever the backlog says, which is what makes it the tree's answer", () => {
    ts("holdings.ts");
    expect(missing().missing).toEqual([{ ts: "holdings.ts", py: "holdings.py" }]);
  });

  it("leaves out what is TypeScript-only, and finds a renamed port under its own name", () => {
    // a rename the repository's own table does not have, so a default table cannot pass for this one
    ts("hc.types.ts"); ts("entry.ts"); py("__main__.py");
    expect(missing({ tsOnly: { "hc.types.ts": "why" }, renamed: { "entry.ts": "__main__.py" } }))
      .toEqual({ portable: 1, missing: [] });
  });

  it("never counts a test or a declaration file as a module", () => {
    ts("holdings.test.ts"); ts("types.d.ts");
    expect(missing()).toEqual({ portable: 0, missing: [] });
  });

  it("agrees with the backlog in this repository", () => {
    expect(unported(ROOT).missing.map((m) => m.ts)).toEqual([...BACKLOG].sort());
  });
});

describe("this repository", () => {
  it("passes, with every table entry naming a module that exists", () => {
    expect(findings(ROOT, { tsOnly: TS_ONLY, renamed: RENAMED, pyOnly: PY_ONLY, backlog: BACKLOG }))
      .toEqual([]);
  });

  it("states a reason for every TypeScript-only and Python-only module", () => {
    for (const why of [...Object.values(TS_ONLY), ...Object.values(PY_ONLY)]) {
      expect(why.length).toBeGreaterThan(20);
    }
  });
});
