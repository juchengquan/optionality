/** Waiting on something that is NOT the page — the requests a fake service was sent, a write —
 *  in a test that fakes `setInterval` to drive the page's poll.
 *
 *  testing-library's `waitFor` re-checks its condition on a timer it starts with `setInterval`, and
 *  on every change to the DOM. Fake `setInterval` and that timer is faked too, so `waitFor` then
 *  re-checks ONLY when the DOM changes: a condition on a request is seen only if something is drawn
 *  after the request was made. In a NextPage test outside the session the holding's samples were the last thing
 *  asked for and their answer drew nothing, so under load — when they were asked after the page's
 *  last change rather than before it — the wait sat out its whole timeout with its condition true
 *  (#347, captured under load: all three reads in `calls`, the samples asked 3 ms after the last
 *  change to the DOM and nothing drawn after it, and the wait timed out at 10 s with its condition
 *  true).
 *
 *  `until` turns the event loop itself, on the real `setTimeout` these tests leave alone, and
 *  through `act`, so whatever an answer set off has been drawn, and its effects have asked, by the
 *  next check. It needs that `setTimeout` real: under `vi.useFakeTimers()` with nothing left out
 *  it would never turn. */
import { act } from "@testing-library/react";

/** Inside a test's own 5 s, so a failure says what was waited for rather than "timed out". */
export const UNTIL = 4_000;

export async function until(check: () => void, timeout = UNTIL): Promise<void> {
  const deadline = performance.now() + timeout;
  for (;;) {
    try {
      check();
      return;
    } catch (e: unknown) {
      if (performance.now() > deadline) throw e;
    }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
}
