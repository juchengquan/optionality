/** `/openapi.json` and `/docs`, which FastAPI gave the Python for free and Hono does not.
 *
 *  The port recorded the gap (app.test.ts) rather than closing it; this closes it. What these tests
 *  hold is that the document is TRUE, not merely present: every route is in it, each request shape
 *  carries the constraints the validator enforces, and each answer names the schema the handler
 *  parses it through. A spec that describes a looser API than the one that runs is worse than none.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { documented } from "./openapi.ts";
import { type Harness, body, harness } from "./testing.ts";

let h: Harness;
const start = (...args: Parameters<typeof harness>) => (h = harness(...args));
afterEach(() => h?.close());

type Operation = {
  requestBody?: { content: Record<string, { schema: Record<string, unknown> }> };
  parameters?: { in: string; name: string }[];
  responses: Record<string, { content?: Record<string, { schema: unknown }> }>;
};
type Spec = {
  servers?: { url: string }[];
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Record<string, unknown>> };
};

const spec = async (hh: Harness) => (await body(await hh.call("/openapi.json", { anonymous: true }))) as Spec;
const bodyOf = (op: Operation) => op.requestBody!.content["application/json"]!.schema;
/** follows one `$ref`, which is how a schema used on more than one route is emitted */
const deref = (s: Spec, schema: Record<string, unknown>) =>
  typeof schema.$ref === "string" ? s.components!.schemas![schema.$ref.split("/").pop()!]! : schema;

describe("/openapi.json and /docs", () => {
  it("are open, like /health, because the docs page cannot send a token to fetch its own spec", async () => {
    start();
    expect((await h.call("/openapi.json", { anonymous: true })).status).toBe(200);
    expect((await h.call("/docs", { anonymous: true })).status).toBe(200);
    // and opening them did not open anything else
    expect((await h.call("/monitors", { anonymous: true })).status).toBe(401);
  });

  it("point at the prefixed paths behind the path-stripping proxy", async () => {
    // the Python's test_root_path_prefixes_openapi_url_for_reverse_proxy, which the port could not
    // carry over until there was a /docs to point anywhere. The browser sees /opt/api/...; the app
    // sees /..., so both the page's spec URL and "Try it" have to be told the prefix.
    start({ settings: { rootPath: "/opt/api" } });
    const page = await (await h.call("/docs", { anonymous: true })).text();
    expect(page).toContain("/opt/api/openapi.json");
    expect((await spec(h)).servers).toEqual([{ url: "/opt/api" }]);
  });

  it("documents every route the app serves, with the schema of its success answer", async () => {
    // walked from the router itself, so a route added without `documented(...)` fails here rather
    // than going missing from the page
    start();
    const s = await spec(h);
    const served = h.app.routes
      .filter((r) => r.method !== "ALL" && !["/openapi.json", "/docs"].includes(r.path))
      .map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, "{$1}")}`);
    const missing: string[] = [];
    for (const route of new Set(served)) {
      const [method, path] = route.split(" ") as [string, string];
      const op = s.paths[path]?.[method.toLowerCase()];
      const ok = op && Object.entries(op.responses).find(([code]) => code.startsWith("2"));
      // 204 is the one success with nothing to describe
      if (!ok || (ok[0] !== "204" && !ok[1].content?.["application/json"]?.schema)) missing.push(route);
    }
    expect(served.length).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });

  it("describes request bodies with the constraints the validator enforces", async () => {
    // Measured before this was written: converted through the zod 3 that npm hoists to the
    // workspace root for shadcn, 6 of the 11 request schemas lost constraints — a combo's
    // minItems, `contracts` as an integer >= 1, every email format — and still LOOKED complete.
    start();
    const s = await spec(h);
    const position = deref(s, bodyOf(s.paths["/positions"]!.post!));
    expect((position.properties as Record<string, Record<string, unknown>>).legs!.minItems).toBe(1);
    const patch = deref(s, bodyOf(s.paths["/positions/{id}"]!.patch!));
    expect((patch.properties as Record<string, Record<string, unknown>>).contracts)
      .toMatchObject({ type: "integer", minimum: 1 });
    expect(JSON.stringify(bodyOf(s.paths["/monitors"]!.post!))).toContain('"minItems":2');
  });

  it("documents query parameters from the same schema", async () => {
    start();
    const params = (await spec(h)).paths["/spx/quote"]!.get!.parameters!.map((p) => `${p.in} ${p.name}`);
    expect(params.sort()).toEqual(["query option_type", "query strike", "query strike_date"]);
  });

  it("says a rejected payload is a 422 with a detail, which is what the API answers", async () => {
    // hono-openapi's default is a 400 in its own validator's shape; ours answers as FastAPI did
    start();
    const op = (await spec(h)).paths["/positions"]!.post!;
    expect(op.responses["400"]).toBeUndefined();
    expect(JSON.stringify(op.responses["422"])).toContain("detail");
  });
});

describe("documented(...).reply", () => {
  // The schema a route documents and the schema its answer is checked against are the same object,
  // because a route names it once. These hold that the one naming is the one that is enforced.
  const Out = z.object({ n: z.number() });
  const doc = documented("a route", { 200: Out });
  const app = (data: unknown) => new Hono()
    .onError((_err, c) => c.json({ detail: "internal error" }, 500))
    .get("/", doc, (c) => doc.reply(c, 200, data));

  it("answers with what the documented schema allows, and nothing more", async () => {
    const resp = await app({ n: 1, extra: "dropped" }).request("/");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ n: 1 });
  });

  it("refuses to send what the documented schema does not allow", async () => {
    // a 500 rather than a 200 the spec lies about — the same bargain `.parse` made before
    expect((await app({ n: "one" }).request("/")).status).toBe(500);
  });

  it("is the only way a route sends JSON", () => {
    // a bare c.json in a route is an answer no documented schema checked, which is the drift this
    // exists to prevent. Errors go through httpError, and a 204 has no body to check.
    const dir = join(import.meta.dirname, "routes");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => readFileSync(join(dir, f), "utf8").includes("c.json("));
    expect(offenders).toEqual([]);
  });
});
