/** The dashboard's first load (#483), held against what is actually served: the COMMITTED bundle,
 *  `frontend/dist`, served by the real `deploy/Caddyfile`, and opened in a real browser.
 *
 *  Three things only the build and the server can say. Which files each page asks for — the book
 *  none of the account page's code and the account page none of the book's, each file once — which
 *  no suite of the source sees, since none of them loads the build. Which encoding Caddy answers
 *  with: zstd to a browser that offers it, gzip to one that offers only that, the file as it is to
 *  one that offers neither. And which file names a change to one page moves, by building again with
 *  that page touched: its own chunk and the entry, never the libraries or the other page — a name
 *  that moves is a file every phone downloads again after the deploy.
 *
 *  Caddy runs on a port of its own, never the live UI's 31416: the Caddyfile is copied with its
 *  listener moved, and `/opt` is stripped first, as `tailscale serve --set-path /opt` strips it in
 *  front of the live one. Its config and data directories are the test's own, so nothing it writes
 *  lands beside the live Caddy's. */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

import { chromium, devices } from "playwright";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DIST = join(ROOT, "frontend/dist");
const LIVE_LISTENER = ":31416 {";
const CADDY = process.env.CADDY_BIN || spawnSync("sh", ["-c", "command -v caddy"], { encoding: "utf8" }).stdout.trim();

function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** One GET, offering `encoding` (none at all when null): the status, the encoding answered, the body. */
function get(port, path, encoding) {
  return new Promise((resolve, reject) => {
    const headers = encoding === null ? {} : { "Accept-Encoding": encoding };
    request({ host: "127.0.0.1", port, path, headers }, (res) => {
      const parts = [];
      res.on("data", (b) => parts.push(b));
      res.on("end", () => resolve({ status: res.statusCode, encoding: res.headers["content-encoding"] ?? null, body: Buffer.concat(parts) }));
    }).on("error", reject).end();
  });
}

let dir, caddy, port, log = "";

