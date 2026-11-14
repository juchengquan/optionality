/** The build's one HTML entry: `index.html`, the dashboard at `/opt`. A second, `next/index.html`,
 *  sent bookmarks of `/opt/next` on to `/opt/` from the swap (#301) until #364 removed it, and this
 *  holds that it stays gone: a page there would be a second dashboard, or a redirect nobody owns.
 *
 *  Read as text because nothing else holds them: no suite loads an HTML entry.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FRONTEND = [".", "frontend"].map((d) => resolve(process.cwd(), d))
  .find((d) => existsSync(`${d}/index.html`) && existsSync(`${d}/vite.config.ts`))!;
const read = (file: string) => readFileSync(`${FRONTEND}/${file}`, "utf8");

describe("the HTML entries", () => {
  it("serves the dashboard at /opt", () => {
    const page = read("index.html");
    expect(page).toContain(`<script type="module" src="/src/main.tsx"></script>`);
    expect(page).toContain(`viewport-fit=cover`);
  });

  it("has no /opt/next page, in the source or the build's inputs (#364)", () => {
    expect(existsSync(`${FRONTEND}/next/index.html`)).toBe(false);
    expect(read("vite.config.ts")).not.toMatch(/next\/index\.html"/);
  });
});
