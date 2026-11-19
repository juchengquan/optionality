/** Request validation that answers the way FastAPI does (ADR 0009, phase 5).
 *
 *  Two things have to match, and neither is a default. A payload that fails validation is a 422 in
 *  FastAPI, and the body is `{"detail": ...}` — which the dashboard reads on every failure path.
 *  Wrapped once here so no route can get either wrong.
 *
 *  Built on Hono's own `validator` rather than @hono/zod-validator. That package declares a Zod
 *  peer range that includes ours, but npm hoisted the shadcn CLI's zod 3 to the workspace root and
 *  the validator's types bound to THAT, not to the backend's zod 4 — so it would not compile
 *  against a copy it accepted. (The root now pins zod 4 for openapi.ts's sake, which may have cured
 *  this; nobody has re-tried.) Hono's validator takes a plain function, couples to no version of
 *  anything, and still types `c.req.valid()` from what the function returns. One dependency fewer.
 *
 *  One consequence shapes every schema in this directory: Hono derives the REQUEST type from the
 *  parsed type, so a field written `z.string().default("x")` is optional at runtime and REQUIRED of
 *  a typed client. Its own `InputType` parameter cannot help, because the place it would be
 *  inferred from is itself guarded by a conditional on `InputType` — circular, so it resolves to
 *  `unknown` and the parsed branch wins; passing it explicitly means passing the route path too,
 *  and that loses the path the client is keyed by. So optional fields are written `.optional()`
 *  here and their defaults applied where the value is used, named once. The schema then says what
 *  the API actually accepts, which is the thing `hc` is for.
 */
import type { ValidationTargets } from "hono";
import { validator } from "hono/validator";
import { resolver, uniqueSymbol } from "hono-openapi";
import { z } from "zod";
import type { ZodType } from "zod";

export function valid<T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
  /** For a UNION `schema`: the member this value is meant for, which then validates it alone.
   *  Zod answers a union that every member refuses with "Invalid input" and no reason, so the
   *  member's own message is the only useful one. `schema` still documents and types the
   *  request, whole. */
  member?: (value: unknown) => ZodType<z.output<T>>,
) {
  // The first type argument is the REQUEST type, and it has to be passed explicitly. Hono decides
  // between "the caller's shape" and "the parsed shape" with `unknown extends InputType`, and
  // inside a generic wrapper `z.input<T>` is an unresolved conditional that TypeScript cannot
  // judge — so it takes the parsed branch and every field with a default becomes required of the
  // caller. Naming it here is what makes `tz` and `enabled` optional on a schedule, and `notify`
  // optional on a run, which is how the dashboard will actually call them.
  const middleware = validator(target, (value, c) => {
    const result = (member?.(value) ?? schema).safeParse(value);
    if (!result.success) return c.json({ detail: z.prettifyError(result.error) }, 422);
    return result.data as z.output<T>;
  });
  // A JSON body is decoded HERE, by TextDecoder, before Hono's validator asks for it: its
  // `c.req.json()` parses the text in `bodyCache`, so priming that cache decides the decoding.
  // Node's own Request.text()/.json() strip TWO leading BOMs (measured on v25.9.0), where the
  // Encoding spec — and the Python's utf-8-sig — strip one; the service's own decoding makes the
  // two backends read the same bytes the same way whatever Node runs (#462, the owner 2026-11-20).
  const primed = (async (c, next) => {
    // `bodyCache` is typed as holding text, but what Hono stores and reads there is the PROMISE of
    // it (`raw[key]()`, then awaited), so the cache is written as it is really read
    const cache = c.req.bodyCache as { text?: Promise<string> };
    if (target === "json" && cache.text === undefined) cache.text = c.req.raw.arrayBuffer().then(decodeBody);
    return middleware(c, next);
  }) as typeof middleware;
  // the tag hono-openapi's own validator carries, so /openapi.json documents this request from the
  // very schema that checks it (openapi.ts)
  return Object.assign(primed, { [uniqueSymbol]: { target, ...resolver(schema) } });
}

/** A request body's bytes as text: UTF-8, exactly one leading BOM ignored (the Encoding spec's
 *  decode), malformed sequences replaced — as the Python's `body.decode("utf-8-sig", "replace")`. */
export const decodeBody = (bytes: ArrayBuffer): string => new TextDecoder().decode(bytes);
