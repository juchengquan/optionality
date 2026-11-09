/** `make use`, held without launchd: nothing here runs `launchctl`, writes to ~/Library/LaunchAgents,
 *  backs up a database or reaches port 31415. Switching is driven through a scripted stand-in for
 *  the system, and the CLI only through the subcommands that touch nothing (`check`, `render` into a
 *  temporary file, `installed` with HOME pointed at one). The guard is checked twice over: against
 *  this repository as it stands, where it must refuse, and against fixture trees, where a backlog
 *  that empties and a `__main__` that appears are what let it through.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LABEL, PORT, backendOf, drySystem, readBacklog, refusals, renderPlist, switchTo, systemFor,
} from "./use-backend.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SCRIPT = join(ROOT, "tools", "use-backend.mjs");
const TEMPLATE = "deploy/macos/optionality-api.launchd.plist.template";
const NODE = "/opt/homebrew/bin/node";
const DOORS = ["http", "bot", "sweep"];
const darwin = process.platform === "darwin";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "use-backend-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(root, path, text = "") {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  return full;
}

/** A repository with just what the guard and the renderer read. By default the port is DONE: the
 *  backlog empty, `__main__` there, the interpreter installed. */
function fixture({ backlog = [], main = true, interpreter = true, corpus = true, backlogText } = {}) {
  const repo = join(dir, "repo");
  write(repo, TEMPLATE, readFileSync(join(ROOT, TEMPLATE), "utf8"));
  if (corpus) for (const door of DOORS) for (const n of [1, 2]) write(repo, `testdata/scenarios/${door}/s${n}.json`, "{}");
  if (backlog !== null) {
    const entries = backlog.map((name) => `    "${name}",\n`).join("");
    write(repo, "python-backend/tests/scenarios/backlog.py",
      backlogText ?? `"""The backlog."""\n\n#: may only shrink\nBACKLOG = [\n${entries}]\n\n\ndef findings():\n    return ["x"]\n`);
  }
  if (main) write(repo, "python-backend/src/optionality_backend/__main__.py", '"""The process."""\n');
  if (interpreter) chmodSync(write(repo, ".venv/bin/python", "#!/bin/sh\n"), 0o755);
  return repo;
}

/** The plist as launchd will read it: plutil's own parse, into JSON. */
function parsed(text) {
  const path = write(dir, `parsed-${Math.random()}.plist`, text);
  return JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" }));
}

const render = (backend, repo = "/Users/owner/optionality") =>
  renderPlist(backend, { repo, home: "/Users/owner", node: NODE, template: readFileSync(join(ROOT, TEMPLATE), "utf8") });

const SHARED_ENV = {
  PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  PORT: "31415",
  OPTIONALITY_DB_PATH: "data/optionality-ts.db",
  OPTIONALITY_BOT: "1",
};

