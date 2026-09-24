import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// mirrors vite.config.ts: the tests exercise the skew banner, which needs the baked constant
const contractVersion: number = JSON.parse(
  readFileSync("../src/optionality/service/contract.json", "utf8"),
).version;

export default defineConfig({
  plugins: [react()],
  // must mirror vite.config.ts: these are separate files, and shadcn's components
  // import each other through "@/", so without this every test that touches one fails
  // to resolve rather than fails an assertion
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  define: { __CONTRACT_VERSION__: JSON.stringify(contractVersion) },
  test: { environment: "jsdom", globals: true },
});