beforeAll(async () => {
  if (!CADDY) throw new Error("caddy not found — brew install caddy (the dashboard's server, ADR 0006)");
  const config = readFileSync(join(ROOT, "deploy/Caddyfile"), "utf8");
  // the listener moved, or this would be a second Caddy on the live UI's port
  if (config.split(LIVE_LISTENER).length !== 2) throw new Error(`deploy/Caddyfile has no single "${LIVE_LISTENER}" to move`);
  port = await freePort();
  dir = mkdtempSync(join(tmpdir(), "first-load-"));
  writeFileSync(join(dir, "Caddyfile"), config.replace(LIVE_LISTENER, `:${port} {\n\turi strip_prefix /opt`));
  caddy = spawn(CADDY, ["run", "--config", join(dir, "Caddyfile"), "--adapter", "caddyfile"], {
    env: { ...process.env, OPTIONALITY_UI_ROOT: DIST, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir },
    stdio: ["ignore", "ignore", "pipe"],
  });
  caddy.stderr.on("data", (b) => { log += b; });
  for (let i = 0; i < 100; i++) {
    try { if ((await get(port, "/opt/", null)).status === 200) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`caddy did not answer on ${port}:\n${log}`);
});

afterAll(() => {
  if (caddy?.exitCode === null) caddy.kill("SIGKILL");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const assets = () => readdirSync(join(DIST, "assets"));
const named = (prefix) => assets().filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".js"));

describe("the encoding Caddy answers with (#483)", () => {
  const file = () => `/opt/assets/${named("libraries")[0]}`;
  const onDisk = () => readFileSync(join(DIST, file().replace("/opt/", "")));

  it("is zstd to a browser that offers it, whatever else it offers first", async () => {
    for (const offer of ["zstd", "gzip, deflate, br, zstd", "zstd, gzip"]) {
      const res = await get(port, file(), offer);
      expect(res.encoding, offer).toBe("zstd");
      expect(zstdDecompressSync(res.body).equals(onDisk())).toBe(true);
    }
  });

  it("is zstd at a level that saves something over gzip: at its default it saved nothing", async () => {
    const zstd = (await get(port, file(), "zstd")).body.length;
    const gzip = (await get(port, file(), "gzip")).body.length;
    expect(zstd, `zstd ${zstd} bytes, gzip ${gzip}`).toBeLessThan(0.95 * gzip);
  });

  it("is gzip to one that offers gzip and no zstd, as a Safari before zstd does", async () => {
    for (const offer of ["gzip", "gzip, deflate, br"]) {
      const res = await get(port, file(), offer);
      expect(res.encoding, offer).toBe("gzip");
      expect(gunzipSync(res.body).equals(onDisk())).toBe(true);
    }
  });

  it("is the file as it is to one that offers neither", async () => {
    for (const offer of [null, "identity", "br"]) {
      const res = await get(port, file(), offer);
      expect(res.encoding, String(offer)).toBeNull();
      expect(res.body.equals(onDisk())).toBe(true);
    }
  });
});

describe("the files each page asks for (#483)", () => {
  let browser;
  const asked = {}, askedAt = {}, arrivedAt = {};

  beforeAll(async () => {
    expect(named("libraries"), "one libraries chunk").toHaveLength(1);
    expect(named("Next"), "one chunk for the book").toHaveLength(1);
    expect(named("Account"), "one chunk for the account page").toHaveLength(1);
    browser = await chromium.launch();
    // the phone, as the slow link is the phone's; Chromium's rather than the profile's WebKit,
    // because Chromium is what the suites install
    const { defaultBrowserType: _, ...iphone } = devices["iPhone 13"];
    for (const [page, path] of [["book", "/opt/"], ["account", "/opt/account"]]) {
      const context = await browser.newContext(iphone);
      const tab = await context.newPage();
      // the API is not served here: refused at once, so each page draws its own failure words
      await tab.route("**/api/**", (route) => route.abort());
      // every round trip 200 ms longer, so which file was asked for before which arrived is plain
      const cdp = await context.newCDPSession(tab);
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 200, downloadThroughput: -1, uploadThroughput: -1 });
      const files = [], at = {}, arrived = {};
      const asset = (r) => (/\/assets\//.test(r.url()) ? r.url().split("/assets/")[1] : null);
      tab.on("request", (r) => { const f = asset(r); if (f) { files.push(f); at[f] ??= Date.now(); } });
      tab.on("requestfinished", (r) => { const f = asset(r); if (f) arrived[f] ??= Date.now(); });
      await tab.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: "networkidle" });
      await tab.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
      asked[page] = files; askedAt[page] = at; arrivedAt[page] = arrived;
      await context.close();
    }
  });

  afterAll(async () => { await browser?.close(); });

  it("the book asks for its own code and the libraries, and none of the account page's", () => {
    expect(asked.book).toEqual(expect.arrayContaining([...named("Next"), ...named("libraries")]));
    expect(asked.book.filter((f) => f.startsWith("Account-"))).toEqual([]);
  });

  it("the account page asks for its own code and the libraries, and none of the book's", () => {
    expect(asked.account).toEqual(expect.arrayContaining([...named("Account"), ...named("libraries")]));
    expect(asked.account.filter((f) => f.startsWith("Next-"))).toEqual([]);
  });

  it("each page asks for its own code while the libraries are still arriving, not after them", () => {
    // a page's chunk asked for by its import alone waits for every byte of the libraries first:
    // a second round trip, which made the split slower cold than the one bundle it replaced
    for (const [page, own] of [["book", named("Next")[0]], ["account", named("Account")[0]]]) {
      const libraries = named("libraries")[0];
      expect(askedAt[page][own], `${page}: ${own} asked for after ${libraries} arrived`).toBeLessThan(arrivedAt[page][libraries]);
    }
  });

  it("each page asks for each file once: the HTML's early request and the page's own import agree", () => {
    for (const page of ["book", "account"]) {
      expect(asked[page].filter((f, i) => asked[page].indexOf(f) !== i), page).toEqual([]);
    }
  });

  it("every file the build wrote is asked for by one page or the other", () => {
    const either = new Set([...asked.book, ...asked.account]);
    expect(assets().filter((f) => !either.has(f))).toEqual([]);
  });
});

describe("the names a deploy moves (#483)", () => {
  /** The build's file names, with `module`'s code touched first (`null`: as it is). */
  async function namesWith(module) {
    const outDir = mkdtempSync(join(tmpdir(), "first-load-build-"));
    const target = module && join(ROOT, "frontend", module);
    const touch = { name: "touch", enforce: "pre", transform: (code, id) => (id === target ? `${code}\nconsole.debug("touched");\n` : null) };
    try {
      await build({
        configFile: join(ROOT, "frontend/vite.config.ts"), root: join(ROOT, "frontend"), base: "/opt/", logLevel: "silent",
        build: { outDir, emptyOutDir: true }, plugins: [touch],
      });
      return new Set(readdirSync(join(outDir, "assets")));
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
  const moved = (before, after) => [...after].filter((f) => !before.has(f)).map((f) => f.replace(/-[\w-]+\.(js|css)$/, ".$1")).sort();

  let as;
  beforeAll(async () => { as = await namesWith(null); });

  it("a change to the account page alone renames its own chunk and the entry, and nothing else", async () => {
    expect(moved(as, await namesWith("src/account/Account.tsx"))).toEqual(["Account.js", "main.js"]);
  });

  it("a change to the book alone renames its own chunk and the entry — never the libraries", async () => {
    expect(moved(as, await namesWith("src/Next.tsx"))).toEqual(["Next.js", "main.js"]);
  });

  it("a change to the code both pages share renames what imports it — never the libraries", async () => {
    expect(moved(as, await namesWith("src/pages.ts"))).not.toContain("libraries.js");
  });
});