describe.skipIf(!darwin)("the plist, for each backend", () => {
  it("renders a plist launchd accepts, for either backend", () => {
    for (const backend of ["ts", "python"]) {
      const path = write(dir, `${backend}.plist`, render(backend));
      const lint = spawnSync("plutil", ["-lint", path], { encoding: "utf8" });
      expect(lint.status, `${backend}: ${lint.stdout}${lint.stderr}`).toBe(0);
    }
  });

  it("runs the TypeScript as it always has: node, .env, main.ts, from the working tree", () => {
    const plist = parsed(render("ts"));
    expect(plist.ProgramArguments).toEqual([NODE, "--env-file=.env", "backend/src/main.ts"]);
    expect(plist.EnvironmentVariables).toEqual(SHARED_ENV);
    expect(plist.WorkingDirectory).toBe("/Users/owner/optionality");
    expect(plist.Label).toBe(LABEL);
    expect(plist).toMatchObject({
      RunAtLoad: true, KeepAlive: true,
      StandardOutPath: "/Users/owner/Library/Logs/optionality-api.log",
      StandardErrorPath: "/Users/owner/Library/Logs/optionality-api.log",
    });
  });

  it("runs the Python from the repository's uv environment, on the same .env", () => {
    const plist = parsed(render("python"));
    expect(plist.ProgramArguments).toEqual([
      "/Users/owner/optionality/.venv/bin/python", "-m", "optionality_backend", "--env-file=.env",
    ]);
    // the port, the one database and the bot flag are the TypeScript's: one of each, whichever runs
    expect(plist.EnvironmentVariables).toEqual({ ...SHARED_ENV, PYTHONUNBUFFERED: "1" });
  });

  it("differs between the backends in what runs and nothing else", () => {
    const ts = parsed(render("ts"));
    const python = parsed(render("python"));
    const { ProgramArguments: _a, EnvironmentVariables: tsEnv, ...tsRest } = ts;
    const { ProgramArguments: _b, EnvironmentVariables: { PYTHONUNBUFFERED, ...pyEnv }, ...pyRest } = python;
    expect(pyRest).toEqual(tsRest);
    expect(pyEnv).toEqual(tsEnv);
    expect(PYTHONUNBUFFERED).toBe("1");
  });

  it("escapes a path the XML would otherwise misread", () => {
    const plist = parsed(render("python", "/Users/owner/R&D <live>"));
    expect(plist.WorkingDirectory).toBe("/Users/owner/R&D <live>");
    expect(plist.ProgramArguments[0]).toBe("/Users/owner/R&D <live>/.venv/bin/python");
  });

  it("refuses to leave a placeholder unfilled", () => {
    const template = readFileSync(join(ROOT, TEMPLATE), "utf8").replace("</dict>\n</plist>", "<string>__NEW__</string>\n</dict>\n</plist>");
    expect(() => renderPlist("ts", { repo: "/r", home: "/h", node: NODE, template })).toThrow(/__NEW__/);
  });

  it("tells which backend a plist runs, from what launchd would run", () => {
    expect(backendOf(parsed(render("ts")).ProgramArguments)).toBe("ts");
    expect(backendOf(parsed(render("python")).ProgramArguments)).toBe("python");
    expect(backendOf(["/bin/sh", "-c", "true"])).toBe(null);
    expect(backendOf(undefined)).toBe(null);
  });
});

