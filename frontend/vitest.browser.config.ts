import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { devices } from "playwright";
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
    // EMPTY, deliberately: each instance below names its own files. An instance's list is merged
    // INTO this one, not put in its place — with the suite's pattern here every desktop test ran
    // a second time under the iPhone profile, and with nothing here vitest's own default pattern
    // was merged in and both instances ran the jsdom suite as well (measured, 2026-11-10).
    include: [],
    browser: {
      enabled: true,
      provider: "playwright",
      headless: true,
      // Two instances of the one browser. The second is an iPhone as Playwright profiles it —
      // `isMobile`, touch, its user agent and its 390px width — and runs only the `.iphone.` files:
      // ADR 0023 has the redesign measured "at an iPhone profile", because a 390px desktop window
      // is not a phone (it has a fine pointer and hover, and no viewport meta to honour). Kept to
      // its own files so every existing test still runs once, at the desktop it was written for.
      instances: [
        {
          browser: "chromium",
          include: ["src/__browser__/**/*.test.tsx"],
          exclude: ["**/node_modules/**", "src/__browser__/**/*.iphone.test.tsx"],
        },
        {
          browser: "chromium", name: "iphone",
          include: ["src/__browser__/**/*.iphone.test.tsx"],
          // Chromium, not the profile's WebKit: the suite has one browser installed, and what is
          // measured here is layout and touch emulation, which Chromium does from these options
          context: { ...devices["iPhone 13"], defaultBrowserType: undefined } as never,
          viewport: devices["iPhone 13"].viewport,
        },
      ],
    },
  },
});
