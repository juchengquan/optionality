/** The add form's leg colours (#391), measured in a real browser and shared by the desk's suite and
 *  the phone's, since both arrangements draw the one form: a type in its hue, tinted, the chosen
 *  one of a pair solid; a side by weight and sign, short solid with "−" and long dashed with "+",
 *  in no hue; and the mode pairs ("a spread"/"one contract", "I hold it"/"Watch it") neutral. */
import { within } from "@testing-library/react";
import { userEvent } from "@vitest/browser/context";
import { expect } from "vitest";

import { contrastInSitu } from "./nextBook";

/** A colour as the page resolves it inside `root`, computed through a probe — so it is compared in
 *  the form the browser serializes a computed colour, whatever that is. */
export function resolved(root: Element, colour: string): string {
  const probe = document.createElement("span");
  probe.style.color = colour;
  root.appendChild(probe);
  const out = getComputedStyle(probe).color;
  probe.remove();
  return out;
}

/** The opaque colour a computed `oklch(L C h / a)` or `oklch(L C h)` carries, without its alpha:
 *  a 12% tint of CALL is CALL's colour at 12%. */
export const opaque = (computed: string) => computed.replace(/\s*\/\s*[\d.]+%?\s*\)$/, ")");

const alpha = (computed: string) => {
  const m = /\/\s*([\d.]+)(%?)\s*\)$/.exec(computed);
  return m ? Number(m[1]) / (m[2] ? 100 : 1) : 1;
};

/** What a button looks like: its text, its fill and its border, and the sign before its words. */
function look(b: HTMLElement) {
  const s = getComputedStyle(b);
  const sign = b.querySelector(".nx-sign");
  return {
    color: s.color, fill: s.backgroundColor, border: s.borderTopColor, style: s.borderTopStyle,
    sign: sign && sign.getAttribute("aria-hidden") === "true" ? sign.textContent : null,
  };
}

/** The type buttons: in their type's hue, a tint behind, and the chosen one of a pair solid with
 *  the page's ground as its ink. */
export function expectTyped(root: Element, b: HTMLElement, type: "CALL" | "PUT", chosen: boolean) {
  const hue = resolved(root, `var(--${type.toLowerCase()})`);
  const other = resolved(root, `var(--${type === "CALL" ? "put" : "call"})`);
  const l = look(b);
  if (chosen) {
    expect(opaque(l.fill), `${type} chosen: its fill`).toBe(hue);
    expect(alpha(l.fill)).toBe(1);
    expect(l.color, `${type} chosen: its ink`).toBe(resolved(root, "var(--background)"));
  } else {
    expect(l.color, `${type}: its text`).toBe(hue);
    expect(opaque(l.fill), `${type}: its tint`).toBe(hue);
    expect(alpha(l.fill)).toBeCloseTo(0.12, 2);
  }
  expect(opaque(l.border)).toBe(hue);
  // readable on the ground it is drawn on: its tint over the panel or the sheet, or its solid fill
  expect(contrastInSitu(b), `${type}${chosen ? " chosen" : ""}: its words`).toBeGreaterThanOrEqual(4.5);
  expect([l.color, opaque(l.fill), opaque(l.border)]).not.toContain(other);
}

/** The side buttons: in no hue, short solid with "−", long dashed with "+". */
export function expectSided(root: Element, b: HTMLElement, side: "short" | "long") {
  const l = look(b);
  const hues = ["call", "put"].map((t) => resolved(root, `var(--${t})`));
  for (const c of [l.color, opaque(l.fill), opaque(l.border)]) expect(hues).not.toContain(c);
  // the sign is drawn, and said to nobody: the button's own words are its name
  expect(l.sign, `${side}: its sign`).toBe(side === "short" ? "−" : "+");
  expect(b.textContent).toBe(`${l.sign}${side}`);
  expect(l.style, `${side}: its border`).toBe(side === "short" ? "solid" : "dashed");
}

/** A mode pair: the page's neutral control, the chosen one in the foreground's colour, with no
 *  type hue and no sign anywhere. */
export function expectNeutral(root: Element, group: HTMLElement) {
  const hues = ["call", "put"].map((t) => resolved(root, `var(--${t})`));
  const foreground = resolved(root, "var(--foreground)");
  for (const b of within(group).getAllByRole("button")) {
    const l = look(b);
    for (const c of [l.color, opaque(l.fill), opaque(l.border)]) expect(hues, b.textContent!).not.toContain(c);
    expect(l.sign, b.textContent!).toBeNull();
    expect(l.style, b.textContent!).toBe("solid");
    if (b.getAttribute("aria-pressed") === "true") expect(l.fill, b.textContent!).toBe(foreground);
  }
}

/** The whole form inside `form`, as either arrangement draws it: the spread's legs, then one
 *  contract's pairs, and the mode pairs throughout. */
export async function expectFormColours(form: HTMLElement) {
  const root = form.closest(".nx, .nx-tokens")!;
  const q = within(form);
  expectNeutral(root, q.getByRole("group", { name: "what to add" }));
  expectNeutral(root, q.getByRole("group", { name: "add as" }));

  // a spread's leg: a type toggle tinted in its type, a side toggle by weight and sign
  const type = () => q.getByRole("button", { name: /^spread 1, leg 1 type: / });
  const side = () => q.getByRole("button", { name: /^spread 1, leg 1 side: / });
  const was = type().textContent as "CALL" | "PUT";
  expectTyped(root, type(), was, false);
  await userEvent.click(type());
  expectTyped(root, type(), was === "PUT" ? "CALL" : "PUT", false);
  const first = /side: (short|long)/.exec(side().getAttribute("aria-label")!)![1] as "short" | "long";
  expectSided(root, side(), first);
  await userEvent.click(side());
  expectSided(root, side(), first === "short" ? "long" : "short");

  // one contract: the PUT/CALL pair tinted, the chosen one solid; the side pair by weight and sign
  await userEvent.click(q.getByRole("button", { name: "one contract" }));
  await userEvent.click(q.getByRole("button", { name: "I hold it" }));
  expectNeutral(root, q.getByRole("group", { name: "what to add" }));
  expectNeutral(root, q.getByRole("group", { name: "add as" }));
  const pair = within(q.getByRole("group", { name: "type" }));
  for (const chosen of ["CALL", "PUT"] as const) {
    await userEvent.click(pair.getByRole("button", { name: chosen }));
    for (const t of ["CALL", "PUT"] as const) expectTyped(root, pair.getByRole("button", { name: t }), t, t === chosen);
  }
  const sides = within(q.getByRole("group", { name: "side" }));
  for (const s of ["short", "long"] as const) expectSided(root, sides.getByRole("button", { name: s }), s);
}