describe("the guard: the live service never switches to a half-ported Python", () => {
  it("refuses the Python today, counting the port and naming every door still missing", () => {
    // Measured, not remembered: the counts below come from the corpus and from Python's own reading
    // of the backlog, so the test holds while the parallel ports shrink it. When the port is done
    // the backlog empties, `__main__.py` appears, and this test is replaced by the one it guards.
    const lines = refusals("python", ROOT);
    const total = DOORS.flatMap((d) => readdirSync(join(ROOT, "testdata/scenarios", d)).filter((f) => f.endsWith(".json"))).length;
    const backlog = pythonsBacklog();
    expect(backlog.length).toBeGreaterThan(0);
    expect(lines[0]).toBe(`${total - backlog.length} of ${total} door scenarios ported`);
    for (const door of DOORS) {
      const waiting = backlog.filter((n) => n.startsWith(`${door}/`)).length;
      if (waiting > 0) expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^  ${door} +${waiting} of \\d+ still on the backlog$`)));
    }
    expect(lines).toContainEqual(expect.stringMatching(/__main__\.py does not exist/));
  });

  it("reads the backlog exactly as Python does", () => {
    // the list is Python; this reads its text. `test_scenario_runner.py` holds it to a list written
    // out, and this holds the reading to the interpreter's
    const text = readFileSync(join(ROOT, "python-backend/tests/scenarios/backlog.py"), "utf8");
    expect(readBacklog(text)).toEqual(pythonsBacklog());
  });

  it("lets the Python through once the backlog is empty and __main__ exists", () => {
    expect(refusals("python", fixture())).toEqual([]);
  });

  it("refuses while one scenario is still on the backlog, naming its door", () => {
    const lines = refusals("python", fixture({ backlog: ["sweep/s1.json"] }));
    expect(lines).toEqual([
      "5 of 6 door scenarios ported",
      "  sweep  1 of 2 still on the backlog",
    ]);
  });

  it("refuses without __main__, even with the backlog empty", () => {
    expect(refusals("python", fixture({ main: false })))
      .toEqual([expect.stringMatching(/optionality_backend\/__main__\.py does not exist: main\.ts is not ported/)]);
  });

  it("refuses without the interpreter launchd would run", () => {
    expect(refusals("python", fixture({ interpreter: false })))
      .toEqual([expect.stringMatching(/no interpreter at \.venv\/bin\/python.*uv sync --all-packages/)]);
  });

  it("does not count an entry that is commented out, or the list's own comments", () => {
    const backlogText = 'BACKLOG = [\n    # "http/s1.json",\n    "bot/s2.json",  # the reason\n    \'sweep/s1.json\',\n]\n';
    expect(readBacklog(backlogText)).toEqual(["bot/s2.json", "sweep/s1.json"]);
    expect(refusals("python", fixture({ backlogText }))[0]).toBe("4 of 6 door scenarios ported");
  });

  it("refuses a backlog it cannot read, rather than taking it as empty", () => {
    for (const backlogText of ["BACKLOG = sorted(SCENARIOS)\n", '"""no list at all"""\n']) {
      expect(refusals("python", fixture({ backlogText })))
        .toEqual([expect.stringMatching(/cannot read BACKLOG/)]);
    }
  });

  it("refuses when it finds no scenarios at all, rather than passing on nothing", () => {
    expect(refusals("python", fixture({ corpus: false })))
      .toEqual([expect.stringMatching(/no door scenarios under testdata\/scenarios/)]);
  });

  it("takes a deleted backlog as a finished port, which is when the backlog says to delete it", () => {
    expect(refusals("python", fixture({ backlog: null }))).toEqual([]);
  });

  it("never stands between the owner and the TypeScript", () => {
    expect(refusals("ts", ROOT)).toEqual([]);
    expect(refusals("ts", fixture({ backlog: ["http/s1.json"], main: false, interpreter: false }))).toEqual([]);
  });
});

/** The system `switchTo` drives, scripted: every call is recorded, and each answer is whatever the
 *  test says — launchctl's exit codes, whether the port is held, what /health answers. */
function scripted({ print = () => 113, bootstrap = 0, held = () => false, health = () => 200 } = {}) {
  const calls = [];
  let prints = 0, polls = 0, checks = 0;
  return {
    calls,
    dry: false,
    launchctl(args) {
      calls.push(`launchctl ${args.join(" ")}`);
      if (args[0] === "print") return { status: print(prints++), output: "" };
      if (args[0] === "bootstrap") return { status: bootstrap, output: bootstrap ? "Bootstrap failed: 5: Input/output error" : "" };
      return { status: 0, output: "" };
    },
    write(path, text) { calls.push(`write ${path}`); this.written = text; },
    async portHeld(port) { calls.push(`port ${port}`); return held(checks++); },
    async health(url) { calls.push(`health ${url}`); return health(polls++); },
    async sleep() {},
  };
}

describe.skipIf(!darwin)("switching", () => {
  // a launchd domain nobody has, and a HOME of its own: were a real system ever to get this far, it
  // would ask launchd about nobody's agent and write nowhere the owner's agents live
  const UID = 99999;
  const options = (sys, repo = fixture()) => ({
    repo, home: join(dir, "home"), uid: UID, node: NODE, sys, say: () => {},
  });
  const plistPath = () => join(dir, "home", "Library", "LaunchAgents", `${LABEL}.plist`);

  it("stops the running backend, installs the plist, starts the chosen one and waits for /health, in that order", async () => {
    const sys = scripted({ health: (n) => (n < 2 ? null : 200) });
    await switchTo("python", options(sys));
    expect(sys.calls).toEqual([
      `launchctl bootout gui/${UID}/${LABEL}`,
      `launchctl print gui/${UID}/${LABEL}`,
      `port ${PORT}`,
      `write ${plistPath()}`,
      `launchctl bootstrap gui/${UID} ${plistPath()}`,
      `health http://127.0.0.1:${PORT}/health`,
      `health http://127.0.0.1:${PORT}/health`,
      `health http://127.0.0.1:${PORT}/health`,
    ]);
    expect(backendOf(parsed(sys.written).ProgramArguments)).toBe("python");
  });

  it("refuses the Python before it touches launchd", async () => {
    const sys = scripted();
    await expect(switchTo("python", options(sys, ROOT))).rejects.toThrow(/door scenarios ported/);
    expect(sys.calls).toEqual([]);
  });

  it("waits for the old backend to be gone before it starts the new one", async () => {
    const sys = scripted({ print: (n) => (n < 2 ? 0 : 113) });
    await switchTo("ts", options(sys));
    expect(sys.calls.filter((c) => c.startsWith("launchctl print"))).toHaveLength(3);
    expect(sys.calls.indexOf(`write ${plistPath()}`)).toBeGreaterThan(sys.calls.lastIndexOf(`launchctl print gui/${UID}/${LABEL}`));
  });

  it("stops, saying so, when the old one will not unload", async () => {
    const sys = scripted({ print: () => 0 });
    await expect(switchTo("ts", options(sys))).rejects.toThrow(/still loaded/);
    expect(sys.calls.some((c) => c.startsWith("write") || c.includes("bootstrap"))).toBe(false);
  });

  it("does not start the new backend while something else holds the port", async () => {
    // the new one would be refused by the lock, and /health would answer 200 from whatever holds it
    const sys = scripted({ held: () => true });
    await expect(switchTo("ts", options(sys))).rejects.toThrow(new RegExp(`port ${PORT} is still held.*lsof`));
    expect(sys.calls.some((c) => c.startsWith("write") || c.includes("bootstrap"))).toBe(false);
  });

  it("says so when launchd refuses the plist", async () => {
    const sys = scripted({ bootstrap: 5 });
    await expect(switchTo("ts", options(sys))).rejects.toThrow(/Bootstrap failed/);
    expect(sys.calls.some((c) => c.startsWith("health"))).toBe(false);
  });

  it("says so when /health never answers 200, and where to look", async () => {
    const sys = scripted({ health: () => 503 });
    await expect(switchTo("ts", options(sys))).rejects.toThrow(/no 200 from \/health.*optionality-api\.log/s);
  });

  it("prints what it would do and does nothing, under DRY_RUN=1", async () => {
    const said = [];
    const sys = systemFor({ DRY_RUN: "1" }, (line) => said.push(line));
    expect(sys.dry).toBe(true);
    expect(systemFor({}).dry).toBe(false);
    await switchTo("python", { ...options(sys), say: (line) => said.push(line) });
    expect(existsSync(plistPath())).toBe(false);
    expect(said).toEqual(expect.arrayContaining([
      `would run: launchctl bootout gui/${UID}/${LABEL}`,
      `would run: launchctl bootstrap gui/${UID} ${plistPath()}`,
    ]));
    expect(said.join("\n")).toMatch(/would write .*com\.optionality\.api\.plist/);
    expect(said.at(-1)).toBe("dry run: nothing was done");
  });

  it("answers everything the real system is asked, so a dry run cannot reach the real one", () => {
    expect(Object.keys(drySystem(() => {})).sort()).toEqual(Object.keys(systemFor({})).sort());
  });
});

