/** The page's DISPLAY_TZ is module state (`shared/times.ts`), set by the page from `/health` as it
 *  draws, so every pure reader of a served stamp names one zone. A test that rendered the page with a
 *  health saying "Asia/Singapore" would otherwise leave it set for the next test in the file, and a
 *  time's zone would depend on the order tests ran in. Cleared after every test, in both suites. */
import { afterEach } from "vitest";

import { setDisplayZone } from "../shared/times";

afterEach(() => { setDisplayZone(null); });
