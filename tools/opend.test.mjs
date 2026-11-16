/** `deploy/macos/opend.sh ensure`, the OpenD watchdog, held against a FAKE OpenD.
 *
 *  Nothing here reaches the real OpenD. The script is run with `OPEND_PATH` pointed at a temporary
 *  directory holding a fake binary at the path the script launches — a python3 that listens on the
 *  ports the fixture's OpenD.xml names (ephemeral ones, never 11111/33333/22222) or sits at a
 *  "login prompt" with them shut — and with a stub `pgrep` first on the PATH that sees only
 *  processes running from that directory. `kill` is the shell's own, so it can only ever be given
 *  a pid the stub found or the fixture's PID file names: a fake.
 *
 *  Written after 2026-11-12, 12:19–12:33, in ~/Library/Logs/optionality-opend.log: OpenD sat at a
 *  login prompt, the owner started a second one by hand to log in, and the watchdog read "process
 *  up, API port shut" as a husk — it stopped one, found the owner's "already running", and two
 *  minutes later killed the owner's too.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SCRIPT = join(ROOT, "deploy", "macos", "opend.sh");
const darwin = process.platform === "darwin";

/** The fake OpenD: python3, so the process keeps the binary's path in its command line (what the
 *  stub pgrep matches) while it listens. `serve` opens the ports named, `prompt` opens none. */
const FAKE = `#!/bin/sh
echo "$$ $FAKE_OPEND_MODE" >> "$FAKE_ROOT/started"
exec python3 -c '
import signal, socket, sys, time
signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
held = []
if sys.argv[2] == "serve":
    for p in sys.argv[3].split(","):
        if p:
            s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("127.0.0.1", int(p))); s.listen(8); held.append(s)
time.sleep(600)
' "$0" "\${FAKE_OPEND_MODE:-serve}" "\${FAKE_OPEND_PORTS:-}"
`;

/** Sees only the fakes: any process whose command line runs from the fixture directory. */
const PGREP = `#!/bin/sh
ps -axo pid=,command= | grep -F "$FAKE_ROOT/OpenD/OpenD.app/" | grep -v grep | awk '{print $1}'
`;

/** A listener of this process's own on `port`: the kernel completes a connect to it even while
 *  spawnSync holds the event loop, which is all a port probe asks. */
function listen(port) {
  return new Promise((resolve) => { const s = createServer().listen(port, "127.0.0.1", () => resolve(s)); });
}

function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const config = ({ api, ws, wsCommented = false }) => `<?xml version="1.0" encoding="UTF-8"?>
<opend>
	<ip>127.0.0.1</ip>
	<api_port>${api}</api_port>
	<websocket_ip>127.0.0.1</websocket_ip>
${ws === null ? "" : wsCommented ? `	<!-- <websocket_port>${ws}</websocket_port> -->` : `	<websocket_port>${ws}</websocket_port>`}
</opend>
`;

let dir, api, ws, bin, stubs;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "opend-"));
  api = await freePort();
  ws = await freePort();
  const app = join(dir, "OpenD", "OpenD.app", "Contents", "MacOS");
  mkdirSync(app, { recursive: true });
  bin = join(app, "OpenD");
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  stubs = join(dir, "bin");
  mkdirSync(stubs);
  writeFileSync(join(stubs, "pgrep"), PGREP);
  chmodSync(join(stubs, "pgrep"), 0o755);
  writeFileSync(join(dir, "OpenD", "OpenD.xml"), config({ api, ws }));
});

