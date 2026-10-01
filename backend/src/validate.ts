/** Request validation that answers the way FastAPI does (ADR 0009, phase 5).
 *
 *  Two things have to match, and neither is a default. A payload that fails validation is a 422 in
 *  FastAPI, and the body is `{"detail": ...}` — which the dashboard reads on every failure path.
 *  Wrapped once here so no route can get either wrong.
 *
 *  Built on Hono's own `validator` rather than @hono/zod-validator. That package declares a Zod
 *  peer range that includes ours, but npm hoists the shadcn CLI's zod 3 to the workspace root and
 *  the validator's types bind to THAT, not to the backend's zod 4 — so it will not compile against
 *  a copy it accepted. Hono's validator takes a plain function, couples to no version of anything,
 *  and still types `c.req.valid()` from what the function returns. One dependency fewer.
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
import { z } from "zod";
import type { ZodType } from "zod";

export function valid<T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) {
  // The first type argument is the REQUEST type, and it has to be passed explicitly. Hono decides
  // between "the caller's shape" and "the parsed shape" with `unknown extends InputType`, and
  // inside a generic wrapper `z.input<T>` is an unresolved conditional that TypeScript cannot
  // judge — so it takes the parsed branch and every field with a default becomes required of the
  // caller. Naming it here is what makes `tz` and `enabled` optional on a schedule, and `notify`
  // optional on a run, which is how the dashboard will actually call them.
  return validator(target, (value, c) => {
    const result = schema.safeParse(value);
    if (!result.success) return c.json({ detail: z.prettifyError(result.error) }, 422);
    return result.data as z.output<T>;
  });
}
