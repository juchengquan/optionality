/** Adding a spread on the desk (#293), in a real layout engine: the condor the audit timed entered
 *  as two spreads with its four Monitors, its actions COUNTED; the preview turning over as a leg's
 *  side is flipped; a refusal said in the form where it can be seen; and the panel fitting from a
 *  900px desk to a wide one, with each spread's payoff beside its fields once there is room.
 *  The phone's half is `NextAdd.iphone.test.tsx`; the behaviour is the jsdom suite's.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { overflowsSideways, serveAdding, settle } from "./nextBook";

afterEach(cleanup);

const ADDED = {
  positions: [{ id: "p1", name: "a" }, { id: "p2", name: "b" }],
  monitors: ["m1", "m2", "m3", "m4"].map((id) => ({ id, code: id, field: "mid_price" })),
  replaced: [],
};

/** What it took, as the audit counted it: every press of a button, every field typed into. */
function counter() {
  const n = { clicks: 0, typed: 0 };
  return {
    n,
    click: async (el: Element) => { n.clicks += 1; await userEvent.click(el); },
    type: async (label: string, text: string) => { n.typed += 1; await userEvent.fill(screen.getByLabelText(label), text); },
  };
}

async function openDesk(width = 1440, spreads = { status: 201, body: ADDED as object }) {
  await page.viewport(width, 900);
  const sent = serveAdding(spreads);
  render(<Next />);
  await settle();
  return sent;
}

const panel = () => screen.getByRole("region", { name: "add a spread or contract" });
/** What a spread's preview says its maximum loss is. */
const maxLoss = (n: number) => [...document.querySelectorAll(`[data-spread="${n}"] .nx-payoff-kv div`)]
  .find((d) => d.querySelector("dt")?.textContent === "max loss")?.querySelector("dd")?.textContent ?? null;
const curveOf = (n: number) =>
  document.querySelector(`[data-spread="${n}"] [data-curve]`)?.getAttribute("d") ?? null;

describe("adding a condor on the desk", () => {
  it("takes 3 clicks and 7 typed fields where the audit measured 34 and 16, the expiry typed once", async () => {
    const sent = await openDesk();
    const { n, click, type } = counter();
    await click(screen.getByRole("button", { name: "add" }));
    await type("expiry", "2026-12-18");
    await type("spread 1, leg 1 strike", "7150");
    await type("spread 1, leg 2 strike", "7100");
    await type("spread 1 entry", "1.50");
    await click(within(panel()).getByRole("button", { name: "call spread" }));
    await type("spread 2, leg 1 strike", "7700");
    await type("spread 2, leg 2 strike", "7750");
    await type("spread 2 entry", "1.25");
    await click(within(panel()).getByRole("button", { name: "Record 2 holdings + 4 Monitors" }));
    await waitFor(() => expect(sent).toHaveLength(1));

    expect(n).toEqual({ clicks: 3, typed: 7 });
    expect(n.clicks).toBeLessThan(34);
    expect(n.typed).toBeLessThan(16);
    const body = sent[0] as { strike_date: string; spreads: { held: boolean; monitors: unknown[] }[] };
    expect(body.strike_date).toBe("2026-12-18");
    expect(body.spreads.map((s) => [s.held, s.monitors.length])).toEqual([[true, 2], [true, 2]]);
    // saved: the panel closes and the page says what it made
    await waitFor(() => expect(screen.queryByRole("region", { name: "add a spread or contract" })).toBeNull());
    expect(await screen.findByText("added 2 holdings and 4 Monitors")).toBeTruthy();
  });
});

describe("the preview beside the form", () => {
  it("draws as the legs are typed, and turns over when a leg's side is flipped", async () => {
    await openDesk();
    await userEvent.click(screen.getByRole("button", { name: "add" }));
    await userEvent.fill(screen.getByLabelText("spread 1, leg 1 strike"), "7150");
    await userEvent.fill(screen.getByLabelText("spread 1, leg 2 strike"), "7100");
    await userEvent.fill(screen.getByLabelText("spread 1 entry"), "1.50");
    await waitFor(() => expect(curveOf(1)).not.toBeNull());
    await waitFor(() => expect(maxLoss(1)).toBe("-48.50 pts"));
    const credit = curveOf(1);

    // a wider spread moves the curve: it follows the legs as they change
    await userEvent.fill(screen.getByLabelText("spread 1, leg 2 strike"), "7050");
    await waitFor(() => expect(curveOf(1)).not.toBe(credit));
    await waitFor(() => expect(maxLoss(1)).toBe("-98.50 pts"));

    // the long leg flipped to short: two short puts can lose without a floor, and the curve says so
    const wide = curveOf(1);
    await userEvent.click(screen.getByRole("button", { name: "spread 1, leg 2 side: long — flip" }));
    await waitFor(() => expect(curveOf(1)).not.toBe(wide));
    await waitFor(() => expect(maxLoss(1)).toBe("no floor"));
  });
});

/** A combo of `n` legs, entered in `root` as the owner would: legs added to two, each strike typed,
 *  the last leg made a short call — its own side and type — and the Entry. */
async function enterCombo(root: HTMLElement, n: number): Promise<void> {
  await userEvent.fill(screen.getByLabelText("expiry"), "2026-12-18");
  for (let i = 2; i < n; i++) await userEvent.click(within(root).getByRole("button", { name: "spread 1: add a leg" }));
  const strikes = ["7150", "7100", "7050", "7000", "6950"].slice(0, n - 1).concat("7700");
  for (const [i, k] of strikes.entries()) await userEvent.fill(screen.getByLabelText(`spread 1, leg ${i + 1} strike`), k);
  await userEvent.click(within(root).getByRole("button", { name: `spread 1, leg ${n} side: long — flip` }));
  await userEvent.click(within(root).getByRole("button", { name: `spread 1, leg ${n} type: PUT — change` }));
  await userEvent.fill(screen.getByLabelText("spread 1 entry"), "3");
}

