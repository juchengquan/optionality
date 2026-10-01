/** Cron expressions, validated the way the Python's APScheduler does (ADR 0009, phase 5).
 *
 *  croner rather than APScheduler, and it reads a five-field crontab the same way — `35 9 * * mon-fri`
 *  with a New York timezone fires at 09:35 Eastern, verified against the Python's own trigger. The
 *  schedule itself is phase 6; this is only the validation a route needs to answer 422.
 *
 *  Schedule cron tz stays America/New_York (CLAUDE.md), but the field is the owner's to set, so an
 *  unknown zone has to be rejected with a reason rather than accepted and silently misfired.
 */
import { Cron } from "croner";

/** Why this expression and zone cannot be scheduled, or null if they can. */
export function cronError(expr: string, tz: string): string | null {
  let cron: Cron;
  try {
    cron = new Cron(expr, { timezone: tz });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  try {
    // constructing is not enough: an unknown timezone only fails when a date is converted
    cron.nextRun();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    cron.stop();
  }
  return null;
}
