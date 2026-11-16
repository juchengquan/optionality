/** `make deploy`, the REAL recipe, run against a fixture repository with only its leaf commands
 *  stubbed — never launchctl, never the live tree, never port 31415.
 *
 *  The fixture is an `origin` and a `live` clone of it, holding this branch's Makefile and the
 *  scripts the recipe runs: `use-backend.mjs` and `check-module-map.mjs` for real (the guard, and
 *  the restart and its health wait), stubs for the workspace-link check and the backup, and the
 *  installs (`JS_INSTALL`, `UV_SYNC`) replaced on the make command line. `launchctl` is a stub first
 *  on the PATH, and the "API" is a python3 HTTP server on an ephemeral port that the stub's
 *  `kickstart` replaces, as launchd would. `FAIL_AT` makes one step fail.
 *
 *  Written after 2026-11-12: `make deploy` pulled first, so a failure in anything after the pull
 *  left the NEW frontend/dist live — Caddy serves it from disk — in front of the OLD API. And it
 *  printed "both services restarted" without asking either one.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const darwin = process.platform === "darwin";

const STEP = `#!/bin/sh
echo "$1 $(pwd -P)" >> "$DEPLOY_LOG"
if [ "$FAIL_AT" = "$1" ]; then echo "stub: $1 failed" >&2; exit 1; fi
if [ "$HANG_AT" = "$1" ]; then touch "$DEPLOY_LOG.hung"; sleep 30; fi
`;

/** A node script standing in for one of the recipe's own, at the same path. */
const nodeStep = (name) => `import { appendFileSync } from "node:fs";
appendFileSync(process.env.DEPLOY_LOG, \`${name} \${process.cwd()}\\n\`);
if (process.env.FAIL_AT === "${name}") { console.error("stub: ${name} failed"); process.exit(1); }
`;

const API = `import http.server, sys
port, status = int(sys.argv[1]), int(sys.argv[2])
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(status); self.end_headers(); self.wfile.write(b"{}")
    def log_message(self, *a):
        pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
`;

/** launchd, for the two agents deploy restarts: a kickstart of the API replaces the fake API with a
 *  new process (answering 503 when FAIL_AT=health), unless FAIL_AT=kickstart-noop. */
const LAUNCHCTL = `#!/bin/sh
echo "launchctl $*" >> "$DEPLOY_LOG"
case "$1 $3" in
  "kickstart "*/com.optionality.api)
    [ "$FAIL_AT" = "kickstart-noop" ] && exit 0
    old=$(cat "$FAKE_API_PID")
    kill "$old"
    while kill -0 "$old" 2>/dev/null; do sleep 0.05; done
    status=200; [ "$FAIL_AT" = "health" ] && status=503
    python3 "$FAKE_API" "$FAKE_API_PORT" "$status" >/dev/null 2>&1 &
    echo $! > "$FAKE_API_PID"
    ;;
esac
exit 0
`;

function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

let dir, live, origin, seed, home, stubs, log, apiPort, apiPid;

function write(path, text, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode) chmodSync(path, mode);
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** The fixture repository's files: this branch's Makefile and the real scripts deploy runs, stubs
 *  for the rest, and a bundle that says which commit it is. */
function populate(repo, bundle, makefile = readFileSync(join(ROOT, "Makefile"), "utf8")) {
  write(join(repo, "Makefile"), makefile);
  for (const f of ["tools/use-backend.mjs", "tools/check-module-map.mjs", "deploy/macos/optionality-api.launchd.plist.template"]) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    copyFileSync(join(ROOT, f), join(repo, f));
  }
  write(join(repo, "tools/check-workspace-links.mjs"), nodeStep("links"));
  write(join(repo, "backend/tools/backup/backup.ts"), nodeStep("backup"));
  write(join(repo, "backend/tools/backup/prune-deploy.ts"), nodeStep("prune"));
  write(join(repo, "frontend/dist/index.html"), bundle);
  write(join(repo, ".gitignore"), "/data/\n");
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "deploy-")));
  home = join(dir, "home");
  stubs = join(dir, "stubs");
  log = join(dir, "deploy.log");
  write(join(stubs, "step"), STEP, 0o755);
  write(join(stubs, "launchctl"), LAUNCHCTL, 0o755);
  write(join(dir, "api.py"), API);

  origin = join(dir, "origin.git");
  seed = join(dir, "seed");
  live = join(dir, "live");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "init", "-q", "-b", "main", seed);
  populate(seed, "bundle A");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "A");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "-u", "origin", "main");
  git(dir, "clone", "-q", origin, live);
  mkdirSync(join(live, "data"));

  // what the API agent runs, as `use-backend.mjs installed` reads it
  installPlist("ts");

  apiPort = await freePort();
  const r = spawnSync("sh", ["-c", `python3 "${join(dir, "api.py")}" ${apiPort} 200 >/dev/null 2>&1 & echo $!`], { encoding: "utf8" });
  apiPid = Number(r.stdout.trim());
  writeFileSync(join(dir, "api.pid"), `${apiPid}\n`);
  for (let i = 0; i < 100 && !(await answers()); i++) await new Promise((res) => setTimeout(res, 50));
});

