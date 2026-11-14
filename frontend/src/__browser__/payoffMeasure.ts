/** Measuring the payoff chart (#396) in a real layout engine, shared by the desk's suite and the
 *  phone's: what a chart's labels and tooltip look like on screen, as a list of faults. */
import { waitFor, within } from "@testing-library/react";
import { userEvent } from "@vitest/browser/context";

/** The payoff inside `root`, once its chart is drawn. */
export async function payoffIn(root: HTMLElement): Promise<HTMLElement> {
  const payoff = await within(root).findByRole("group", { name: "payoff at expiry" });
  await waitFor(() => {
    if (!payoff.querySelector(".nx-payoff-chart svg [data-curve]")) throw new Error("no chart yet");
  });
  return payoff;
}

/** What is announced for the price the crosshair is at. */
export const said = (payoff: HTMLElement) => payoff.querySelector("[data-said]")?.textContent ?? "";

const name = (t: Element) => `"${t.textContent}"`;

/** Everything wrong with how the chart is laid out: not drawn on visx (the curve and the shaded
 *  gain or loss), a label cut by the drawing's edge, two labels on top of one another, or the
 *  drawing wider than its box. */
export function chartFaults(payoff: HTMLElement): string[] {
  const out: string[] = [];
  const svg = payoff.querySelector<SVGSVGElement>(".nx-payoff-chart svg")!;
  if (!svg.querySelector("[data-curve]")?.getAttribute("d")?.startsWith("M")) out.push("no curve");
  if (!svg.querySelector(".nx-payoff-gain, .nx-payoff-loss")) out.push("no shading");
  const box = svg.getBoundingClientRect();
  const holder = payoff.querySelector(".nx-payoff-chart")!.getBoundingClientRect();
  if (box.right > holder.right + 0.5) out.push(`drawing ${Math.round(box.width)}px wider than its box`);
  const texts = [...svg.querySelectorAll("text")].filter((t) => t.getClientRects().length > 0);
  for (const t of texts) {
    const r = t.getBoundingClientRect();
    if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) {
      out.push(`cut: ${name(t)}`);
    }
    if (r.height < 10) out.push(`shrunk: ${name(t)} ${r.height}px`);
  }
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const [a, b] = [texts[i]!.getBoundingClientRect(), texts[j]!.getBoundingClientRect()];
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 1 && h > 1) out.push(`overlap: ${name(texts[i]!)} / ${name(texts[j]!)}`);
    }
  }
  return out;
}

/** Everything wrong with the tooltip: none shown, or reaching past the chart or past `root`. */
export function tipFaults(payoff: HTMLElement, root: HTMLElement): string[] {
  const tip = payoff.querySelector<HTMLElement>("[data-tip]");
  if (!tip) return ["no tooltip"];
  const r = tip.getBoundingClientRect();
  const out: string[] = [];
  for (const [what, b] of [["chart", payoff.querySelector(".nx-payoff-chart")!.getBoundingClientRect()],
    ["box", root.getBoundingClientRect()]] as const) {
    if (r.left < b.left - 0.5 || r.right > b.right + 0.5 || r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5) {
      out.push(`past the ${what}: ${Math.round(r.left)}..${Math.round(r.right)} × ${Math.round(r.top)}..${Math.round(r.bottom)}`);
    }
  }
  return out;
}

/** A real pointer moved over the drawing at the x of `mark` — a strike's rule or a breakeven's dot,
 *  which a hover cannot be aimed at itself: a rule is a line with no width, and Playwright will not
 *  hover what it calls invisible. */
export async function pointAt(payoff: HTMLElement, mark: Element): Promise<void> {
  const svg = payoff.querySelector<SVGSVGElement>(".nx-payoff-chart svg")!;
  const [m, s] = [mark.getBoundingClientRect(), svg.getBoundingClientRect()];
  const x = Math.min(Math.max(1, m.left + m.width / 2 - s.left), s.width - 1);
  await userEvent.hover(svg, { position: { x, y: s.height / 2 } } as never);
}
