import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // must mirror vite.config.ts: these are separate files, and shadcn's components
  // import each other through "@/", so without this every test that touches one fails
  // to resolve rather than fails an assertion
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // __browser__ is the other suite: it needs a real layout engine (ADR 0008)
  //
  // Two `setupFiles`, and only these: `testing/keys.setup.ts`, which fails a test whose page drew two
  // children with one key (#368) — React only logs it — and the zone's reset below. Nothing else is
  // set up, deliberately. Phase 0
  // planned stubs for ResizeObserver, matchMedia and friends, on the grounds that jsdom lacks them.
  // jsdom does lack them — but Base UI guards their absence itself, verified by running the
  // components with the stubs removed, so the stubs were dropped rather than shipped dead. If a
  // later change crashes inside a positioning engine, that is what this note is for.
  // (`NextDesk.test.tsx` opens the column picker's real `Popover` and finds its content through the
  // portal with `screen.findByRole`.)
  test: {
    environment: "jsdom",
    globals: true,
    // and `testing/zone.setup.ts`, which clears the page's DISPLAY_TZ after each test (part F): module
    // state, set from /health, that one test must not hand the next
    setupFiles: ["src/testing/keys.setup.ts", "src/testing/zone.setup.ts"],
    exclude: ["**/node_modules/**", "src/__browser__/**"],
    // TZ=UTC, as backend/vitest.config.ts has always had it — and for a sharper reason here.
    // `snapshotName`, and the screen's own clock before it was retired, deliberately read the
    // DEVICE's zone, which is what "when this screen last fetched" meant, so three tests were asserting a wall clock that only held at
    // +08. The gate was green by accident of the owner's location: under TZ=UTC the suite failed,
    // including a test titled "whatever locale the device is in" (review 2026-11-01).
    //
    // Pinned, the three now state the conversion instead of coincidentally agreeing with it: each
    // passes an instant written in ANOTHER zone and expects the device's reading of it.
    env: { TZ: "UTC" },
  },
});
