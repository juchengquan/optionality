import { afterEach, describe, expect, it, vi } from "vitest";

/** That `/health` serves the GENERATED fingerprint, whatever it says (ADR 0016).
 *
 *  `app.test.ts` compares the response with the constant it imports, which a hard-coded literal
 *  equal to today's hash also satisfies — a sweep proved it. The claim worth making is that the
 *  route reads the module rather than a copy of its value, and the only way to state that is to
 *  make the module say something else.
 */
vi.mock("optionality/golden", () => ({ GOLDEN_CASES: "feedfacecafe" }));

const { body, harness } = await import("../../../../testing/harness.ts");

let h: ReturnType<typeof harness> | undefined;
afterEach(() => h?.close());

describe("the golden fingerprint on /health", () => {
  it("is whatever the generated module says, not a copy of it", async () => {
    h = harness();
    const data = await body(await h.call("/health", { anonymous: true }));
    expect(data.golden_cases).toBe("feedfacecafe");
  });
});
