/** What the build's two HTML entries are since the swap (#301, ADR 0023): `index.html` is the
 *  dashboard at `/opt`, and `next/index.html`, where the redesign was built beside the old page,
 *  only sends a bookmark of `/opt/next` on to `/opt/`.
 *
 *  Read as text because nothing else holds them: no suite loads an HTML entry, and the redirect has
 *  no module of its own to test. `%BASE_URL%` is Vite's spelling of the build's base (UI_BASE), so
 *  the redirect names the prefix the bundle was built for rather than a second copy of it.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FRONTEND = [".", "frontend"].map((d) => resolve(process.cwd(), d))
  .find((d) => existsSync(`${d}/next/index.html`))!;
const read = (file: string) => readFileSync(`${FRONTEND}/${file}`, "utf8");

describe("the HTML entries", () => {
  it("serves the redesign at /opt", () => {
    const page = read("index.html");
    expect(page).toContain(`<script type="module" src="/src/next/main.tsx"></script>`);
    expect(page).toContain(`viewport-fit=cover`);
  });

  it("sends /opt/next on to /opt/, with and without script", () => {
    const page = read("next/index.html");
    expect(page).toContain(`<meta http-equiv="refresh" content="0; url=%BASE_URL%" />`);
    expect(page).toContain(`location.replace("%BASE_URL%" + location.search + location.hash)`);
    // and runs no page of its own: a module script here would be a second dashboard
    expect(page).not.toMatch(/type="module"/);
  });
});
