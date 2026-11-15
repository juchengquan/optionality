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
 *  It reads the workspace list from the root package.json, each package's NAME from its own
 *  package.json (the name, not the directory, is where `node_modules` puts it), and requires
 *  `node_modules/<name>` to be a symlink whose real path is that directory.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

/** What is wrong with the installed workspace links under `repo`, one sentence each. */
export function linkFaults(repo = ROOT) {
  const root = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  if (!Array.isArray(root.workspaces) || root.workspaces.length === 0) {
    return ["package.json declares no workspaces, so there is nothing this could check"];
  }
  const faults = [];
  for (const dir of root.workspaces) {
    const { name } = JSON.parse(readFileSync(join(repo, dir, "package.json"), "utf8"));
    const installed = join("node_modules", name);
    const at = join(repo, installed);
    let stat;
    try { stat = lstatSync(at); } catch {
      faults.push(`${installed} is missing: the workspace ${dir}/ was not installed`);
      continue;
    }
    if (!stat.isSymbolicLink()) {
      faults.push(`${installed} is not a link to ${dir}/ — a copy installed from somewhere else, `
        + "such as the public registry's package of the same name");
      continue;
    }
    const lands = existsSync(at) ? realpathSync(at) : null;
    if (lands !== realpathSync(join(repo, dir))) {
      faults.push(`${installed} links to ${lands ? relative(repo, lands) || "." : "nothing"}, not ${dir}/`);
    }
  }
  return faults;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const faults = linkFaults();
  if (faults.length > 0) {
    console.error("check-workspace-links: a workspace package is not the workspace's own code:");
    for (const fault of faults) console.error(`  ${fault}`);
    console.error("  reinstall with `bun install --frozen-lockfile`, which links each workspace.");
    process.exit(1);
  }
  console.log("every workspace package is linked to its own directory");
}
