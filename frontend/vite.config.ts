import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";


// `base` is absolute, not relative, and that is deliberate. `tailscale serve --set-path`
// strips the prefix before proxying and does not rewrite redirects, so the page cannot learn
// its own prefix at runtime, and a visitor who omits the trailing slash would resolve
// "./assets/main.js" against the tailnet root. UI_BASE in the Makefile is the one knob;
// api.ts locates the API from this same value.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // "@/..." is how shadcn's components import each other; __dirname does not exist
  // in an ESM config, so the URL form is the one that works here
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  base: process.env.VITE_BASE || "/",
  // Built assets are still COMMITTED, now to frontend/dist and served by Caddy. Keeping node
  // off the deploy path mattered when one process served both; it matters more now, because
  // a failed build would leave Caddy with nothing at all to serve.
  //
  // TWO pages in one build (ADR 0023): today's dashboard at `/opt` and the redesign at `/opt/next`,
  // beside it until the swap. One build rather than two, so they share the hashed assets, the API
  // base and the deploy — and `next/index.html`, not `next.html`, so the page is a directory Caddy
  // serves at `/next` without a redirect (deploy/Caddyfile says why a redirect cannot work here).
  build: {
    outDir: "dist", emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        next: fileURLToPath(new URL("./next/index.html", import.meta.url)),
      },
    },
  },
});
