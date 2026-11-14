/** Every browser test starts IN New York's session, at a pinned instant (#371).
 *
 *  Since #371 what the page fetches, and the few words that say when a figure was read, follow the
 *  session: outside it the References strip carries a time on every reading, the market-closed
 *  line is drawn above the book, and a Level's chip says when it was valued. This suite used to
 *  read the machine's real clock and pick a view by hand, which was enough while that switch
 *  decided; with the session deciding (and since #375 no switch at all), the same test would
 *  measure a different page at 11:00 and at 21:00 New York.
 *  So the clock is pinned here, and a test that measures the page outside the session pins its own
 *  with `vi.setSystemTime`. Only `Date`: the suite's timers stay real. */
import { afterEach, beforeEach, vi } from "vitest";

/** Thursday 12 November 2026, 12:00 New York */
const IN_SESSION = new Date("2026-11-12T17:00:00Z");

// Fake `Date` installed here, so a test file pins ANOTHER instant with `vi.setSystemTime`: a second
// `vi.useFakeTimers({ now })` on top of this one is a no-op (measured: a file pinning 2026-11-10
// read this instant instead), and `setSystemTime` before any fake timers makes a later
// `useFakeTimers` throw.
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: IN_SESSION }); });
afterEach(() => { vi.useRealTimers(); });
