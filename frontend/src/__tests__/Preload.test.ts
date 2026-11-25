/** The script `index.html` runs before any module (#483, `preload.ts`): it asks for the files of the
 *  page the path names, by `pageAt`'s own rule, and nothing of the other page's. Run here as the
 *  browser runs it — as text — at every path `pageAt`'s own cases name. */
import { afterEach, describe, expect, it } from "vitest";

import { pageAt } from "../pages";
import { preloadScript, type PageFiles } from "../preload";

const FILES: PageFiles = {
  account: ["/opt/assets/Account-a.js", "/opt/assets/shared-b.js", "/opt/assets/Account-c.css"],
  book: ["/opt/assets/Next-d.js", "/opt/assets/shared-b.js", "/opt/assets/Next-e.css"],
};

const PATHS = ["/opt/account", "/opt/account/", "/opt/", "/opt", "/opt/accounts", "/opt/next", "/opt/account/x",
  "/account", "/api/account"];

/** What the script asked for, run at `path`: each link as `rel as crossorigin href`. */
function askedAt(path: string, base = "/opt/"): string[] {
  document.head.innerHTML = "";
  window.history.replaceState(null, "", path);
  new Function(preloadScript(FILES, base))();
  return [...document.head.querySelectorAll("link")]
    .map((l) => [l.rel, l.getAttribute("as") ?? "-", l.hasAttribute("crossorigin") ? "crossorigin" : "-", l.getAttribute("href")].join(" "));
}

afterEach(() => { document.head.innerHTML = ""; window.history.replaceState(null, "", "/"); });

describe("the HTML's own request for the page's files (#483)", () => {
  for (const path of PATHS) {
    it(`asks at ${path} for exactly the files of the page pageAt names`, () => {
      const page = pageAt(path, "/opt/");
      expect(askedAt(path).map((l) => l.split(" ").at(-1))).toEqual(FILES[page]);
    });
  }

  it("asks for a script as a module and a style as a style, each as Vite asks for it", () => {
    // crossorigin on each, or the browser asks again when the import does: a module is fetched
    // with CORS, and Vite adds its stylesheet so
    expect(askedAt("/opt/account")).toEqual([
      "modulepreload - crossorigin /opt/assets/Account-a.js",
      "modulepreload - crossorigin /opt/assets/shared-b.js",
      "preload style crossorigin /opt/assets/Account-c.css",
    ]);
  });

  it("reads the base it is given, as the dev server's root", () => {
    expect(askedAt("/account", "/").at(0)).toContain("Account-a.js");
    expect(askedAt("/", "/").at(0)).toContain("Next-d.js");
  });
});
