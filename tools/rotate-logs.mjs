/** Rotate the launchd agents' logs: `optionality-*.log` in ~/Library/Logs.
 *
 *    node tools/rotate-logs.mjs <dir> [--max-mb 10] [--keep 3]       (make rotate-logs)
 *
 *  Nothing rotated them: on 2026-11-16 Caddy's (`optionality-ui.log`) was 54 MB and the API's 6 MB.
 *  newsyslog would need sudo, so this runs as the owner, after the nightly backup (the backup
 *  agent's plist runs it), and by hand with `make rotate-logs`.
 *
 *  COPY AND TRUNCATE, never rename. launchd opens each agent's StandardOutPath once, with O_APPEND,
 *  and the agent writes through that descriptor for as long as it runs: a renamed log would go on
 *  growing under its new name and the fresh one would stay empty. Truncating the same inode keeps
 *  the descriptor valid, and O_APPEND puts the next line at byte 0 rather than at the old offset.
 *  The cost is whatever an agent writes between the copy and the truncate, which at 06:00 is a line
 *  or two at most.
 *
 *  A log over the limit is gzipped to `<log>.1.gz`, the older copies shifted along, and anything
 *  past `keep` deleted. A log under the limit, and any file not named `optionality-*.log`, is left
 *  alone.
 */
import { createReadStream, createWriteStream, existsSync, readdirSync, renameSync, rmSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const OURS = /^optionality-[a-z0-9-]+\.log$/;
const MB = 1024 * 1024;

export async function rotateLogs(dir, { maxBytes = 10 * MB, keep = 3, say = console.log } = {}) {
  for (const name of readdirSync(dir).filter((f) => OURS.test(f)).sort()) {
    const log = join(dir, name);
    const { size } = statSync(log);
    if (size <= maxBytes) continue;
    const copy = (n) => join(dir, `${name}.${n}.gz`);
    rmSync(copy(keep), { force: true });
    for (let n = keep - 1; n >= 1; n--) if (existsSync(copy(n))) renameSync(copy(n), copy(n + 1));
    await pipeline(createReadStream(log, { end: size - 1 }), createGzip(), createWriteStream(copy(1)));
    truncateSync(log, 0);
    say(`${name}: ${(size / MB).toFixed(1)} MB, kept as ${name}.1.gz and emptied`);
  }
}

function option(args, flag, fallback) {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  const n = Number(args[i + 1]);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} wants a positive number`);
  return n;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dir = args[0];
  if (!dir || dir.startsWith("--")) {
    console.error("usage: node tools/rotate-logs.mjs <dir> [--max-mb 10] [--keep 3]");
    process.exit(2);
  }
  rotateLogs(dir, { maxBytes: option(args, "--max-mb", 10) * MB, keep: option(args, "--keep", 3) })
    .catch((err) => { console.error(err.message ?? err); process.exit(1); });
}
