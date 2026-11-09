/** The alarm engine's one door.
 *
 *  Three files behind it — `sweeper.ts` (the sweep), `health.ts` (the account of itself that
 *  `/health` reads) and `scheduler.ts` (the loop and its watchdog) — and `main.ts` is the only
 *  thing outside that needs any of them. That was already true before this directory existed:
 *  `sweeper.ts` and `scheduler.ts` were imported by `main.ts` and nothing else, and `health.ts` by
 *  `main.ts` and the sweeper. `check-seams` now holds it, so a route or a bot command cannot start
 *  a sweep — they get the `SweeperPort` in `deps`, which is `health.ts`'s and read-only.
 *
 *  ## What is deliberately NOT exported
 *
 *  `SweepHealth` itself. This is the one line in the file doing work, so it is worth saying why.
 *
 *  #230's mutation sweep left a hole open: replacing `sweeper: sweeper.health` in `main.ts` with a
 *  freshly constructed `SweepHealth` typechecked and passed all 143 route, app and boot tests,
 *  and the service it describes is one whose `/health` reports "starting" for ever while the
 *  sweeps run. Nothing caught it, and catching it needed a boot test that sweeps, which needs a
 *  fake provider in production code — worse than the hole.
 *
 *  Not exporting the class closes it instead. A second health account cannot be built from
 *  outside, because the only way to name the class is to reach past this door and `check-seams`
 *  refuses that. The engine constructs exactly one, inside `MonitorSweeper`, and hands it out as
 *  `sweeper.health`. That is the difference between a mistake nobody has made yet and a mistake
 *  nobody can write.
 *
 *  `notify.ts` is not in here either, and for a duller reason: `positions.ts` uses it for the
 *  manage-by notice, so it is not the engine's. Giving it a pass through this door would be the
 *  first exception, and exceptions are how these guards rot.
 */
export { MonitorSweeper, type SweeperDeps } from "./sweeper.ts";
export { Scheduler } from "./scheduler.ts";
export { STALE_AFTER_SWEEPS } from "./health.ts";