afterEach(() => {
  for (const pid of [apiPid, Number(readFileSync(join(dir, "api.pid"), "utf8"))]) {
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  rmSync(dir, { recursive: true, force: true });
});

async function answers() {
  try { return (await fetch(`http://127.0.0.1:${apiPort}/health`)).status === 200; } catch { return false; }
}

function installPlist(backend) {
  // rendered by this repository's own script; the guard refuses a Python the FIXTURE cannot back
  const plist = join(home, "Library", "LaunchAgents", "com.optionality.api.plist");
  const template = readFileSync(join(ROOT, "deploy/macos/optionality-api.launchd.plist.template"), "utf8");
  mkdirSync(dirname(plist), { recursive: true });
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { renderPlist } from ${JSON.stringify(join(ROOT, "tools/use-backend.mjs"))};
    process.stdout.write(renderPlist(${JSON.stringify(backend)}, { repo: ${JSON.stringify(live)}, home: ${JSON.stringify(home)},
      node: "/opt/homebrew/bin/node", template: ${JSON.stringify(template)} }));`], { encoding: "utf8" });
  writeFileSync(plist, r.stdout);
}

/** A second commit on origin: a new bundle, and optionally a Makefile of its own. */
function landB(makefile) {
  populate(seed, "bundle B", makefile);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "B");
  git(seed, "push", "-q", "origin", "main");
  return git(seed, "rev-parse", "HEAD");
}

const makeArgs = (target, vars = []) =>
  ["--no-print-directory", "-C", live, target, "JS_INSTALL=step js", "UV_SYNC=step uv", ...vars];

function make(target, { failAt = "", vars = [] } = {}) {
  const r = spawnSync("make", makeArgs(target, vars), {
    encoding: "utf8",
    timeout: 50_000,
    env: makeEnv(failAt),
  });
  return { status: r.status, all: `${r.stdout}${r.stderr}` };
}

function makeEnv(failAt = "", extra = {}) {
  return {
      PATH: `${stubs}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`,
      HOME: home, TMPDIR: join(dir, "tmp/"), ...GIT_ENV,
      DEPLOY_LOG: log, FAIL_AT: failAt,
      API_HEALTH_URL: `http://127.0.0.1:${apiPort}/health`, API_HEALTH_WAIT: "3",
      FAKE_API: join(dir, "api.py"), FAKE_API_PORT: String(apiPort), FAKE_API_PID: join(dir, "api.pid"),
      ...extra,
  };
}

const steps = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
const bundle = () => readFileSync(join(live, "frontend/dist/index.html"), "utf8");
const worktrees = () => git(live, "worktree", "list").split("\n").length;

