/** Whether a poll would disturb something being operated: the focus is inside a surface that says
 *  so itself, `data-poll="hold"` — an edit or add form, a confirmation, the column picker. An open
 *  sheet on its own does not hold the poll, so its figures stay live (`NextRefresh.test.tsx`).
 *
 *  A module of its own so the browser suites ask THIS where a focus trap landed, rather than a copy
 *  of it that could drift (`__browser__/NextPollWhileOpen*`). */
export function beingOperated(el: Element | null): boolean {
  return Boolean(el?.closest('[data-poll="hold"]'));
}

/** A poll's read that a tick skips while the last one is still out (`skipWhileOut`), and `reset`,
 *  which makes the next tick ask whatever is out. */
export interface Skipping {
  (): Promise<void>;
  reset: () => void;
}

/** `ask`, unless the last call is still out: then nothing is asked, and the caller gets that call's
 *  promise. For a poll's tick, which a slow answer must not stack (`Next`'s `useBook`): never for a
 *  caller that needs a read started after it asked — that is `oneAtATime`. `ask` must not reject.
 *
 *  BOUNDED: the page's reads carry no timeout of their own, and one that never settles — a socket
 *  dead without a reset — would otherwise stop the poll for good, the page drawing its last figures
 *  as if nothing were wrong. A call out for longer than `maxAge()` ms is given up on, and the next
 *  tick asks afresh (its late answer, if any, still lands only if no newer one has); and `reset`, on
 *  a refresh, gives it up at once. */
export function skipWhileOut(ask: () => Promise<void>, maxAge: () => number): Skipping {
  let out: { promise: Promise<void>; since: number } | null = null;
  const run = (() => {
    if (out !== null && Date.now() - out.since < maxAge()) return out.promise;
    const mine: { promise: Promise<void>; since: number } = { promise: Promise.resolve(), since: Date.now() };
    mine.promise = ask().finally(() => { if (out === mine) out = null; });
    out = mine;
    return mine.promise;
  }) as Skipping;
  run.reset = () => { out = null; };
  return run;
}

/** How long a poll's read may be out before the poll gives up on it and asks again: two polls, and
 *  never less than a minute (`skipWhileOut`). */
export function givenUpAfter(refreshSeconds: number): number {
  return Math.max(2 * refreshSeconds * 1000, 60_000);
}
