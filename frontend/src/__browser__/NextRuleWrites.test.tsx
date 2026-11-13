/** Renaming a combo, splitting a total entry and recording a holding of a watched contract from the
 *  desk's inspector (#336), in a real layout engine, against a service that writes
 *  (`testing/ruleEdits.ts`): each sent through its route, the service's answer drawn after the
 *  reload, and a refusal said VISIBLY beside the box it is about. The phone is
 *  `NextRuleWrites.iphone.test.tsx`; the behaviour in detail is the jsdom suite's
 *  (`__tests__/NextRuleWrites.test.tsx`).
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Next } from "../next/Next";
import { serveRuleEdits, type Refusals } from "../testing/ruleEdits";
import { settle } from "./nextBook";

/* a day before every expiry in the book; only Date is faked, the page's timers run */
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T15:00:00Z") }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function openDesk(refuse?: Refusals) {
  await page.viewport(1440, 900);
  const writes = serveRuleEdits(refuse);
  render(<Next />);
  await settle();
  return writes;
}

const inspector = () => screen.getByRole("complementary", { name: /^inspector/ });

async function inspect(row: string) {
  await userEvent.click(screen.getByRole("button", { name: row }));
  return inspector();
}

/** Whether `el` is on the screen and on top: nothing drawn over its middle. */
function visible(el: HTMLElement): boolean {
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  const on = r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0
    && r.right <= document.documentElement.clientWidth + 0.5 && r.bottom <= window.innerHeight + 0.5;
  return on && el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
}

/** `below` is straight under `box`, in its column: said beside it. */
function beside(box: HTMLElement, below: HTMLElement) {
  const b = box.getBoundingClientRect();
  const s = below.getBoundingClientRect();
  expect(s.top).toBeGreaterThanOrEqual(b.bottom - 0.5);
  expect(s.top - b.bottom).toBeLessThan(16);
  expect(Math.abs(s.left - b.left)).toBeLessThan(2);
}

describe("renaming a combo from the inspector", () => {
  it("sends the name through PATCH, and the inspector is the service's renamed rule", async () => {
    const writes = await openDesk();
    const panel = await inspect("1218_P7150");
    await userEvent.click(within(panel).getByRole("button", { name: "edit 1218_P7150 spread value" }));
    const form = within(panel).getByRole("form", { name: "editing 1218_P7150 spread value" });
    await userEvent.fill(within(form).getByLabelText("name"), "dec-put");
    await userEvent.click(within(form).getByRole("button", { name: "save" }));
    await waitFor(() => expect(writes).toEqual([{ what: "PATCH /monitors/w-dec18", body: { name: "dec-put" } }]));
    await within(inspector()).findByRole("button", { name: "edit dec-put spread value" });
  });

  it("says a name already taken beside the name, on screen and on top", async () => {
    const writes = await openDesk();
    const panel = await inspect("1218_P7150");
    await userEvent.click(within(panel).getByRole("button", { name: "edit 1218_P7150 spread value" }));
    const form = within(panel).getByRole("form", { name: "editing 1218_P7150 spread value" });
    // the 12-31 call spread's value rule is on mid_price too
    await userEvent.fill(within(form).getByLabelText("name"), "1231_C7600");
    await userEvent.click(within(form).getByRole("button", { name: "save" }));
    const alert = await within(form).findByRole("alert");
    expect(writes).toHaveLength(1);
    expect(alert.textContent).toBe("monitor for (1231_C7600, mid_price) already exists");
    expect(visible(alert)).toBe(true);
    beside(within(form).getByLabelText("name"), alert);
  });
});

