import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { leaks } from "./check-test-support.mjs";

/** The guard, against a fixture tree rather than against this repository — the arrangement
 *  `check-boundaries.test.mjs` arrived at, and for its reason: "add a crossing and watch it fail"
 *  is the right check, and doing it by hand is what lets a hole last.
 */
let repo;

beforeEach(() => { repo = mkdtempSync(join(tmpdir(), "test-support-")); });
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function write(path, text) {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}
const found = () => leaks(repo);

describe("what may import the test harness", () => {
  it("refuses a production module that imports it", () => {
    // the hazard this exists for: the harness builds a fake Provider that prices everything it is
    // asked for, and a service that reached it would answer the dashboard with invented figures
    write("backend/testing/harness.ts", "export const harness = () => {};\n");
    write("backend/src/routes/thing.ts", 'import { harness } from "../../testing/harness.ts";\n');
    expect(found()).toEqual([expect.stringContaining("backend/src/routes/thing.ts")]);
  });

  it("allows a test file to import it, which is the whole point", () => {
    write("backend/testing/harness.ts", "export const harness = () => {};\n");
    write("backend/src/routes/thing.test.ts", 'import { harness } from "../../testing/harness.ts";\n');
    expect(found()).toEqual([]);
  });

  it("allows another test-support file to import it", () => {
    write("backend/testing/harness.ts", "export const harness = () => {};\n");
    write("backend/testing/quotes.ts", 'import { harness } from "./harness.ts";\n');
    expect(found()).toEqual([]);
  });

  it("sees a dynamic import too, which is how a leak would hide", () => {
    write("backend/testing/harness.ts", "export const harness = () => {};\n");
    write("backend/src/a.ts", 'const h = await import("../testing/harness.ts");\n');
    expect(found()).toEqual([expect.stringContaining("backend/src/a.ts")]);
  });

  it("names the importer and what it reached for", () => {
    write("backend/testing/harness.ts", "export const harness = () => {};\n");
    write("backend/src/a.ts", 'import { TOKEN } from "../testing/harness.ts";\n');
    expect(found()[0]).toMatch(/backend\/src\/a\.ts.*testing\/harness\.ts/);
  });

  it("is quiet about an unrelated import", () => {
    write("backend/src/a.ts", 'import { b } from "./b.ts";\n');
    write("backend/src/b.ts", "export const b = 1;\n");
    expect(found()).toEqual([]);
  });

  it("is quiet where there is no test-support directory at all", () => {
    write("frontend/src/App.tsx", 'import { x } from "./x.ts";\n');
    expect(found()).toEqual([]);
  });

  it("covers a frontend test-support directory on the same rule", () => {
    // stated as a rule about any package, so the frontend gets it free rather than later
    write("frontend/testing/render.tsx", "export const render = () => {};\n");
    write("frontend/src/App.tsx", 'import { render } from "../testing/render.tsx";\n');
    expect(found()).toEqual([expect.stringContaining("frontend/src/App.tsx")]);
  });
});