describe.skipIf(!darwin)("the command line, through the subcommands that touch nothing", () => {
  const cli = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8", env: { ...process.env, DRY_RUN: "", ...env },
  });

  it("refuses the Python today and passes the TypeScript", () => {
    const python = cli(["check", "python"]);
    expect(python.status).toBe(1);
    expect(python.stderr).toMatch(/refusing to switch to the Python backend[\s\S]*door scenarios ported/);
    expect(python.stderr).toMatch(/make use BACKEND=ts/);
    expect(cli(["check", "ts"]).status).toBe(0);
  });

  it("renders only what the guard allows, and writes nothing when it refuses", () => {
    const ts = join(dir, "ts.plist");
    expect(cli(["render", "ts", ts]).status).toBe(0);
    expect(backendOf(parsed(readFileSync(ts, "utf8")).ProgramArguments)).toBe("ts");
    const python = join(dir, "python.plist");
    expect(cli(["render", "python", python]).status).toBe(1);
    expect(existsSync(python)).toBe(false);
  });

  it("names the backend the installed plist runs, and fails when there is none", () => {
    const home = join(dir, "home");
    expect(cli(["installed"], { HOME: home }).status).toBe(1);
    write(home, `Library/LaunchAgents/${LABEL}.plist`, render("ts"));
    const found = cli(["installed"], { HOME: home });
    expect(found.status).toBe(0);
    expect(found.stdout.trim()).toBe("ts");
  });

  it("refuses to run a Python plist this tree cannot back, when deploy asks", () => {
    const home = join(dir, "home");
    write(home, `Library/LaunchAgents/${LABEL}.plist`, render("python", ROOT));
    const found = cli(["installed"], { HOME: home });
    expect(found.status).toBe(1);
    expect(found.stderr).toMatch(/runs the Python backend[\s\S]*door scenarios ported/);
  });

  it("answers an unknown backend with its usage", () => {
    const wrong = cli(["check", "rust"]);
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toMatch(/usage: make use BACKEND=ts\|python/);
  });
});

/** The backlog as the Python suite itself reads it: imported, by the repository's own interpreter. */
function pythonsBacklog() {
  const out = execFileSync(join(ROOT, ".venv/bin/python"), [
    "-c", "import json, sys; sys.path.insert(0, 'python-backend/tests'); "
      + "from scenarios.backlog import BACKLOG; print(json.dumps(BACKLOG))",
  ], { cwd: ROOT, encoding: "utf8" });
  return JSON.parse(out);
}
