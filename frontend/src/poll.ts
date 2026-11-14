/** Whether a poll would disturb something being operated: the focus is inside a surface that says
 *  so itself, `data-poll="hold"` — an edit or add form, a confirmation, the column picker. An open
 *  sheet on its own does not hold the poll, so its figures stay live (`NextRefresh.test.tsx`).
 *
 *  A module of its own so the browser suites ask THIS where a focus trap landed, rather than a copy
 *  of it that could drift (`__browser__/NextPollWhileOpen*`). */
export function beingOperated(el: Element | null): boolean {
  return Boolean(el?.closest('[data-poll="hold"]'));
}