/** The legs a body sent, as side, type and strike. */
const legsSent = (body: unknown) => (body as { spreads: { legs: { side: string; option_type: string; strike: number }[] }[] })
  .spreads[0]!.legs.map((l) => `${l.side[0]}${l.option_type[0]}${l.strike}`);

describe("combos of 3 to 6 legs on the desk (#334)", () => {
  for (const n of [3, 5, 6]) {
    it(`adds a ${n}-leg combo, its preview drawn over every leg`, async () => {
      const sent = await openDesk();
      await userEvent.click(screen.getByRole("button", { name: "add" }));
      await enterCombo(panel(), n);
      await waitFor(() => expect(curveOf(1)).not.toBeNull());
      // a short call with nothing above it: the preview says so, which it can only do over all n
      await waitFor(() => expect(maxLoss(1)).toBe("no floor"));
      await userEvent.click(within(panel()).getByRole("button", { name: "Record holding + 3 Monitors" }));
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(legsSent(sent[0])).toEqual([
        "sP7150", "lP7100", ...["7050", "7000", "6950"].slice(0, n - 3).map((k) => `lP${k}`), "sC7700",
      ]);
    });
  }

  it("fits six legs in the panel at 900px, every remove button inside it", async () => {
    await openDesk(900);
    await userEvent.click(screen.getByRole("button", { name: "add" }));
    await enterCombo(panel(), 6);
    await settle();
    expect(overflowsSideways()).toBe(false);
    expect(within(panel()).queryByRole("button", { name: "spread 1: add a leg" })).toBeNull();
    const box = panel().getBoundingClientRect();
    for (const el of panel().querySelectorAll("input, button, svg")) {
      expect(el.getBoundingClientRect().right, el.outerHTML.slice(0, 80)).toBeLessThanOrEqual(box.right + 0.5);
    }
  });
});

describe("a refused request", () => {
  it("is said in the form, on top, where it can be read", async () => {
    await openDesk(1440, { status: 409, body: { detail: "position '1218_+P7100_-P7150' already exists" } });
    await userEvent.click(screen.getByRole("button", { name: "add" }));
    await userEvent.fill(screen.getByLabelText("expiry"), "2026-12-18");
    await userEvent.fill(screen.getByLabelText("spread 1, leg 1 strike"), "7150");
    await userEvent.fill(screen.getByLabelText("spread 1, leg 2 strike"), "7100");
    await userEvent.fill(screen.getByLabelText("spread 1 entry"), "1.50");
    await userEvent.click(within(panel()).getByRole("button", { name: /^Record/ }));
    const alert = await within(panel()).findByRole("alert");
    expect(alert.textContent).toBe("position '1218_+P7100_-P7150' already exists");
    // nothing drawn over it: the point at its centre is the message itself
    alert.scrollIntoView({ block: "center" });
    const r = alert.getBoundingClientRect();
    expect(alert.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))).toBe(true);
    expect(panel()).toBeTruthy();
  });
});

describe("the panel's fit", () => {
  for (const width of [900, 1280, 1920]) {
    it(`pushes nothing sideways at ${width}px, with two spreads open`, async () => {
      await openDesk(width);
      await userEvent.click(screen.getByRole("button", { name: "add" }));
      await userEvent.click(within(panel()).getByRole("button", { name: "condor as one holding" }));
      await userEvent.fill(screen.getByLabelText("spread 2, leg 1 strike"), "7150");
      await settle();
      expect(overflowsSideways()).toBe(false);
      const box = panel().getBoundingClientRect();
      for (const el of panel().querySelectorAll("input, button, svg")) {
        expect(el.getBoundingClientRect().right, el.outerHTML.slice(0, 80)).toBeLessThanOrEqual(box.right + 0.5);
      }
    });
  }

  it("sets each spread's payoff beside its fields when there is room", async () => {
    await openDesk(1440);
    await userEvent.click(screen.getByRole("button", { name: "add" }));
    const spread = document.querySelector<HTMLElement>('[data-spread="1"]')!;
    const fields = spread.querySelector(".nx-add-fields")!.getBoundingClientRect();
    const payoff = within(spread).getByRole("group", { name: "payoff at expiry" }).getBoundingClientRect();
    expect(payoff.left).toBeGreaterThanOrEqual(fields.right);
    expect(payoff.top).toBeLessThan(fields.bottom);
  });
});

describe("privacy", () => {
  afterEach(() => { document.cookie = "ui_privacy=;path=/;max-age=0"; });

  it("draws the contract count as dots, not digits", async () => {
    document.cookie = "ui_privacy=on;path=/";
    await openDesk();
    await userEvent.click(screen.getByRole("button", { name: "add" }));
    const count = screen.getByLabelText("spread 1 contracts") as HTMLInputElement;
    await userEvent.fill(count, "12");
    expect(count.value).toBe("12");
    expect(getComputedStyle(count).getPropertyValue("-webkit-text-security")).toBe("disc");
  });

  it("leaves it readable with privacy off", async () => {
    await openDesk();
    await userEvent.click(screen.getByRole("button", { name: "add" }));
    expect(getComputedStyle(screen.getByLabelText("spread 1 contracts")).getPropertyValue("-webkit-text-security")).toBe("none");
  });
});
