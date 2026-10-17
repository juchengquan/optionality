/** Prune `make deploy`'s backups in data/ to the last 3, keeping every one that was given a name.
 *
 *    node prune-deploy.ts <data dir>
 *
 *  Run by `make deploy` right after it takes the next one. To keep a backup for good — the one taken
 *  before something destructive — rename it so it carries a name as well as a timestamp:
 *  `optionality-ts.db.bak-pre-<what>-YYYYMMDD-HHMMSS`. See retention.ts.
 */
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { retainDeploy } from "./retention.ts";

const [dir] = process.argv.slice(2);
if (!dir) {
  console.error("usage: node prune-deploy.ts <data dir>");
  process.exit(2);
}
const { drop } = retainDeploy(readdirSync(dir));
for (const f of drop) rmSync(join(dir, f));
if (drop.length > 0) console.log(`pruned ${drop.length} deploy backup file(s)`);