describe("splitting a total entry from a holding's inspector", () => {
  it("shows what each holding gets, sends the total, and the holding's Entry is the service's after", async () => {
    const writes = await openDesk();
    const panel = await inspect("1218_P6400");
    await userEvent.click(within(panel).getByRole("button", { name: "split a total entry across 1218_IC spread value" }));
    const form = within(panel).getByRole("form", { name: "split a total entry across 1218_IC spread value" });
    await userEvent.fill(within(form).getByLabelText("total entry, per contract"), "6.4");
    const table = within(form).getByRole("table");
    // inside the form it is part of: wider, it spilled past the inspector's edge, which scrolling
    // into view hid from `visible`
    expect(table.getBoundingClientRect().right).toBeLessThanOrEqual(form.getBoundingClientRect().right + 0.5);
    expect(visible(table)).toBe(true);
    expect(within(table).getAllByRole("row").slice(1).map((r) => r.textContent)).toEqual([
      "1218_C7300" + "2.00" + "2.00 — kept: it has a rule of its own",
      "1218_P6400" + "2.00" + "4.40 — the rest",
    ]);
    await userEvent.click(within(form).getByRole("button", { name: "save the split" }));
    await waitFor(() => expect(writes).toEqual([{ what: "POST /monitors/r-condor/total-entry", body: { entry: 6.4 } }]));
    await waitFor(() => expect(within(inspector()).queryByRole("form")).toBeNull());
    // the inspector's figures are the service's own, read again
    await waitFor(() => expect(within(inspector()).getByText("entry").nextSibling?.textContent).toBe("4.40"));
  });

  it("says the service's refusal beside the total, on screen and on top", async () => {
    const refusal = "every wing here has a rule of its own — set them individually";
    await openDesk({ totalEntry: () => [422, refusal] });
    const panel = await inspect("1218_P6400");
    await userEvent.click(within(panel).getByRole("button", { name: "split a total entry across 1218_IC spread value" }));
    const form = within(panel).getByRole("form", { name: "split a total entry across 1218_IC spread value" });
    await userEvent.fill(within(form).getByLabelText("total entry, per contract"), "6.4");
    await userEvent.click(within(form).getByRole("button", { name: "save the split" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe(refusal);
    expect(visible(alert)).toBe(true);
    beside(within(form).getByLabelText("total entry, per contract"), alert);
  });
});

describe("recording a holding of a watched contract from the inspector", () => {
  it("posts it through POST /spreads, and the holding takes the rule's place", async () => {
    const writes = await openDesk();
    const panel = await inspect("261231 8000C");
    await userEvent.click(within(panel).getByRole("button", { name: "I hold 261231 8000C delta" }));
    const form = within(panel).getByRole("form", { name: "record a holding of 261231 8000C delta" });
    expect(visible(within(form).getByTestId("hold-replaces"))).toBe(true);
    await userEvent.fill(within(form).getByLabelText("entry, per contract"), "0.8");
    await userEvent.click(within(form).getByRole("button", { name: "Record holding" }));
    await waitFor(() => expect(writes.map((w) => w.what)).toEqual(["POST /spreads"]));
    expect(writes[0]!.body).toEqual({
      strike_date: "2026-12-31",
      spreads: [{
        name: "1231_C8000", held: true, legs: [{ side: "short", option_type: "CALL", strike: 8000 }],
        entry: 0.8, contracts: 1, opened_at: "2026-11-10",
        monitors: [{ option_type: "CALL", strike: 8000, field: "option_delta", threshold: 0.1,
          direction: "above", compare: "abs" }],
      }],
    });
    // the holding is in the book, and the focus is somewhere a keyboard can go on from
    await screen.findByRole("button", { name: "1231_C8000" });
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it("says a holding's name already taken beside the name, on screen and on top", async () => {
    const refusal = "position '1231_C8000' already exists";
    await openDesk({ spreads: () => [409, refusal] });
    const panel = await inspect("261231 8000C");
    await userEvent.click(within(panel).getByRole("button", { name: "I hold 261231 8000C delta" }));
    const form = within(panel).getByRole("form", { name: "record a holding of 261231 8000C delta" });
    await userEvent.click(within(form).getByRole("button", { name: "Record holding" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe(refusal);
    expect(visible(alert)).toBe(true);
    beside(within(form).getByLabelText("name"), alert);
  });
});
