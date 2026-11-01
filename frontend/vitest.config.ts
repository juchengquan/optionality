import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// mirrors vite.config.ts: the tests exercise the skew banner, which needs the baked constant

export default defineConfig({
  plugins: [react()],
  // must mirror vite.config.ts: these are separate files, and shadcn's components
  // import each other through "@/", so without this every test that touches one fails
  // to resolve rather than fails an assertion
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // __browser__ is the other suite: it needs a real layout engine (ADR 0008)
  test: {
    environment: "jsdom",
    globals: true,
    exclude: ["**/node_modules/**", "src/__browser__/**"],
    // TZ=UTC, as backend/vitest.config.ts has always had it — and for a sharper reason here.
    // `clockTime` and `snapshotName` deliberately read the DEVICE's zone, which is what "when this
    // screen last fetched" means, so three tests were asserting a wall clock that only held at
    // +08. The gate was green by accident of the owner's location: under TZ=UTC the suite failed,
    // including a test titled "whatever locale the device is in" (review 2026-11-01).
    //
    // Pinned, the three now state the conversion instead of coincidentally agreeing with it: each
    // passes an instant written in ANOTHER zone and expects the device's reading of it.
    env: { TZ: "UTC" },
  },
});
