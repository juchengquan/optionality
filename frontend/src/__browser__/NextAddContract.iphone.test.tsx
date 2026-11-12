/** Adding one contract on the phone (#331), MEASURED under Playwright's iPhone profile: the Add tab's
 *  sheet adds a Monitor on each of the six fields, records a lone contract as held and shows it in
 *  the book, says a refusal in the sheet where it can be read, and with the held form open pushes
 *  nothing past the screen's edge and gives every control a 44pt target with 16px text. Runs in the
 *  suite's `iphone` instance only; the desk is `NextAddContract.test.tsx`.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { overflowsSideways, serveContract, settle } from "./nextBook";

afterEach(cleanup);

const FIELDS = [
  ["option_delta", "delta"], ["mid_price", "mid"], ["option_implied_volatility", "IV"],
  ["option_theta", "theta"], ["option_vega", "vega"], ["option_gamma", "gamma"],
] as const;

/** A dialog slides in, and a box measured mid-animation is not where it will be. */
async function animationsDone(): Promise<void> {
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  await new Promise((r) => setTimeout(r, 50));
}

async function openPhone(spreads?: Parameters<typeof serveContract>[0]) {
  const writes = serveContract(spreads);
  render(<Next />);
  await settle();
  return writes;
}

const addTab = () => within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name: "Add" });
const sheet = () => screen.getByRole("dialog", { name: "Add a spread" });

/** The Add tab, then one contract: the expiry, the strike, the threshold. */
async function startContract(threshold = "0.15") {
  await userEvent.click(addTab());
  await screen.findByRole("dialog", { name: "Add a spread" });
  await animationsDone();
  await userEvent.click(within(sheet()).getByRole("button", { name: "one contract" }));
  await userEvent.fill(screen.getByLabelText("expiry"), "2026-12-18");
  await userEvent.fill(screen.getByLabelText("strike"), "7150");
  await userEvent.fill(screen.getByLabelText("threshold"), threshold);
}

/** Every control a finger has to hit inside `root`, under 44pt. */
function tooSmall(root: Element): string[] {
  return [...root.querySelectorAll<HTMLElement>("button, select, input, a")]
    .filter((el) => el.getClientRects().length > 0)
    .flatMap((el) => {
      const r = el.getBoundingClientRect();
      return r.width < 44 || r.height < 44
        ? [`${el.tagName.toLowerCase()} "${el.getAttribute("aria-label") ?? el.textContent?.trim()}" ${Math.round(r.width)}×${Math.round(r.height)}`]
        : [];
    });
}

/** Anything in the sheet reaching past the screen's right edge. */
function pastTheEdge(root: Element): string[] {
  const edge = document.documentElement.clientWidth;
  return [...root.querySelectorAll<HTMLElement>("*")]
    .filter((el) => el.getBoundingClientRect().right > edge + 0.5)
    .map((el) => `${el.tagName.toLowerCase()}.${el.className} right=${Math.round(el.getBoundingClientRect().right)}`);
}

describe("a single-contract Monitor on the phone", () => {
  it("can be added on each of the six fields", async () => {
    const writes = await openPhone();
    for (const [field, words] of FIELDS) {
      await startContract();
      await userEvent.selectOptions(screen.getByLabelText("what it watches"), words);
      await userEvent.click(within(sheet()).getByRole("button", { name: "Watch it + 1 Monitor" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a spread" })).toBeNull());
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
      // the toast saying so sits over the tab bar until it goes: closed, as a thumb would
      for (const close of document.querySelectorAll('[data-slot="toast-close"]')) await userEvent.click(close);
      await waitFor(() => expect(document.querySelector('[data-slot="toast-content"]')).toBeNull());
      await animationsDone();
    }
    expect(writes.map((w) => w.what)).toEqual(FIELDS.map(() => "POST /spreads"));
    // six sheets opened, filled, saved and closed, each with its toast: longer than one test's default
  }, 45_000);
});

describe("a lone contract held, on the phone", () => {
  it("is recorded with its Monitor, and appears among the holdings", async () => {
    const writes = await openPhone();
    await startContract();
    await userEvent.click(within(sheet()).getByRole("button", { name: "I hold it" }));
    await userEvent.click(within(sheet()).getByRole("button", { name: "long" }));
    await userEvent.fill(screen.getByLabelText("entry"), "5.20");
    await userEvent.click(within(sheet()).getByRole("button", { name: "Record holding + 1 Monitor" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a spread" })).toBeNull());
    expect(writes.map((w) => w.what)).toEqual(["POST /spreads"]);
    expect((writes[0]!.body as { spreads: object[] }).spreads[0])
      .toMatchObject({ held: true, entry: -5.2, legs: [{ side: "long", option_type: "PUT", strike: 7150 }] });
    // the book read again: the holding is a card of it, by the name the form gave it
    const name = await screen.findByText("1218_P7150");
    expect(name.closest(".nx-main")).not.toBeNull();
  });
});

describe("the one-contract sheet", () => {
  it("says a refusal inside the sheet, where it can be read", async () => {
    await openPhone({ status: 422, body: { detail: "contract does not exist: US.SPXW261218P7150000 — check strike and expiry" } });
    await startContract();
    await userEvent.click(within(sheet()).getByRole("button", { name: "Watch it + 1 Monitor" }));
    const alert = await within(sheet()).findByRole("alert");
    expect(alert.textContent).toMatch(/^contract does not exist/);
    alert.scrollIntoView({ block: "center" });
    const r = alert.getBoundingClientRect();
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.right).toBeLessThanOrEqual(document.documentElement.clientWidth + 0.5);
    expect(alert.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))).toBe(true);
  });

  it("held, with its preview and a signed 0 said, pushes nothing sideways; every target 44pt, every box 16px", async () => {
    await openPhone();
    await startContract("0");
    await userEvent.click(within(sheet()).getByRole("button", { name: "I hold it" }));
    await userEvent.selectOptions(screen.getByLabelText("compare"), "signed");
    await userEvent.fill(screen.getByLabelText("entry"), "2.40");
    await waitFor(() => expect(sheet().querySelector("[data-curve]")).not.toBeNull());
    expect(within(sheet()).getByRole("status").textContent).toBe("a signed threshold is never exactly 0: use e.g. ±0.01");
    await settle();
    expect(overflowsSideways()).toBe(false);
    expect(pastTheEdge(sheet())).toEqual([]);
    expect(tooSmall(sheet())).toEqual([]);
    const small = [...sheet().querySelectorAll("input, select")]
      .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => el.getAttribute("aria-label"));
    expect(small).toEqual([]);
  });
});
