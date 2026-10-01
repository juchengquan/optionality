import { describe, expect, it } from "vitest";

import { createApp } from "./app.ts";

/** Phase 1 asserts only that the workspace runs. The real suite arrives in phase 2, before
 *  any implementation exists for it to be shaped by. */
describe("the backend workspace", () => {
  it("builds an app without binding a port", () => {
    expect(createApp().placeholder).toBe(true);
  });
});
