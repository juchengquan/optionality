/** A row's or a card's name as a test looks it up whether or not it is a holding's: a holding's
 *  name carries its "held" tag (2026-11-17), and a helper that opens either takes the bare name. The
 *  tag itself is held by `NextOneBook.test.tsx`, by exact name. */
export function heldOrNot(name: string): RegExp {
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( held)?$`);
}

/** A desk row's name button as its bare name: the holding's "held" tag, which the button's text
 *  carries after the name, left off — what the inspector is named by. */
export function bareName(button: Element): string {
  return button.textContent!.replace(/ held$/, "");
}
