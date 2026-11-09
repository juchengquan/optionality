/** `hc.types.ts` has a hand-written call for every endpoint — checked, not claimed.
 *
 *  That file's whole value is its COVERAGE. It exists (ADR 0009, phase 5) so that a route whose
 *  shape changed is a compile error in the frontend rather than a blank cell at the end of a
 *  sweep, and an endpoint it does not mention is an endpoint back to the blank cell.
 *
 *  It was complete when this was written — all sixteen, measured — but complete by DILIGENCE:
 *  whoever added each endpoint remembered to add it here too, and nothing anywhere noticed when
 *  somebody would not. Nothing even imports `hc.types.ts`; it is read by `tsc` alone, so there was
 *  no file a seventeenth endpoint would have broken. Same shape as the repo-root `tools/` being in
 *  no tsconfig at all (#227): a check doing real work, over a set nobody held it to.
 *
 *  The endpoint list is taken from `/openapi.json` rather than written here, because that document
 *  is built from the routes themselves and `openapi.test.ts` already holds it to them. So this
 *  compares two things that are each derived from the routes, and never a third list to maintain.
 */
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { type Harness, body, harness } from "../../testing/harness.ts";

let h: Harness;
afterEach(() => h?.close());

const SOURCE = new URL("./hc.types.ts", import.meta.url).pathname;

/** The `hc` expression an endpoint must be called by, derived from its path.
 *
 *  Hono's client mirrors the route tree as properties: a literal segment is a property, a path
 *  parameter keeps its colon (`/monitors/{id}` → `client.monitors[":id"]`), and anything that is
 *  not a legal identifier has to be a bracket (`total-entry` — the one endpoint whose hyphen makes
 *  the difference, and the one a looser check would have missed).
 */
export function hcExpression(path: string, method: string): string {
  const segments = path.split("/").filter((s) => s !== "");
  const steps = segments.map((segment) => {
    const param = /^\{(.+)\}$/.exec(segment);
    if (param) return `[":${param[1]}"]`;
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment) ? `.${segment}` : `["${segment}"]`;
  });
  return `client${steps.join("")}.$${method.toLowerCase()}`;
}

/** Whitespace removed, so a call the author wrapped over two lines still counts. */
const squashed = (text: string) => text.replace(/\s+/g, "");

describe("the typed client's coverage", () => {
  it("calls every endpoint the service documents", async () => {
    h = harness();
    const spec = (await body(await h.call("/openapi.json", { anonymous: true }))) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const source = squashed(readFileSync(SOURCE, "utf8"));

    const endpoints = Object.entries(spec.paths)
      .flatMap(([path, ops]) => Object.keys(ops).map((method) => ({ path, method })));
    const missing = endpoints
      .filter(({ path, method }) => !source.includes(squashed(hcExpression(path, method))))
      .map(({ path, method }) => `${method.toUpperCase()} ${path}`);

    expect(missing, "add a call for these in hc.types.ts, or the dashboard can go blank on them")
      .toEqual([]);
    // and there IS something to compare: a spec that somehow came back empty would pass above
    expect(endpoints.length, "the document describes no endpoints").toBeGreaterThanOrEqual(16);
  });

  it("asserts something about each call, rather than only making it", async () => {
    // A call alone proves the PATH exists. What stops `any` from satisfying everything is the
    // `Checked<...>` assertions below it, and that file's own header says so: "the checks are
    // written so that `any` FAILS them". A file of sixteen calls and no assertions would pass the
    // test above while proving nothing about any shape.
    const source = readFileSync(SOURCE, "utf8");
    const calls = source.match(/client[\w.$[\]":-]*\.\$[a-z]+\(/g) ?? [];
    const checks = source.match(/Checked</g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(16);
    expect(checks.length, "hc.types.ts makes calls it never asserts anything about")
      .toBeGreaterThanOrEqual(calls.length);
  });
});

describe("the path-to-expression rule", () => {
  // the mapping is the one place this test could be wrong in a way that makes it pass: an
  // expression nobody writes that way would report every endpoint as missing, and an expression
  // too loose would match anything
  it("turns a plain path into properties", () => {
    expect(hcExpression("/monitors", "get")).toBe("client.monitors.$get");
  });

  it("keeps a path parameter's colon, as the client does", () => {
    expect(hcExpression("/monitors/{id}", "patch")).toBe('client.monitors[":id"].$patch');
  });

  it("brackets a segment that is not a legal identifier", () => {
    // `total-entry`: the endpoint whose hyphen a looser check would have missed
    expect(hcExpression("/monitors/{id}/total-entry", "post"))
      .toBe('client.monitors[":id"]["total-entry"].$post');
  });

  it("walks more than one literal segment", () => {
    expect(hcExpression("/positions/values", "get")).toBe("client.positions.values.$get");
    expect(hcExpression("/positions/{id}/vol", "get")).toBe('client.positions[":id"].vol.$get');
  });
});
