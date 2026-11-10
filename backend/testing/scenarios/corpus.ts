/** Where the scenario files live, and reading them back. Shared by the generator, the replay and
 *  the coverage guards, so the three cannot disagree about which files exist. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Door } from "./format.ts";

/** `testdata/scenarios/`, at the repository root beside `testdata/golden/`: shared ground that the
 *  TypeScript writes and a second backend reads (ADR 0021). */
export const SCENARIOS = new URL("../../../testdata/scenarios/", import.meta.url).pathname;

/** `schema/api/`: the HTTP door's description of itself — `openapi.json` and `docs.html`, as the
 *  TypeScript serves them with `ROOT_PATH` blank. Shared ground beside `schema.sql` rather than
 *  test data, because the Python SERVES them: they are what its `/openapi.json` and `/docs` answer,
 *  with its own root path put in (decided 2026-11-10). Written by the same generator, because the
 *  four `/openapi.json` and `/docs` scenarios hold the Python to what the TypeScript answers. */
export const API = new URL("../../../schema/api/", import.meta.url).pathname;

/** The files `API` holds, in the order the generator writes them. */
export const API_FILES = ["openapi.json", "docs.html"] as const;

/** The scenario files of one door, by file name, sorted. */
export function scenarioFiles(door: Door, root = SCENARIOS): string[] {
  const dir = join(root, door);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
}

export function readScenario<T>(door: Door, file: string, root = SCENARIOS): T {
  return JSON.parse(readFileSync(join(root, door, file), "utf8")) as T;
}