describe.skipIf(!darwin)("make deploy", () => {
  beforeEach(() => mkdirSync(join(dir, "tmp"), { recursive: true }));

  it("checks the fetched commit somewhere else, then backs up, moves the tree, restarts and waits for /health", () => {
    const a = git(live, "rev-parse", "HEAD");
    const b = landB();
    const r = make("deploy");
    expect(r.status, r.all).toBe(0);
    expect(git(live, "rev-parse", "HEAD")).toBe(b);
    expect(bundle()).toBe("bundle B");
    expect(a).not.toBe(b);

    const done = steps().map((s) => s.split(" ")[0] + (s.includes(live) ? "@live" : s.startsWith("launchctl") ? "" : "@elsewhere"));
    expect(done).toEqual([
      "js@elsewhere", "links@elsewhere", "uv@elsewhere",   // the fetched commit's checks, in a worktree
      "backup@live", "prune@live",                         // before the tree moves
      "js@live", "links@live", "uv@live",                  // the same installs, now from warm caches
      "launchctl", "launchctl",
    ]);
    expect(steps().filter((s) => s.startsWith("launchctl"))).toEqual([
      expect.stringMatching(/kickstart -k gui\/\d+\/com\.optionality\.ui$/),
      expect.stringMatching(/kickstart -k gui\/\d+\/com\.optionality\.api$/),
    ]);
    expect(Number(readFileSync(join(dir, "api.pid"), "utf8"))).not.toBe(apiPid);
    expect(r.all).toMatch(/both services restarted, and \/health answers 200/);
    expect(worktrees()).toBe(1);
  });

  for (const step of ["js", "links", "uv", "backup"]) {
    it(`leaves HEAD and frontend/dist as they were when ${step} fails`, () => {
      const a = git(live, "rev-parse", "HEAD");
      landB();
      const r = make("deploy", { failAt: step });
      expect(r.status, r.all).not.toBe(0);
      expect(git(live, "rev-parse", "HEAD")).toBe(a);
      expect(bundle()).toBe("bundle A");
      expect(steps().some((s) => s.startsWith("launchctl"))).toBe(false);
      expect(r.all).toMatch(/nothing here changed/);
      expect(worktrees()).toBe(1);
    });
  }

  it("leaves HEAD and frontend/dist as they were when the agent runs a Python the new commit cannot back", () => {
    const a = git(live, "rev-parse", "HEAD");
    landB();
    installPlist("python");
    const r = make("deploy");
    expect(r.status, r.all).not.toBe(0);
    expect(r.all).toMatch(/refusing|cannot back it/);
    expect(git(live, "rev-parse", "HEAD")).toBe(a);
    expect(bundle()).toBe("bundle A");
    expect(steps().some((s) => s.startsWith("backup") || s.startsWith("launchctl"))).toBe(false);
  });

  it("runs the FETCHED commit's checks and restart, not the recipe it was started from", () => {
    const ours = readFileSync(join(ROOT, "Makefile"), "utf8");
    const marked = ours
      .replace(/^deploy-verify:(.*)$/m, "deploy-verify:$1\n\t@echo the fetched deploy-verify")
      .replace(/^deploy-after-pull:(.*)$/m, "deploy-after-pull:$1\n\t@echo the fetched deploy-after-pull");
    expect(marked).not.toBe(ours);
    landB(marked);
    const r = make("deploy");
    expect(r.status, r.all).toBe(0);
    expect(r.all).toMatch(/the fetched deploy-verify/);
    expect(r.all).toMatch(/the fetched deploy-after-pull/);
  });

  for (const signal of ["SIGINT", "SIGHUP", "SIGTERM"]) {
    it(`removes its temporary worktree when ${signal} stops it during the checks`, async () => {
      // ^C, a closed terminal or a kill reaches the whole process group. Measured with make 3.81 and
      // bash 3.2 as /bin/sh: the EXIT trap alone ran for INT and HUP and NOT for TERM.
      const a = git(live, "rev-parse", "HEAD");
      landB();
      const child = spawn("make", makeArgs("deploy"), { env: makeEnv("", { HANG_AT: "js" }), detached: true, stdio: "ignore" });
      const exited = new Promise((resolve) => child.once("exit", resolve));
      for (let i = 0; i < 200 && !existsSync(`${log}.hung`); i++) await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(`${log}.hung`)).toBe(true);
      process.kill(-child.pid, signal);
      await exited;
      await new Promise((r) => setTimeout(r, 300));
      expect(worktrees()).toBe(1);
      expect(spawnSync("ls", [join(dir, "tmp")], { encoding: "utf8" }).stdout.trim()).toBe("");
      expect(git(live, "rev-parse", "HEAD")).toBe(a);
    });
  }

  it("refuses what is not a fast-forward, and changes nothing", () => {
    landB();
    write(join(live, "local.txt"), "a commit only the live tree has");
    git(live, "add", "local.txt");
    git(live, "commit", "-q", "-m", "local");
    const head = git(live, "rev-parse", "HEAD");
    const r = make("deploy");
    expect(r.status, r.all).not.toBe(0);
    expect(r.all).toMatch(/not a fast-forward/);
    expect(git(live, "rev-parse", "HEAD")).toBe(head);
    expect(steps()).toEqual([]);
  });

  it("fails loudly, saying where to look, when the API does not answer 200 after the restart", () => {
    landB();
    const r = make("deploy", { failAt: "health" });
    expect(r.status, r.all).not.toBe(0);
    expect(r.all).toMatch(/no 200 from .*\/health/);
    expect(r.all).toMatch(/optionality-api\.log/);
    expect(r.all).not.toMatch(/both services restarted/);
  });

  it("does not take the old process's 200 for the new one's", () => {
    landB();
    const r = make("deploy", { failAt: "kickstart-noop" });
    expect(r.status, r.all).not.toBe(0);
    expect(r.all).toMatch(/anything but the process it replaced/);
  });
});

describe.skipIf(!darwin)("make deploy-after-pull, as the deploy BEFORE this change runs it", () => {
  // the first deploy of this recipe is run by the old one: `git pull --ff-only` and then this
  // target, with nothing passed — so it must still take the backup itself
  it("takes the backup itself when deploy has not", () => {
    const r = make("deploy-after-pull");
    expect(r.status, r.all).toBe(0);
    expect(steps().map((s) => s.split(" ")[0])).toEqual(["js", "links", "uv", "backup", "prune", "launchctl", "launchctl"]);
  });
});
