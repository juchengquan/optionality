import { readFileSync } from "node:fs";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The contract version is read from the API's own copy rather than duplicated here, so the
// bundle and the service cannot disagree about it by being edited separately (ADR 0006).
const contractVersion: number = JSON.parse(
  readFileSync("../src/optionality/service/contract.json", "utf8"),
).version;

// `base` is absolute, not relative, and that is deliberate. `tailscale serve --set-path`
// strips the prefix before proxying and does not rewrite redirects, so the page cannot learn
// its own prefix at runtime, and a visitor who omits the trailing slash would resolve
// "./assets/main.js" against the tailnet root. UI_BASE in the Makefile is the one knob;
// api.ts locates the API from this same value.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE || "/",
  define: { __CONTRACT_VERSION__: JSON.stringify(contractVersion) },
  // Built assets are still COMMITTED, now to frontend/dist and served by Caddy. Keeping node
  // off the deploy path mattered when one process served both; it matters more now, because
  // a failed build would leave Caddy with nothing at all to serve.
  build: { outDir: "dist", emptyOutDir: true },
});