afterEach(() => {
  for (const pid of fakes()) {
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Every fake still alive, by the same reading the stub pgrep does. */
function fakes() {
  const out = spawnSync(join(stubs, "pgrep"), [], { encoding: "utf8", env: { ...process.env, FAKE_ROOT: dir } }).stdout;
  return out.split("\n").filter(Boolean).map(Number);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function env(extra = {}) {
  return {
    PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`,
    HOME: dir,
    FAKE_ROOT: dir,
    OPEND_PATH: join(dir, "OpenD"),
    OPEND_LOGIN_ACCOUNT: "12345678",
    OPEND_STARTUP_TIMEOUT: "3",
    FAKE_OPEND_MODE: "serve",
    FAKE_OPEND_PORTS: `${api},${ws}`,
    ...extra,
  };
}

function run(command, extra) {
  const r = spawnSync("zsh", [SCRIPT, command], { encoding: "utf8", env: env(extra), timeout: 30_000 });
  return { status: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}

/** An OpenD started BY HAND: no PID file, the way the owner starts one to log in. */
async function byHand(mode, ports = mode === "serve" ? `${api},${ws}` : "") {
  // through a shell that exits at once, so the fake is orphaned and reaped by launchd as the owner's
  // would be by its terminal — a child of THIS process would linger as a zombie, which `kill -0`
  // still finds, for as long as spawnSync holds the event loop that reaps it
  const r = spawnSync("sh", ["-c", `"${bin}" --cfg_files x >/dev/null 2>&1 & echo $!`], {
    encoding: "utf8", env: env({ FAKE_OPEND_MODE: mode, FAKE_OPEND_PORTS: ports }),
  });
  const pid = Number(r.stdout.trim());
  await settle(() => fakes().includes(pid) && (mode !== "serve" || listening()));
  return pid;
}

/** An OpenD this script started: its pid in the PID file. */
async function byScript(mode) {
  const r = run("start", { FAKE_OPEND_MODE: mode, FAKE_OPEND_PORTS: mode === "serve" ? `${api},${ws}` : "" });
  const pid = Number(readFileSync(join(dir, "OpenD", "opend.pid"), "utf8"));
  expect(alive(pid), r.all).toBe(true);
  return pid;
}

function listening() {
  return spawnSync("nc", ["-z", "-w", "1", "127.0.0.1", String(api)]).status === 0;
}

async function settle(ok, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    if (ok()) return;
  }
  throw new Error("the fake never settled");
}

const starts = () => existsSync(join(dir, "started"))
  ? readFileSync(join(dir, "started"), "utf8").split("\n").filter(Boolean).length : 0;

describe.skipIf(!darwin)("opend.sh ensure, against a fake OpenD", () => {
  it("is quiet and touches nothing when OpenD is up and both of its ports are open", async () => {
    const pid = await byHand("serve");
    const r = run("ensure");
    expect(r.status, r.all).toBe(0);
    expect(r.all).toBe("");
    expect(alive(pid)).toBe(true);
    expect(starts()).toBe(1);
  });

  it("starts OpenD when none is running, and records it as its own", () => {
    const r = run("ensure");
    expect(r.status, r.all).toBe(0);
    expect(r.out).toMatch(/not running; starting it/);
    expect(starts()).toBe(1);
    expect(fakes()).toEqual([Number(readFileSync(join(dir, "OpenD", "opend.pid"), "utf8"))]);
  });

  it("only REPORTS its own OpenD at a login prompt, inside the back-off", async () => {
    const pid = await byScript("prompt");
    const r = run("ensure", { OPEND_RESTART_AFTER: "900" });
    expect(r.status, r.all).toBe(2);
    expect(r.err).toMatch(new RegExp(`127\\.0\\.0\\.1:${api} is shut`));
    expect(r.err).toMatch(/login/);
    expect(alive(pid)).toBe(true);
    expect(starts()).toBe(1);
  });

  it("restarts its OWN OpenD once the port has been shut for longer than the back-off", async () => {
    const pid = await byScript("prompt");
    const r = run("ensure", { OPEND_RESTART_AFTER: "0" });
    expect(r.out, r.all).toMatch(/restarting it/);
    expect(alive(pid)).toBe(false);
    expect(starts()).toBe(2);
  });

  it("restarts its own at most ONCE while the port stays shut, and again only after it has opened", async () => {
    // a rejected credential: the restarted OpenD sits at the same prompt, and a per-pid timer gave it
    // a fresh 15 minutes and another restart, for ever
    await byScript("prompt");
    const tick = () => run("ensure", { OPEND_RESTART_AFTER: "0", FAKE_OPEND_MODE: "prompt", FAKE_OPEND_PORTS: "" });
    expect(tick().out).toMatch(/restarting it, once/);
    expect(starts()).toBe(2);
    const later = [tick(), tick(), tick()];
    expect(starts()).toBe(2);
    expect(later.map((r) => r.status)).toEqual([2, 2, 2]);
    expect(later[0].err).toMatch(/restarted it\s+once\. Not restarting again until the port has opened/);

    // the port opens (a login by hand at the window): the episode is over
    const open = await Promise.all([api, ws].map((port) => listen(port)));
    expect(tick().status).toBe(0);
    expect(existsSync(join(dir, "OpenD", "opend.shut-since"))).toBe(false);
    await Promise.all(open.map((server) => new Promise((r) => server.close(r))));
    // and a new one may be restarted once more
    expect(tick().out).toMatch(/restarting it, once/);
    expect(starts()).toBe(3);
  });

  it("times the back-off from when it first saw the port shut, not from each tick", async () => {
    await byScript("prompt");
    expect(run("ensure", { OPEND_RESTART_AFTER: "900" }).status).toBe(2);
    const since = join(dir, "OpenD", "opend.shut-since");
    expect(readFileSync(since, "utf8").trim()).toMatch(/^\d+ 0$/);
    writeFileSync(since, `${Math.floor(Date.now() / 1000) - 901} 0\n`);
    const r = run("ensure", { OPEND_RESTART_AFTER: "900" });
    expect(r.out, r.all).toMatch(/restarting it/);
    expect(starts()).toBe(2);
  });

  it("never kills an OpenD it did not start, however long its port stays shut", async () => {
    const pid = await byHand("prompt");
    const r = run("ensure", { OPEND_RESTART_AFTER: "0" });
    expect(r.status, r.all).toBe(2);
    expect(r.err).toMatch(/not started by this script/);
    // the script's own path, not zsh's $0 inside a function ("run `ensure stop`")
    expect(r.err).toContain(`run \`${SCRIPT} stop\``);
    expect(alive(pid)).toBe(true);
    expect(starts()).toBe(1);
  });

  it("leaves both alone when the owner has started a second OpenD beside its own (2026-11-12)", async () => {
    const own = await byScript("prompt");
    const hand = await byHand("prompt");
    const r = run("ensure", { OPEND_RESTART_AFTER: "0" });
    expect(r.status, r.all).toBe(2);
    expect(alive(own)).toBe(true);
    expect(alive(hand)).toBe(true);
    expect(starts()).toBe(2);
  });

  it("never kills a process a stale PID file names when it is not OpenD", async () => {
    const other = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
    other.unref();
    writeFileSync(join(dir, "OpenD", "opend.pid"), `${other.pid}\n`);
    const hand = await byHand("prompt");
    const r = run("ensure", { OPEND_RESTART_AFTER: "0" });
    expect(r.status, r.all).toBe(2);
    expect(alive(other.pid)).toBe(true);
    expect(alive(hand)).toBe(true);
    process.kill(other.pid, "SIGKILL");
  });

  it("starts OpenD, and kills nothing, when a stale PID file names a live process that is not OpenD", () => {
    // a reused pid: without the check that it is still an OpenD, `ensure` took it for its own husk
    const other = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
    other.unref();
    writeFileSync(join(dir, "OpenD", "opend.pid"), `${other.pid}\n`);
    const r = run("ensure", { OPEND_RESTART_AFTER: "0" });
    expect(r.status, r.all).toBe(0);
    expect(r.out).toMatch(/not running; starting it/);
    expect(alive(other.pid)).toBe(true);
    expect(starts()).toBe(1);
    process.kill(other.pid, "SIGKILL");
  });

  it("reports a shut websocket port with the API port open, and restarts nothing", async () => {
    const pid = await byHand("serve", `${api}`);
    const r = run("ensure");
    expect(r.status, r.all).toBe(2);
    expect(r.err).toMatch(new RegExp(`websocket.*127\\.0\\.0\\.1:${ws}.*shut`, "s"));
    expect(alive(pid)).toBe(true);
    expect(starts()).toBe(1);
  });

  it("reports a fault again when it returns soon after a recovery, inside the repeat window", async () => {
    await byHand("serve", `${api}`);
    const tick = () => run("ensure", { OPEND_REPORT_EVERY: "1800" });
    expect(tick().err).toMatch(/websocket.*shut/s);
    const server = await listen(ws);
    expect(tick()).toMatchObject({ status: 0, all: "" });
    await new Promise((r) => server.close(r));
    expect(tick().err).toMatch(/websocket.*shut/s);
  });

  it("reports a websocket commented out of OpenD.xml, as an OpenD `update` leaves it (2026-11-11)", async () => {
    writeFileSync(join(dir, "OpenD", "OpenD.xml"), config({ api, ws, wsCommented: true }));
    const pid = await byHand("serve");
    const r = run("ensure");
    expect(r.status, r.all).toBe(2);
    expect(r.err).toMatch(/websocket.*OFF.*OpenD\.xml/s);
    expect(alive(pid)).toBe(true);
  });

  it("says a report once, not on every tick, until the state changes", async () => {
    await byHand("prompt");
    const first = run("ensure", { OPEND_REPORT_EVERY: "1800" });
    const second = run("ensure", { OPEND_REPORT_EVERY: "1800" });
    expect(first.err).toMatch(/is shut/);
    expect(second.status).toBe(2);
    expect(second.all).toBe("");
  });
});

describe.skipIf(!darwin)("opend.sh stop", () => {
  it("stops every OpenD running, not only the one its PID file names", async () => {
    const own = await byScript("prompt");
    const hand = await byHand("prompt");
    const r = run("stop");
    expect(r.status, r.all).toBe(0);
    await settle(() => !alive(own) && !alive(hand));
    expect(fakes()).toEqual([]);
  });
});
