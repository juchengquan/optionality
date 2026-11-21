/** A jump to a row in a folded expiry group (the owner, 2026-11-21): a needs-you banner's tap, the
 *  palette's landing or a spread picked on the price map. Each opens the group first, as a press on
 *  its heading would — this tab's wanted state, written to the cookie as it stands (`folds.ts`) —
 *  and only then brings the row into view: a row still hidden has nowhere to be scrolled to. */

/** Opens the folded group `row` is in, by its heading, and calls `then` once the group is drawn
 *  open; for a row in an open group, or none, `then` at once. */
export function unfolding(row: Element | null | undefined, then: () => void): void {
  const body = row?.closest<HTMLElement>(".nx-expiry-body[hidden]");
  if (!body) { then(); return; }
  // matched on the attribute rather than through a selector, so an id needs no escaping
  const heading = [...document.querySelectorAll<HTMLElement>("[aria-controls]")]
    .find((b) => b.getAttribute("aria-controls") === body.id);
  heading?.click();
  // the press's render lands before a task does: React flushes a click's update before the next task
  setTimeout(then, 0);
}
