/** Where the scenario files live, and reading them back. Shared by the generator, the replay and
 *  the coverage guards, so the three cannot disagree about which files exist. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Door } from "./format.ts";

/** `testdata/scenarios/`, at the repository root beside `testdata/golden/`: shared ground that the
 *  TypeScript writes and a second backend reads (ADR 0021). */
export const SCENARIOS = new URL("../../../testdata/scenarios/", import.meta.url).pathname;

/** The scenario files of one door, by file name, sorted. */
export function scenarioFiles(door: Door, root = SCENARIOS): string[] {
  const dir = join(root, door);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
}

export function readScenario<T>(door: Door, file: string, root = SCENARIOS): T {
  return JSON.parse(readFileSync(join(root, door, file), "utf8")) as T;
}
