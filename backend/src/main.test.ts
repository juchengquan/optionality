/** The process, booted.
 *
 *  `make check-api` loads every other module in this package to prove Node can run it — and skips
 *  this one by name, because importing `main.ts` starts the service. So the one file that IS the
 *  service was checked by nothing: not the typecheck, which accepts syntax Node refuses; not
 *  `check-loads`, which skips it; not the suite, which never mentions it. Two classes once reached
 *  main unable to load at all, which is the whole reason `check-loads` exists.
 *
 *  Booting it is the only honest check, so that is what this does: spawn it with a setting it must
 *  refuse, and read what it says. That proves three things at once — the file and everything it
 *  imports load under Node, a fatal misconfiguration is fatal rather than a service running on a
 *  default, and the message names what to fix. CLAUDE.md calls a boot failure "fatal on purpose":
 *  launchd keeps trying, so the log is the only thing that tells the owner why.
 *
 *  Each case must die BEFORE anything is served. The order in `main.ts` is the port (it is the lock
 *  between two backends, ADR 0021), then settings, then the database, then the vendors, and only
 *  then is the app attached — so a taken port touches nothing, a refused setting never opens a
 *  file, and a refused Provider opens only the throwaway database named here. The environment is
 *  built from nothing rather than inherited: no bot flag and no Telegram token, so a boot cannot
 *  become a second `getUpdates` consumer or send the owner a message (CLAUDE.md), and `PORT=0`
 *  by default, so the port each case takes first is never the live one.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { startFakeGateway, type FakeGateway } from "optionality/vendors/ibkr/fake";

import { createSingleMonitor } from "./create-monitor.ts";
import { createDatabase } from "./db/open.ts";

const MAIN = join(import.meta.dirname, "main.ts");

/** A port some other process already holds, as a second backend would find it. */
const occupied: Server[] = [];
afterAll(() => { for (const s of occupied) s.close(); });
function occupy(): Promise<number> {
  return new Promise((resolve) => {
    const other = createServer();
    occupied.push(other);
    other.listen(0, "127.0.0.1", () => {
      const address = other.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

/** Boot it, and give back what it said and how it died. */
function boot(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { PATH: process.env.PATH ?? "", PORT: "0", ...env },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    // it must exit on its own; killing it would make a hung boot look like a refusal
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

describe("booting the service", () => {
  it("refuses a knob it cannot read, and says which one", async () => {
    // the failure this is really for: a renamed or mistyped variable silently reverting a setting
    // the owner has made (env.ts). It dies before the database is opened.
    const { code, stderr } = await boot({ MONITOR_INTERVAL_SECONDS: "every minute" });
    expect(code, "a service that cannot read its settings must not start").not.toBe(0);
    expect(stderr).toMatch(/MONITOR_INTERVAL_SECONDS/);
  }, 30_000);

  it("takes the port before it touches anything, and stops if another backend holds it", async () => {
    // the port is the lock between the two backends (ADR 0021): a second process must die having
    // opened nothing. The database is the witness, because `openDatabase` creates a missing file:
    // if this boot got as far as the database, the file below would exist afterwards.
    const port = await occupy();
    const db = join(mkdtempSync(join(tmpdir(), "boot-")), "never-opened.db");
    const { code, stderr } = await boot({
      PORT: String(port), OPTIONALITY_DB_PATH: db, MOOMOO_WS_PORT: "1",
    });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(new RegExp(`port ${port} on 127\\.0\\.0\\.1 is taken`));
    expect(existsSync(db), "a refused boot must not have opened the database").toBe(false);
  }, 30_000);

  it("refuses a Provider no vendor carries, naming the ones that exist", async () => {
    // past the settings and the migrations, into `openVendors` — so this also proves the database
    // and vendor layers load. The file is STAMPED rather than left empty, because that is what a
    // real one is: `openDatabase` opens an existing database and `main.ts` migrates it, so an
    // empty file fails on migration 0001 with `no such table: positions` instead of reaching the
    // Provider. (Loud and fatal, as CLAUDE.md intends — but it is not what this case is about.)
    const db = join(mkdtempSync(join(tmpdir(), "boot-")), "optionality-ts.db");
    createDatabase(db).close();
    const { code, stderr } = await boot({ OPTIONALITY_PROVIDER: "nope", OPTIONALITY_DB_PATH: db });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/unknown provider 'nope'/);
    expect(stderr, "the message must offer the names that do exist").toMatch(/moomoo/);
  }, 30_000);
});

/** Boot it to SERVE, and give back the port it took once it says it is up. The caller stops it. */
function serve(env: Record<string, string>): Promise<{ child: ChildProcess; port: number; log: () => string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", PORT: "0", ...env },
    });
    let log = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`never came up:\n${log}`)); }, 20_000);
    const read = (chunk: Buffer) => {
      log += String(chunk);
      const up = /optionality backend on 127\.0\.0\.1:(\d+)/.exec(log);
      if (up) { clearTimeout(timer); resolve({ child, port: Number(up[1]), log: () => log }); }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`exited ${code}:\n${log}`)); });
  });
}

describe("IB Gateway as the Provider", () => {
  // The descriptor handed the client's own instance on as the Provider, and `main.ts` hands its
  // `fetchQuotes` on DETACHED — to the sweeper, the bot and every route — so every call failed
  // with "this.close is not a function" from inside the client. Only a boot shows it: the
  // harness's Providers are closures, which have no `this` to lose.
  let gateway: FakeGateway;
  let child: ChildProcess | undefined;
  afterAll(async () => {
    child?.kill("SIGTERM");
    await gateway?.close();
  });

  it("sweeps and answers /quotes through the gateway", async () => {
    // the recorded option, moved to 2099 so that no real date ever expires the rule under test:
    // the boot reads the real clock
    const first = await startFakeGateway(0);
    const recorded = first.conversation;
    await first.close();
    const moved = JSON.parse(JSON.stringify(recorded)
      .replaceAll("20261218", "20991218").replaceAll("261218", "991218"));
    gateway = await startFakeGateway(0, { conversation: moved });
    const code = "US.SPXW991218C8100000";

    const path = join(mkdtempSync(join(tmpdir(), "boot-")), "optionality-ts.db");
    const db = createDatabase(path);
    await createSingleMonitor({
      db, now: () => new Date(),
      fetchQuotes: async (codes) => ({ records: codes.map((c) => ({ code: c })), unknown: [] }),
    }, { strike_date: "2099-12-18", option_type: "CALL", strike: 8100, threshold: 0.3 });
    db.close();

    const up = await serve({
      OPTIONALITY_DB_PATH: path, OPTIONALITY_PROVIDER: "ibkr",
      IBKR_HOST: "127.0.0.1", IBKR_PORT: String(gateway.port), IBKR_CLIENT_ID: "31499",
    });
    child = up.child;
    const base = `http://127.0.0.1:${up.port}`;

    // the first sweep runs at boot; wait for it to have been judged
    let health: any;
    for (let i = 0; i < 100; i++) {
      health = await (await fetch(`${base}/health`)).json();
      if (health.monitor?.last_sweep_at) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(health.provider, up.log()).toEqual({ name: "ibkr", ok: true });
    expect(health.monitor.last_sweep_ok, up.log()).toBe(true);

    const resp = await fetch(`${base}/quotes`);
    expect(resp.status, up.log()).toBe(200);
    const quotes = await resp.json();
    expect(quotes.map((q: { code: string }) => q.code)).toContain(code);
    expect(up.log()).not.toMatch(/is not a function/);
  }, 40_000);
});
