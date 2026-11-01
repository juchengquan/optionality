import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";


/** The small suite that needs a real layout engine.
 *
 *  jsdom has none, so it cannot answer the only question this mechanism raises: does the
 *  right set of columns actually survive at this width, with this text size, with this
 *  data in it. Everything else stays in the fast jsdom suite — asserting a request body
 *  does not need a browser. See ADR 0008.
 *
 *  Deliberately NOT given `env: { TZ: "UTC" }` like the jsdom config. That setting reaches the Node
 *  side and not the browser context, so it would read as a guarantee while guaranteeing nothing.
 *  This suite was instead CHECKED to be zone-independent — all 103 pass under TZ=America/New_York
 *  — because it asserts geometry and one `/fetched at/` regex, never a wall clock. A test here that
 *  needs a fixed zone must set it on the Playwright context, not on the process.
 */
export default defineConfig({
  // WITHOUT this the utilities do not exist and every measurement is of unstyled
  // markup — which looks like passing tests and is worth nothing
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/__browser__/**/*.test.tsx"],
    browser: {
      enabled: true,
      provider: "playwright",
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
