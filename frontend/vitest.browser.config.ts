import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { devices } from "playwright";
import type { BrowserCommand } from "vitest/node";
import { defineConfig } from "vitest/config";

/** Switch the page between the light and the dark scheme. The redesign is read at night (ADR 0023,
 *  "dark first"), so its colours are measured in BOTH schemes, and the browser context is the only
 *  thing that can set `prefers-color-scheme`. A test calls it as `commands.colorScheme("dark")`. */
const colorScheme: BrowserCommand<["light" | "dark"]> = async (context, scheme) => {
  const { page } = context as unknown as { page: { emulateMedia: (o: object) => Promise<void> } };
  await page.emulateMedia({ colorScheme: scheme });
};


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
  // Vite pre-bundles the dependencies it finds by scanning the suite's entry files, and it finds
  // those through `include` — which is empty below on purpose. Without naming them here nothing was
  // pre-bundled, every dependency was discovered mid-run, and the reload that follows failed ten
  // files on every run from a cold cache (measured 2026-11-10, twice; main's config: no reload).
  optimizeDeps: { entries: ["src/__browser__/**/*.test.tsx"] },
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
      commands: { colorScheme },
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
