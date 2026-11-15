/** Every workspace package is installed as a LINK to its own directory, never as a copy from the
 *  public registry.
 *
 *  The library's directory is `typescript/` and its package is `optionality` (ADR 0021), and the
 *  public npm registry has an unrelated package of that very name (1.2.1 when measured on
 *  2026-11-09); it has `backend` and `frontend` too. A package manager resolves a workspace's name
 *  from the workspace only by its own rules: npm and bun do by default, and pnpm, measured for
 *  #412, needed two settings not to install the public packages. Whatever installs this tree, the
 *  backend imports its domain as `optionality/domain/...`, so a stranger's code in that place
 *  would be what the service runs. Nothing checked it — it held because the installer behaved.
 *
 *  It reads the workspace list from the root package.json and each package's NAME from its own
 *  package.json (the name, not the directory, is where `node_modules` puts it). Then, two ways:
 *
 *  - INSTALLED: from the root and from inside every workspace, it finds each workspace name the
 *    way Node does — the nearest `node_modules/<name>` walking up — and requires a symlink whose
 *    real path is that workspace. Every importer, not just the root: a workspace that depended on
 *    the public `optionality@^1.2.1` would get a copy in its own `node_modules`, and Node finds
 *    that one first from every file of that workspace while the root link stays correct.
 *  - LOCKED: no entry of bun.lock, at any depth, may resolve a workspace's name to anything but
 *    `<name>@workspace:` — which catches it in the lock a change commits, before any install.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Where Node would find `name` importing from `from`: the nearest node_modules/<name>, walking up
 *  no further than the repository. */
function nearest(repo, from, name) {
  for (let dir = from; ; dir = dirname(dir)) {
    const at = join(dir, "node_modules", name);
    try { lstatSync(at); return at; } catch { /* not here */ }
    if (dir === repo || dirname(dir) === dir) return null;
  }
}

/** bun.lock is JSON with trailing commas; its `packages` maps an install path to [`name@version`, …]. */
function lockFaults(repo, names) {
  const path = join(repo, "bun.lock");
  if (!existsSync(path)) return [];
  const lock = JSON.parse(readFileSync(path, "utf8").replace(/,(\s*[}\]])/g, "$1"));
  const faults = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const id = Array.isArray(entry) ? String(entry[0]) : "";
    const name = id.slice(0, id.indexOf("@", 1));
    if (names.has(name) && !id.startsWith(`${name}@workspace:`)) {
      faults.push(`bun.lock resolves "${key}" to ${id}, not to the workspace of that name`);
    }
  }
  return faults;
}

/** What is wrong with the installed and locked workspace links under `repo`, one sentence each. */
export function linkFaults(repo = ROOT) {
  const root = readJson(join(repo, "package.json"));
  if (!Array.isArray(root.workspaces) || root.workspaces.length === 0) {
    return ["package.json declares no workspaces, so there is nothing this could check"];
  }
  const workspaces = root.workspaces.map((dir) => ({ dir, name: readJson(join(repo, dir, "package.json")).name }));
  const faults = new Set();
  for (const importer of [".", ...root.workspaces]) {
    for (const { dir, name } of workspaces) {
      const at = nearest(repo, join(repo, importer), name);
      if (!at) {
        faults.add(`node_modules/${name} is missing: the workspace ${dir}/ was not installed`);
        continue;
      }
      const installed = relative(repo, at);
      if (!lstatSync(at).isSymbolicLink()) {
        faults.add(`${installed} is not a link to ${dir}/ — a copy installed from somewhere else, `
          + "such as the public registry's package of the same name");
        continue;
      }
      const lands = existsSync(at) ? realpathSync(at) : null;
      if (lands !== realpathSync(join(repo, dir))) {
        faults.add(`${installed} links to ${lands ? relative(repo, lands) || "." : "nothing"}, not ${dir}/`);
      }
    }
  }
  for (const fault of lockFaults(repo, new Set(workspaces.map((w) => w.name)))) faults.add(fault);
  return [...faults];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const faults = linkFaults();
  if (faults.length > 0) {
    console.error("check-workspace-links: a workspace package is not the workspace's own code:");
    for (const fault of faults) console.error(`  ${fault}`);
    console.error("  find what asks for the public package of that name and stop it; then reinstall with");
    console.error("  `bun install --frozen-lockfile`, which links each workspace.");
    process.exit(1);
  }
  console.log("every workspace package is linked to its own directory");
}
