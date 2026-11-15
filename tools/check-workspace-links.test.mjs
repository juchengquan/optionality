import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { linkFaults } from "./check-workspace-links.mjs";

/** The guard, against a fixture tree rather than this repository's `node_modules` — the
 *  arrangement every other guard here arrived at: "break it and watch it fail" done by hand is
 *  what lets a hole last.
 */
let repo;

beforeEach(() => { repo = mkdtempSync(join(tmpdir(), "workspace-links-")); });
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function write(path, text) {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}
const pkg = (name, extra = {}) => JSON.stringify({ name, ...extra });

/** This repository's shape: three workspaces, one of them named apart from its directory. */
function workspaces() {
  write("package.json", pkg("optionality-workspace", { workspaces: ["typescript", "backend", "frontend"] }));
  write("typescript/package.json", pkg("optionality"));
  write("backend/package.json", pkg("backend"));
  write("frontend/package.json", pkg("frontend"));
  mkdirSync(join(repo, "node_modules"));
}
const link = (name, target) => symlinkSync(target, join(repo, "node_modules", name));
function linked() {
  link("optionality", "../typescript");
  link("backend", "../backend");
  link("frontend", "../frontend");
}

describe("each workspace package is installed as a link to its own directory", () => {
  it("passes the install bun makes: every name a link into the workspace", () => {
    workspaces();
    linked();
    expect(linkFaults(repo)).toEqual([]);
  });

  it("refuses the public registry's `optionality` installed in place of the library", () => {
    // the hazard this exists for: npm's registry has an unrelated `optionality` (1.2.1 when
    // measured), and a package manager that reaches for it puts a stranger's code where the
    // backend imports its domain — `optionality/domain/alarm` would then fail, or worse, load
    workspaces();
    link("backend", "../backend");
    link("frontend", "../frontend");
    write("node_modules/optionality/package.json", pkg("optionality", { version: "1.2.1" }));
    expect(linkFaults(repo)).toEqual([expect.stringMatching(/node_modules\/optionality.*not a link/)]);
  });

  it("refuses a link that lands somewhere other than the workspace's directory", () => {
    workspaces();
    linked();
    rmSync(join(repo, "node_modules/optionality"));
    write("elsewhere/package.json", pkg("optionality"));
    link("optionality", "../elsewhere");
    expect(linkFaults(repo)).toEqual([expect.stringMatching(/node_modules\/optionality.*elsewhere/)]);
  });

  it("refuses a workspace that was not installed at all", () => {
    workspaces();
    link("optionality", "../typescript");
    link("frontend", "../frontend");
    expect(linkFaults(repo)).toEqual([expect.stringMatching(/node_modules\/backend.*missing/)]);
  });

  it("names the package by its NAME, not its directory, which is where the two differ", () => {
    // a link at node_modules/typescript would be the compiler's name, and the library's mistake
    workspaces();
    linked();
    rmSync(join(repo, "node_modules/optionality"));
    link("typescript", "../typescript");
    expect(linkFaults(repo)).toEqual([expect.stringContaining("node_modules/optionality")]);
  });

  it("refuses a copy nested inside a workspace, which shadows the root link for that workspace", () => {
    // a workspace that depends on the public `optionality@^1.2.1` gets its own copy beside its
    // source, and Node finds that one first from every file of the backend: the root link is fine
    // and is not what the backend imports
    workspaces();
    linked();
    write("backend/node_modules/optionality/package.json", pkg("optionality", { version: "1.2.1" }));
    expect(linkFaults(repo)).toEqual([expect.stringMatching(/backend\/node_modules\/optionality.*not a link/)]);
  });

  it("allows a nested LINK to the workspace, which is the same code", () => {
    workspaces();
    linked();
    mkdirSync(join(repo, "frontend/node_modules"));
    symlinkSync("../../typescript", join(repo, "frontend/node_modules/optionality"));
    expect(linkFaults(repo)).toEqual([]);
  });

  it("reports a fault at the root once, not once per workspace that sees it", () => {
    workspaces();
    link("backend", "../backend");
    link("frontend", "../frontend");
    write("node_modules/optionality/package.json", pkg("optionality", { version: "1.2.1" }));
    expect(linkFaults(repo)).toHaveLength(1);
  });
});

describe("the lockfile resolves each workspace name to the workspace", () => {
  const lock = (packages) => write("bun.lock", `{
  "lockfileVersion": 1,
  "packages": {
${Object.entries(packages).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")}
  }
}
`);

  it("passes bun's own entries, `@workspace:` for each", () => {
    workspaces();
    linked();
    lock({
      backend: ["backend@workspace:backend"],
      frontend: ["frontend@workspace:frontend"],
      optionality: ["optionality@workspace:typescript"],
      zod: ["zod@4.6.5", "", {}, "sha512-x"],
    });
    expect(linkFaults(repo)).toEqual([]);
  });

  it("refuses a registry package named like a workspace anywhere in the lock, even nested", () => {
    // what a dependency asking for the public `optionality` would put there, at any depth —
    // before any install has laid it down where the walk above could see it
    workspaces();
    linked();
    lock({
      optionality: ["optionality@workspace:typescript"],
      "some-dep/optionality": ["optionality@1.2.1", "", {}, "sha512-x"],
    });
    expect(linkFaults(repo)).toEqual([expect.stringMatching(/bun\.lock.*some-dep\/optionality.*optionality@1\.2\.1/)]);
  });
});

describe("what it refuses to pass on", () => {
  it("refuses a workspace list it cannot read rather than passing on nothing", () => {
    write("package.json", pkg("optionality-workspace"));
    expect(linkFaults(repo)).toEqual([expect.stringContaining("no workspaces")]);
  });
});
