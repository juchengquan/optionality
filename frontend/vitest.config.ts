import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// mirrors vite.config.ts: the tests exercise the skew banner, which needs the baked constant
const contractVersion: number = JSON.parse(
  readFileSync("../src/optionality/service/contract.json", "utf8"),
).version;

export default defineConfig({
  plugins: [react()],
  define: { __CONTRACT_VERSION__: JSON.stringify(contractVersion) },
  test: { environment: "jsdom", globals: true },
});
