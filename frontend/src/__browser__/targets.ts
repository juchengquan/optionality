/** A control's hit target as a finger meets it (ADR 0023: 44pt on the phone), MEASURED rather than
 *  read off its box. Since 2026-11-16 a phone's button is DRAWN about 32px high and reaches its 44pt
 *  through an invisible area around it (next.css: the phone's `button::after`), so its box is no
 *  longer its target; and a target is only as tall as the part of it no neighbour lies over.
 *
 *  So this asks the browser what lies under a finger: from the control's centre outward, up, down,
 *  left and right, half a pixel at a time, for as long as the control (or something inside it) is
 *  the first CONTROL in `elementsFromPoint`'s stack. Another control over the edge — a neighbour's
 *  own invisible area included — or an area that is not there shortens the answer, which is the
 *  failure a box measurement could never see. What is not a control is looked through: text, a
 *  card, a sheet's panel or a dialog's backdrop over the page, which the boxes the suites measured
 *  before looked through as well.
 *
 *  The control is brought into the middle of its scroller first, since a point off the screen hits
 *  nothing. A control switched off with `pointer-events: none` (shadcn's disabled button) would be
 *  passed through by every probe; it is measured as it is when switched on, and then put back.
 */
export interface Hit { width: number; height: number }

/** What a finger can land on instead. */
const CONTROL = "button, a[href], input, select, textarea, [role='button'], [role='switch'], [role='checkbox']";

/** The layer a control is drawn in: the dialog it is inside, or the page. */
const layerOf = (el: Element) => el.closest("[role='dialog'], [role='alertdialog']");

/** How far, at most, a probe looks: further than any target this page draws. */
const FAR = 80;

export function hitBox(el: HTMLElement): Hit {
  el.scrollIntoView({ block: "center", inline: "center" });
  const passedThrough = getComputedStyle(el).pointerEvents === "none";
  const was = el.style.pointerEvents;
  if (passedThrough) el.style.pointerEvents = "auto";
  try {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // a control is measured among the controls of its own layer — the page, or the dialog it is in —
    // and another layer's are looked through, as its box was before: a control behind an open dialog
    // has the target it has when the dialog is shut
    const layer = layerOf(el);
    const lands = (x: number, y: number) => {
      const control = document.elementsFromPoint(x, y)
        .find((at) => at === el || el.contains(at) || (at.matches(CONTROL) && layerOf(at) === layer));
      return control !== undefined && (control === el || el.contains(control));
    };
    if (!lands(cx, cy)) return { width: 0, height: 0 };
    const reach = (dx: number, dy: number) => {
      let n = 0;
      while (n < FAR && lands(cx + dx * (n + 0.5), cy + dy * (n + 0.5))) n += 0.5;
      // the edge lies between the last probe that landed and the first that did not: halved to
      // 1/64px, and the middle of what is left taken as the edge
      let lo = n, hi = n + 0.5;
      while (hi - lo > 1 / 64) {
        const mid = (lo + hi) / 2;
        if (lands(cx + dx * mid, cy + dy * mid)) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    };
    // to the nearest 1/8px: finer than that is the probes' own error, and a target of exactly 44
    // must not read as 43.98 for where its edges fell between them
    const eighth = (n: number) => Math.round(n * 8) / 8;
    return { width: eighth(reach(-1, 0) + reach(1, 0)), height: eighth(reach(0, -1) + reach(0, 1)) };
  } finally {
    if (passedThrough) el.style.pointerEvents = was;
  }
}

/** Every control in `els` a finger cannot hit as 44pt, named with what it measured. */
export function tooSmall(els: Iterable<HTMLElement>): string[] {
  return [...els].filter((el) => el.getClientRects().length > 0 && el.getAttribute("type") !== "hidden")
    .flatMap((el) => {
      const h = hitBox(el);
      return h.width < 44 || h.height < 44
        ? [`${el.tagName.toLowerCase()} "${el.getAttribute("aria-label") ?? el.textContent?.trim()}" ${Math.round(h.width)}×${Math.round(h.height)}`]
        : [];
    });
}
