/** Every scenario under `testdata/scenarios/`, replayed against the TypeScript (ADR 0021).
 *
 *  The reference the Python runner mirrors in phase 2, so it is kept to one idea: read a file, run
 *  its event through its door on its world, and expect exactly what the file says. The generator
 *  wrote the file by doing the same thing, which makes this the check that the FILES — not the
 *  inputs they were made from — still describe this service. `make check-scenarios` is the other
 *  half: that the files are the ones the inputs make, byte for byte.
 */
import { describe, expect, it } from "vitest";

import { readScenario, scenarioFiles } from "./corpus.ts";
import { runBot, runHttp, runSweep } from "./doors.ts";
import { DOORS } from "./format.ts";

const RUN = { http: runHttp, bot: runBot, sweep: runSweep } as const;

for (const door of DOORS) {
  describe(`the ${door} door`, () => {
    const files = scenarioFiles(door);

    it("has scenarios to replay", () => {
      // an empty directory replays nothing and passes, which is the one way this suite could lie
      expect(files.length, `testdata/scenarios/${door}/ is empty — run 'make scenarios'`)
        .toBeGreaterThan(0);
    });

    for (const file of files) {
      it(file, async () => {
        const scenario = readScenario<{ expect: unknown }>(door, file);
        expect(await RUN[door](scenario as never)).toEqual(scenario.expect);
      });
    }
  });
}
