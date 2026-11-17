/** Renaming a combo and splitting a total entry from the desk's inspector (#336), and "Record as
 *  held" from a watch rule's (#408), in a real layout engine, against a service that writes
 *  (`testing/ruleEdits.ts`): each sent through its route, the service's answer drawn after the
 *  reload, and a refusal said VISIBLY beside the box it is about. The phone is
 *  `NextRuleWrites.iphone.test.tsx`; the behaviour in detail is the jsdom suite's
 *  (`__tests__/NextRuleWrites.test.tsx`).
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { serveRuleEdits, type Refusals } from "../testing/ruleEdits";
import { settle } from "./nextBook";

/* a day before every expiry in the book; only Date is faked, the page's timers run */
beforeEach(() => { vi.setSystemTime(new Date("2026-11-10T15:00:00Z")); });
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
    await userEvent.click(within(panel).getByRole("button", { name: "edit 1218_P7150 value" }));
    const form = within(panel).getByRole("form", { name: "editing 1218_P7150 value" });
    await userEvent.fill(within(form).getByLabelText("name"), "dec-put");
    await userEvent.click(within(form).getByRole("button", { name: "save" }));
    await waitFor(() => expect(writes).toEqual([{ what: "PATCH /monitors/w-dec18", body: { name: "dec-put" } }]));
    await within(inspector()).findByRole("button", { name: "edit dec-put value" });
  });

  it("says a name already taken beside the name, on screen and on top", async () => {
    const writes = await openDesk();
    const panel = await inspect("1218_P7150");
    await userEvent.click(within(panel).getByRole("button", { name: "edit 1218_P7150 value" }));
    const form = within(panel).getByRole("form", { name: "editing 1218_P7150 value" });
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
    await userEvent.click(within(panel).getByRole("button", { name: "split a total entry across 1218_IC value" }));
    const form = within(panel).getByRole("form", { name: "split a total entry across 1218_IC value" });
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
    await userEvent.click(within(panel).getByRole("button", { name: "split a total entry across 1218_IC value" }));
    const form = within(panel).getByRole("form", { name: "split a total entry across 1218_IC value" });
    await userEvent.fill(within(form).getByLabelText("total entry, per contract"), "6.4");
    await userEvent.click(within(form).getByRole("button", { name: "save the split" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe(refusal);
    expect(visible(alert)).toBe(true);
    beside(within(form).getByLabelText("total entry, per contract"), alert);
  });
});

describe("Record as held from the inspector (#408)", () => {
  it("opens the add sheet on screen, prefilled as held, the Entry focused; the save replaces the watch rules", async () => {
    const writes = await openDesk();
    const panel = await inspect("1218_P7150");
    const button = within(panel).getByRole("button", { name: "record 1218_P7150 value as held" });
    expect(visible(button)).toBe(true);
    await userEvent.click(button);
    const add = await screen.findByRole("dialog", { name: "Add" });
    const form = within(add).getByRole("form", { name: "add a spread" });
    const entry = within(form).getByLabelText("spread 1 entry");
    await waitFor(() => expect(document.activeElement).toBe(entry));
    expect(visible(entry)).toBe(true);
    const replaces = within(form).getByText(/^Replaces the watch rules:/);
    expect(replaces.textContent).toBe("Replaces the watch rules: 1218_P7150 |value| ≥ 6.00, 7150 put |Δ| ≥ 0.20");
    expect(visible(replaces)).toBe(true);
    for (const el of add.querySelectorAll<HTMLElement>("input, button")) {
      expect(el.getBoundingClientRect().right, el.outerHTML.slice(0, 80)).toBeLessThanOrEqual(add.getBoundingClientRect().right + 0.5);
    }
    await userEvent.fill(entry, "2.40");
    await userEvent.click(within(form).getByRole("button", { name: "Record holding + 2 rules" }));
    await waitFor(() => expect(writes.map((w) => w.what)).toEqual(["POST /spreads"]));
    expect((writes[0]!.body as { spreads: { name: string; legs: unknown[] }[] }).spreads[0]).toMatchObject({
      name: "1218_P7150", held: true, entry: 2.4,
      legs: [{ side: "short", option_type: "PUT", strike: 7150 }, { side: "long", option_type: "PUT", strike: 7100 }],
    });
    await screen.findByText("added 1 holding and 2 rules, replacing 2 watch rules");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add" })).toBeNull());
  });
});
