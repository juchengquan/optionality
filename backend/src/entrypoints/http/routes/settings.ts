/** `/settings` — the service's own settings, as the page sets them (#442, ADR 0025).
 *
 *  One knob: the sweep's interval. Every other behaviour knob lives in `.env` (CLAUDE.md), and this
 *  one's default still does — MONITOR_INTERVAL_SECONDS — so a PATCH chooses a preset or null, and
 *  null goes back to it. Paired with `sweep-interval.ts`, which does the work. No GET: what is in
 *  force is `/health`'s `settings`, which the page already reads and which needs no token.
 *
 *  Applied at the next sweep with no restart, because the engine ASKS for the interval at every tick
 *  rather than being told — a route may not reach the engine (`check-seams`), and does not need to.
 */
import { Hono } from "hono";
import { z } from "zod";

import { SWEEP_PRESETS } from "optionality/domain/cadence";
import type { Deps } from "../deps.ts";
import { documented } from "../openapi.ts";
import { SettingsPatch } from "../../../schemas/settings.ts";
import { chooseSweepInterval, type SweepInterval } from "../../../sweep-interval.ts";
import { valid } from "../validate.ts";

/** The sweep's interval as the page needs it: what is in force, where it came from, the default a
 *  "back to .env" choice returns to, what may be chosen, and a stored value refused. `/health`
 *  carries the same five. */
export const SweepSettings = z.object({
  /** the interval the engine sweeps at now */
  sweep_seconds: z.number(),
  /** "settings" when the page chose it, "env" when it is `.env`'s MONITOR_INTERVAL_SECONDS */
  sweep_source: z.enum(["settings", "env"]),
  /** `.env`'s interval: what null goes back to */
  sweep_default_seconds: z.number(),
  /** the intervals the page may choose, from one definition (`domain/cadence.ts`) */
  sweep_presets: z.array(z.number()),
  /** a stored value that was refused — not a preset, so a hand edit, or a database that could not
   *  be read — as it was found, or null; `.env`'s interval is in force while it stands (#442) */
  sweep_refused: z.string().nullable(),
});

export const sweepSettings = (at: SweepInterval) => ({
  sweep_seconds: at.seconds,
  sweep_source: at.source,
  sweep_default_seconds: at.defaultSeconds,
  sweep_presets: [...SWEEP_PRESETS],
  sweep_refused: at.refused,
});

const patch = documented(
  "Set the sweep's interval, or null for MONITOR_INTERVAL_SECONDS; in force at the next sweep",
  { 200: SweepSettings },
);

export function settingsRoutes(deps: Deps) {
  return new Hono().patch("/", patch, valid("json", SettingsPatch), (c) => {
    const { sweep_seconds } = c.req.valid("json");
    const at = chooseSweepInterval(deps.db, deps.settings, sweep_seconds, deps.now());
    return patch.reply(c, 200, sweepSettings(at));
  });
}
