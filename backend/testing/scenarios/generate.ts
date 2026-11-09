/** `make scenarios` writes `testdata/scenarios/{http,bot,sweep}/*.json` from the inputs beside this
 *  file; `make check-scenarios` (`--check`) only compares, and fails on any file that is missing,
 *  stale, or left over from an input that is gone (ADR 0021, Decision 4).
 *
 *  Each file is its input's world and event, run through the TypeScript, with what happened
 *  written beside them. Never edited by hand: a scenario that should say something else is an
 *  input that should say something else, or a service that should.
 *
 *  Under `testing/` rather than `backend/tools/` for a reason `check-test-support` enforces: it
 *  runs the service on fake vendors, and nothing outside test support may import those. Run under
 *  `TZ=UTC`, as the golden cases are generated, because the expectations are read under it.
 *
 *  It writes only when run as a program. `check-loads.ts` imports every module under `testing/`
 *  to prove Node can load it, and a generator that ran on import would rewrite the corpus as a
 *  side effect of `make check-api`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { SCENARIOS, scenarioFiles } from "./corpus.ts";
import { runBot, runHttp, runSweep } from "./doors.ts";
import {
  DOORS, type Door, type Provider, type Vendor, type World, render, slug,
} from "./format.ts";
import { BOT } from "./inputs/bot.ts";
import { HTTP } from "./inputs/http.ts";
import { SWEEP } from "./inputs/sweep.ts";
import { dumpTables, openWorld } from "./world.ts";

const sortedKeys = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]!]));

/** A vendor's table in the order its rules apply: an outage first, then a refusal, then the
 *  unknown codes, then the figures — quotes last because they are the longest. */
const vendorTable = (v: Vendor) => ({
  down: v.down, rejects: sortedKeys(v.rejects), unknown: [...v.unknown].sort(),
  quotes: sortedKeys(v.quotes),
});

/** The world as a file states it: every key in a fixed order, and the tables as the database
 *  holds them — which is what makes a hand-written input and its file two spellings of one world. */
function written(world: World): World {
  const w = openWorld(world);
  let tables;
  try {
    tables = dumpTables(w.db);
  } finally {
    w.close();
  }
  const p: Provider = world.provider;
  return {
    clock: world.clock,
    settings: sortedKeys(world.settings),
    provider: { name: p.name, reachable: p.reachable, ...vendorTable(p) },
    sources: Object.fromEntries(
      Object.keys(world.sources).sort().map((name) => [name, vendorTable(world.sources[name]!)]),
    ),
    telegram: world.telegram,
    sweeps: world.sweeps.map((s) => ({ at: s.at, down: s.down })),
    tables,
  };
}

/** Every scenario file, by door and file name, as the TypeScript says it should read. */
export async function build(): Promise<Record<Door, Record<string, string>>> {
  const out: Record<Door, Record<string, string>> = { http: {}, bot: {}, sweep: {} };
  const put = (door: Door, name: string, scenario: unknown) => {
    const file = `${slug(name)}.json`;
    if (file in out[door]) throw new Error(`two ${door} scenarios are called "${name}"`);
    out[door][file] = render(scenario);
  };
  // Each event is run on the scenario AS IT WILL BE WRITTEN — through JSON and back — and not on
  // the input. Otherwise an input holding something JSON cannot carry (an `undefined`, a Date)
  // would be run as one world and written as another, and the file would fail its own replay.
  const asWritten = <T>(scenario: T): T => JSON.parse(JSON.stringify(scenario)) as T;
  for (const input of HTTP) {
    const s = asWritten({ name: input.name, world: written(input.world), request: input.request });
    put("http", input.name, { ...s, expect: await runHttp(s) });
  }
  for (const input of BOT) {
    const s = asWritten({ name: input.name, world: written(input.world), update: input.update });
    put("bot", input.name, { ...s, expect: await runBot(s) });
  }
  for (const input of SWEEP) {
    const s = asWritten({
      name: input.name, outcomes: input.outcomes, world: written(input.world),
    });
    put("sweep", input.name, { ...s, expect: await runSweep(s) });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  // `--root` writes somewhere else, so the generator can be tried without touching the corpus
  const rootArg = process.argv.indexOf("--root");
  const root = rootArg === -1 ? SCENARIOS : resolve(process.argv[rootArg + 1] ?? ".");
  const stale: string[] = [];
  let count = 0;
  for (const [door, files] of Object.entries(await build()) as [Door, Record<string, string>][]) {
    const dir = join(root, door);
    if (!check) mkdirSync(dir, { recursive: true });
    for (const [file, text] of Object.entries(files)) {
      count += 1;
      const path = join(dir, file);
      if (existsSync(path) && readFileSync(path, "utf8") === text) continue;
      if (check) stale.push(`${door}/${file}`);
      else writeFileSync(path, text);
    }
    // a file no input makes any more is a scenario nobody can regenerate: gone, or stale
    for (const file of scenarioFiles(door, root).filter((f) => !(f in files))) {
      if (check) stale.push(`${door}/${file} (no input makes it)`);
      else rmSync(join(dir, file));
    }
  }
  if (DOORS.some((door) => scenarioFiles(door, root).length === 0) && check) {
    stale.push("a door with no scenarios at all");
  }
  if (stale.length > 0) {
    console.error(`stale door scenarios: ${stale.join(", ")} — `
      + "run 'make scenarios' and commit the result");
    process.exit(1);
  }
  console.log(check
    ? `door scenarios match the TypeScript (${count})`
    : `wrote ${count} door scenarios to ${root}`);
}
