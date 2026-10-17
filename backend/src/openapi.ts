/** `/openapi.json` and `/docs` — what FastAPI generated for the Python, rebuilt from the same Zod
 *  schemas that validate and shape every request and answer.
 *
 *  Nothing is declared twice. A request shape is documented by `valid()` itself, which tags its
 *  middleware with the schema it validates against; an answer is documented by `documented(...)`,
 *  whose `reply` is the only way a route sends JSON — so the schema the spec shows is the one the
 *  answer was parsed through, by construction rather than by a second mention that can drift
 *  (openapi.test.ts holds the "only way"). The 422 every validated route can answer
 *  is derived here, not declared, because it follows from validation rather than from the route.
 *
 *  One dependency fact matters more than it looks. hono-openapi converts through
 *  `import("zod/v4/core")`, which resolves from the WORKSPACE root, not from the backend — and
 *  shadcn's zod 3 used to be hoisted there. Converted by zod 3.25, 6 of the 11 request schemas
 *  lost their constraints and still looked complete. The root package.json pins zod 4 for that
 *  reason; openapi.test.ts fails if it ever slips back.
 */
import { Scalar } from "@scalar/hono-api-reference";
import type { Context, Hono } from "hono";
import type { JSONValue } from "hono/utils/types";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { describeRoute, generateSpecs, resolver } from "hono-openapi";
import { z } from "zod";
import type { ZodType } from "zod";

/** Every failure answers this way (errors.ts) — the shape the dashboard reads. */
const ErrorOut = z.object({ detail: z.string() });

/** ErrorOut as plain JSON Schema, for the one place that writes into an already generated spec. */
const DETAIL = z.toJSONSchema(ErrorOut);

const json = (schema: ZodType) => ({ "application/json": { schema: resolver(schema) } });

/** What each failure status means in this API, so a route lists only the numbers it can throw. */
const FAILURES = {
  404: "no such record",
  409: "would duplicate an existing record",
  422: "the request is well-formed but refused",
  502: "the OpenD call failed",
} as const;

type Ok = Partial<Record<200 | 201 | 204, ZodType | null>>;
/** The statuses of `O` that carry a body to check. */
type Bodied<O extends Ok> = { [S in keyof O]: O[S] extends ZodType ? S : never }[keyof O] & ContentfulStatusCode;

/** The route's summary, its success answer — a schema, or null for a 204 — and the failure statuses
 *  its handler can throw. A rejected payload's 422 need not be listed: it is added for every route
 *  that validates.
 *
 *  What it returns is the route's middleware AND the only way the route answers: `reply(c, status,
 *  data)` parses `data` through the very schema documented for `status`, so a route names its
 *  answer once and the spec cannot describe a shape the handler does not send. */
export function documented<const O extends Ok>(
  summary: string,
  ok: O,
  failures: readonly (keyof typeof FAILURES)[] = [],
) {
  const responses: Record<string, { description: string; content?: ReturnType<typeof json> }> = {};
  for (const [status, schema] of Object.entries(ok)) {
    responses[status] = schema ? { description: "ok", content: json(schema) } : { description: "no content" };
  }
  for (const status of failures) responses[status] = { description: FAILURES[status], content: json(ErrorOut) };
  return Object.assign(describeRoute({ summary, responses }), {
    // `unknown`, as `.parse` takes: the parse IS the check, and the routes hand over stored JSON
    // (a Position's legs) deliberately untyped so that nothing but the schema vouches for it
    reply<S extends Bodied<O>>(c: Context, status: S, data: unknown) {
      const schema = ok[status] as ZodType;
      // the cast is the one `c.json(Schema.parse(x))` made implicitly: zod's output type is what
      // the client is told, and hc reads it from here
      return c.json(schema.parse(data) as JSONValue as z.output<NonNullable<O[S]> & ZodType>, status);
    },
  });
}

/** The browser bundle the docs page loads, pinned: the release cut alongside the hono plugin in use. */
const SCALAR_CDN = "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1";

type Operation = {
  tags?: string[];
  security?: unknown[];
  requestBody?: unknown;
  parameters?: { in?: string }[];
  responses: Record<string, unknown>;
};

/** Mounts both routes on `app`, which keeps its own type: these are for people, not for `hc`. */
export function mountDocs(app: Hono, rootPath: string, openPaths: ReadonlySet<string>): void {
  let cached: unknown;
  app.get("/openapi.json", async (c) => {
    cached ??= await build(app, rootPath, openPaths);
    return c.json(cached);
  });
  app.get("/docs", Scalar({ url: `${rootPath}/openapi.json`, cdn: SCALAR_CDN, pageTitle: "optionality API" }));
}

async function build(app: Hono, rootPath: string, openPaths: ReadonlySet<string>) {
  const spec = await generateSpecs(app, {
    documentation: {
      info: { title: "optionality", version: "1", description: "SPX options monitoring: watchlist, alarms, positions." },
      // the browser sees /opt/api/...; the app sees /... — "Try it" has to be told the difference
      servers: [{ url: rootPath || "/" }],
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
      security: [{ bearer: [] }],
    },
    // hono-openapi's own is a 400 in ITS validator's shape; ours is a 422 with a detail
    defaultValidationErrorResponse: false,
  });
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const op of Object.values(methods as Record<string, Operation>)) {
      op.tags = [path.split("/")[1] ?? ""];
      if (openPaths.has(path)) op.security = [];
      const validates = op.requestBody !== undefined || op.parameters?.some((p) => p.in === "query");
      if (validates) {
        op.responses["422"] ??= { description: FAILURES[422], content: { "application/json": { schema: DETAIL } } };
      }
    }
  }
  return spec;
}
