/** What the API accepts for the service's own settings (#442, ADR 0025): the sweep's interval, and
 *  nothing else — it is the ONE behaviour knob kept in the database.
 *
 *  A preset or null, and the key REQUIRED: null is a choice ("back to .env's interval"), so a body
 *  that forgot the key must not read as one. Anything else is zod's 422, which the page shows.
 */
import { z } from "zod";

import { SWEEP_PRESETS } from "optionality/domain/cadence";

export const SettingsPatch = z.object({
  /** 5, 10, 15, 30 or 60 seconds, or null for `.env`'s MONITOR_INTERVAL_SECONDS */
  sweep_seconds: z.literal(SWEEP_PRESETS).nullable(),
});
