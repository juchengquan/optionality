/** `validate.ts`'s `JSON_TYPE` is a COPY of Hono's own `jsonRegex`, which hono/validator does not
 *  export (#462). The body is primed for exactly the types Hono's validator reads: a pattern wider
 *  than Hono's would leave a primed read nobody awaits (a failed upload then an unhandled rejection,
 *  fatal in main.ts), a narrower one would let those types fall back to Node's decoding, which strips
 *  two BOMs. So a Hono upgrade that changes the pattern must fail here rather than drift in silence. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSON_TYPE } from "./validate.ts";

describe("the JSON types a body is primed for", () => {
  it("are exactly the ones the installed Hono's json validator reads", () => {
    const entry = createRequire(import.meta.url).resolve("hono/validator");
    const source = readFileSync(join(dirname(entry), "validator.js"), "utf8");
    const declared = /const jsonRegex = (\/.+\/[a-z]*);/.exec(source);
    expect(declared, "hono/validator no longer declares jsonRegex: re-read how it decides to read a body").not.toBeNull();
    expect(String(JSON_TYPE)).toBe(declared![1]);
  });
});
