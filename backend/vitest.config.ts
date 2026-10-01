import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The domain counts an option's life from New York's calendar day, so a date test is only
    // meaningful if the machine's own zone is known. Pinning it to UTC means the suite reads the
    // same on the owner's machine as in any other, and a port that quietly used the local zone
    // instead of the market one fails everywhere rather than only outside New York.
    env: { TZ: "UTC" },
  },
});
