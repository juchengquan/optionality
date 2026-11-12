/** Adding one contract on the desk (#331), in a real layout engine: a Monitor on each of the six
 *  fields from the "+" panel, a lone contract recorded as held reaching the book's holdings, a
 *  refusal said in the form where it can be read, and the panel fitting from a 900px desk up.
 *  The phone's half is `NextAddContract.iphone.test.tsx`; the behaviour is the jsdom suite's.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { overflowsSideways, serveContract, settle } from "./nextBook";

afterEach(cleanup);

const FIELDS = [
  ["option_delta", "delta"], ["mid_price", "mid"], ["option_implied_volatility", "IV"],
  ["option_theta", "theta"], ["option_vega", "vega"], ["option_gamma", "gamma"],
] as const;

async function openDesk(width = 1440, spreads?: Parameters<typeof serveContract>[0]) {
  await page.viewport(width, 900);
  const writes = serveContract(spreads);
  render(<Next />);
  await settle();
  return writes;
}

const panel = () => screen.getByRole("region", { name: "adding a spread" });

/** "+", then one contract: the expiry, the strike, the threshold. */
async function startContract(threshold = "0.15") {
  await userEvent.click(screen.getByRole("button", { name: "add a spread" }));
  await userEvent.click(within(panel()).getByRole("button", { name: "one contract" }));
  await userEvent.fill(screen.getByLabelText("expiry"), "2026-12-18");
  await userEvent.fill(screen.getByLabelText("strike"), "7150");
  await userEvent.fill(screen.getByLabelText("threshold"), threshold);
}

describe("a single-contract Monitor on the desk", () => {
  it("can be added on each of the six fields", async () => {
    const writes = await openDesk();
    for (const [field, words] of FIELDS) {
      await startContract();
      await userEvent.selectOptions(screen.getByLabelText("what it watches"), words);
      await userEvent.click(within(panel()).getByRole("button", { name: "Watch it + 1 Monitor" }));
      await waitFor(() => expect(screen.queryByRole("region", { name: "adding a spread" })).toBeNull());
      expect(writes.at(-1)).toEqual({
        what: "POST /spreads",
        body: {
          strike_date: "2026-12-18",
          spreads: [{
            name: "1218_P7150", held: false, legs: [{ side: "short", option_type: "PUT", strike: 7150 }],
            monitors: [{ option_type: "PUT", strike: 7150, field, threshold: 0.15, direction: "above", compare: "abs" }],
          }],
        },
      });
    }
    expect(writes.map((w) => w.what)).toEqual(FIELDS.map(() => "POST /spreads"));
    expect(await screen.findAllByText("added 1 Monitor")).not.toHaveLength(0);
  });
});

describe("a lone contract held, on the desk", () => {
  it("is recorded with its Monitor, and appears among the holdings", async () => {
    const writes = await openDesk();
    await startContract();
    await userEvent.click(within(panel()).getByRole("button", { name: "I hold it" }));
    await userEvent.fill(screen.getByLabelText("entry"), "2.40");
    await userEvent.click(within(panel()).getByRole("button", { name: "Record holding + 1 Monitor" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "adding a spread" })).toBeNull());
    expect(writes.map((w) => w.what)).toEqual(["POST /spreads"]);
    expect(await screen.findByText("added 1 holding and 1 Monitor")).toBeTruthy();
    // the book read again: the holding is a row of it, by the name the form gave it
    const row = await screen.findByText("1218_P7150");
    expect(row.closest(".nx-main")).not.toBeNull();
  });
});

describe("a refused contract", () => {
  it("is said in the form, where it can be read, and the panel stays open", async () => {
    await openDesk(1440, { status: 422, body: { detail: "contract does not exist: US.SPXW261218P7150000 — check strike and expiry" } });
    await startContract();
    await userEvent.click(within(panel()).getByRole("button", { name: "Watch it + 1 Monitor" }));
    const alert = await within(panel()).findByRole("alert");
    expect(alert.textContent).toMatch(/^contract does not exist/);
    alert.scrollIntoView({ block: "center" });
    const r = alert.getBoundingClientRect();
    expect(alert.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))).toBe(true);
  });

  it("says a signed 0 beside the threshold, in view, before anything is sent", async () => {
    const writes = await openDesk();
    await startContract("0");
    await userEvent.selectOptions(screen.getByLabelText("compare"), "signed");
    const note = within(panel()).getByRole("status");
    expect(note.textContent).toBe("a signed threshold is never exactly 0: use e.g. ±0.01");
    // beside the box: directly under the Monitor's fields, not at the foot of the form
    const box = screen.getByLabelText("threshold").getBoundingClientRect();
    expect(note.getBoundingClientRect().top - box.bottom).toBeLessThan(40);
    await userEvent.click(within(panel()).getByRole("button", { name: "Watch it + 1 Monitor" }));
    expect(writes).toEqual([]);
  });
});

describe("the one-contract panel's fit", () => {
  for (const width of [900, 1280, 1920]) {
    it(`pushes nothing sideways at ${width}px, held, with its preview`, async () => {
      await openDesk(width);
      await startContract();
      await userEvent.click(within(panel()).getByRole("button", { name: "I hold it" }));
      await userEvent.fill(screen.getByLabelText("entry"), "2.40");
      await waitFor(() => expect(panel().querySelector("[data-curve]")).not.toBeNull());
      await settle();
      expect(overflowsSideways()).toBe(false);
      const edge = panel().getBoundingClientRect().right;
      for (const el of panel().querySelectorAll("input, select, button, svg")) {
        expect(el.getBoundingClientRect().right, el.outerHTML.slice(0, 80)).toBeLessThanOrEqual(edge + 0.5);
      }
    });
  }
});

describe("privacy, for one contract", () => {
  afterEach(() => { document.cookie = "ui_privacy=;path=/;max-age=0"; });

  it("draws the contract count as dots, not digits", async () => {
    document.cookie = "ui_privacy=on;path=/";
    await openDesk();
    await startContract();
    await userEvent.click(within(panel()).getByRole("button", { name: "I hold it" }));
    const count = screen.getByLabelText("contracts") as HTMLInputElement;
    await userEvent.fill(count, "12");
    expect(getComputedStyle(count).getPropertyValue("-webkit-text-security")).toBe("disc");
  });
});
