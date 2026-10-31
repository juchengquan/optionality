/** No Makefile recipe deletes the directory the live dashboard is served from.
 *
 *  `frontend/dist` is not only a committed build artefact: it is the UI agent's document root.
 *  deploy/optionality-ui.launchd.plist.template sets OPTIONALITY_UI_ROOT to <repo>/frontend/dist
 *  and deploy/Caddyfile's `root * {$OPTIONALITY_UI_ROOT}` reads it from disk per request, so a
 *  target that removes it takes the dashboard down for as long as the rm is in effect — and
 *  leaves it down if what was meant to rebuild it fails.
 *
 *  `check-ui` did exactly that, and CLAUDE.md says to run `make check` before every commit, so the
 *  dashboard went dark several times a day for a week before anyone measured it. The rm was there
 *  for a real bug (Tailwind scanning dist, its own previous output) whose cause has since moved
 *  into app.css as `source(".")` — so the deletion bought nothing by the time it was found. That
 *  is the shape this guards against: a workaround outliving the thing it worked around, in the one
 *  place where the cost is the live service.
 *
 *  What this does NOT cover, and nothing here can: `vite build` empties its own outDir, so
 *  `make build-ui` still has a window of about a second where the served tree is incomplete. That
 *  is a target you run deliberately when you intend to replace the bundle, and the window is the
 *  build itself rather than the whole of a check suite.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const makefile = readFileSync(resolve(ROOT, "Makefile"), "utf8");

/** The served root, read from the plist template rather than written down twice: if the agent is
 *  ever pointed somewhere else, this follows it instead of guarding a path nothing serves. */
const plist = readFileSync(resolve(ROOT, "deploy/optionality-ui.launchd.plist.template"), "utf8");
const root = plist.match(/<key>OPTIONALITY_UI_ROOT<\/key>\s*<string>__REPO__\/([^<]+)<\/string>/)?.[1];
if (!root) {
  console.error("check-served-root: could not read OPTIONALITY_UI_ROOT from the plist template");
  process.exit(1);
}
// and it is a root that is actually served. Without this the check passes by reading the wrong
// path: a mutation pointing it at frontend/nowhere reported "no make target deletes
// frontend/nowhere" and exited 0, which is the shape of a guard that has quietly stopped guarding.
if (!existsSync(resolve(ROOT, root, "index.html"))) {
  console.error(`check-served-root: ${root} holds no index.html, so it is not what is served`);
  process.exit(1);
}

// a recipe line is one that begins with a tab; `rm` anywhere in it, naming the root, is the fault
const offenders = makefile.split("\n")
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(({ line }) => line.startsWith("\t") && /\brm\b/.test(line) && line.includes(root));

if (offenders.length > 0) {
  console.error(`check-served-root: ${root} is what Caddy serves; these recipes remove it:`);
  for (const { line, n } of offenders) console.error(`  Makefile:${n}: ${line.trim()}`);
  console.error("  build somewhere else and compare (see check-ui), or the dashboard goes down.");
  process.exit(1);
}
console.log(`no make target deletes ${root}`);
