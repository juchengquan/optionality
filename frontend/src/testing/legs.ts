/** Every leg drawn inside `root` through `shared/Legs.tsx` (#391), as "<its text> <side> <type>":
 *  `-2P6300 short PUT`, and `C7300 - CALL` for a rule's lone contract, which has no side. A place
 *  that writes its legs as plain text draws none, so a test of the place reads `[]` instead of
 *  the legs it shows — which is what holds every place to the shared drawing. */
export function legMarks(root: ParentNode): string[] {
  return [...root.querySelectorAll<HTMLElement | SVGElement>(".nx-leg")].map((leg) => {
    const type = leg.querySelector<HTMLElement | SVGElement>(".nx-leg-t");
    return `${leg.textContent} ${leg.dataset.side ?? "-"} ${type?.dataset.type ?? "?"}`;
  });
}
