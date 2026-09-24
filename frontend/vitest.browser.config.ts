import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const contractVersion: number = JSON.parse(
  readFileSync("../src/optionality/service/contract.json", "utf8"),
).version;

/** The small suite that needs a real layout engine.
 *
 *  jsdom has none, so it cannot answer the only question this mechanism raises: does the
 *  right set of columns actually survive at this width, with this text size, with this
 *  data in it. Everything else stays in the fast jsdom suite — asserting a request body
 *  does not need a browser. See ADR 0008.
 */
export default defineConfig({
  plugins: [react()],
  define: { __CONTRACT_VERSION__: JSON.stringify(contractVersion) },
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
