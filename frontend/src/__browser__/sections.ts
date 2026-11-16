/** Browser test support: a detail's sections as drawn (part J of the owner's standard, 2026-11-16),
 *  shared by the desk's and the phone's measurements of them. */
import { HOLDING_SECTIONS, RULE_SECTIONS } from "../sections";

/** Each section drawn, with any part of it past the box it is drawn in. */
export function sectionsIn(box: HTMLElement): { order: string[]; past: string[] } {
  const edge = box.getBoundingClientRect();
  const drawn = [...box.querySelectorAll<HTMLElement>("[data-section]")];
  return {
    order: drawn.map((s) => s.dataset.section!),
    past: drawn.filter((s) => {
      const r = s.getBoundingClientRect();
      return r.left < edge.left - 0.5 || r.right > edge.right + 0.5;
    }).map((s) => s.dataset.section!),
  };
}

export const inListOrder = (drawn: string[]) => {
  const list: readonly string[] = drawn.includes("schedule") || drawn.includes("actions") ? HOLDING_SECTIONS : RULE_SECTIONS;
  return drawn.every((s, i) => list.includes(s) && (i === 0 || list.indexOf(s) > list.indexOf(drawn[i - 1]!)));
};
