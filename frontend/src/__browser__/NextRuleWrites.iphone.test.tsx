/** Renaming a combo, splitting a total entry and recording a holding of a watched contract on the
 *  phone (#336), MEASURED under Playwright's iPhone profile against a service that writes
 *  (`testing/ruleEdits.ts`): each from the detail sheet, through its route; a refusal said in the
 *  sheet, on screen and on top; every box 16px so iOS does not zoom, every control 44pt, nothing
 *  pushed sideways at 390px; and the count hidden under privacy. Runs in the `iphone` instance only.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Next } from "../next/Next";
import { serveRuleEdits, type Refusals } from "../testing/ruleEdits";
import { overflowsSideways, settle } from "./nextBook";

beforeEach(() => { vi.setSystemTime(new Date("2026-11-10T15:00:00Z")); });
afterEach(() => { cleanup(); vi.useRealTimers(); document.cookie = "ui_privacy=; max-age=0; path=/"; });

async function show(refuse?: Refusals) {
  const writes = serveRuleEdits(refuse);
  render(<Next />);
  await settle();
  await userEvent.click(within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name: "Live" }));
  await settle();
  return writes;
}

/** A dialog slides in, and a box measured mid-animation is not where it will be. */
async function animationsDone(): Promise<void> {
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  await new Promise((r) => setTimeout(r, 50));
}

async function openSheet(card: string) {
  await userEvent.click(screen.getByRole("button", { name: `details of ${card}` }));
  const sheet = await screen.findByRole("dialog");
  await animationsDone();
  return sheet;
}

/** Whether `el` is on the screen and on top: nothing — not the sheet's backdrop, not a toast —
 *  drawn over its middle. */
function visible(el: HTMLElement): boolean {
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  const on = r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0
    && r.right <= document.documentElement.clientWidth + 0.5 && r.bottom <= window.innerHeight + 0.5;
  return on && el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
}

/** The phone's rules for a form inside the sheet: 16px boxes, 44pt targets, nothing past the edge. */
function measured(sheet: HTMLElement, form: HTMLElement) {
  const small = [...form.querySelectorAll("input, select")]
    .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
    .map((el) => `${el.id} ${getComputedStyle(el).fontSize}`);
  expect(small).toEqual([]);
  const tiny = [...sheet.querySelectorAll<HTMLElement>(".nx-mon button, .nx-mon input, .nx-mon select")]
    .filter((el) => el.getClientRects().length > 0)
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width < 44 || r.height < 44; })
    .map((el) => el.getAttribute("aria-label") ?? el.id ?? el.textContent);
  expect(tiny).toEqual([]);
  const edge = document.documentElement.clientWidth;
  expect([...sheet.querySelectorAll<HTMLElement>(".nx-mon *")]
    .filter((el) => el.getBoundingClientRect().right > edge + 0.5).map((el) => el.className || el.tagName)).toEqual([]);
  expect(overflowsSideways()).toBe(false);
}

describe("renaming a combo from the sheet", () => {
  it("renames it, the name box 16px and 44pt, and keeps the sheet open when Escape cancels", async () => {
    const writes = await show();
    const sheet = await openSheet("1218_P7150");
    await userEvent.click(within(sheet).getByRole("button", { name: "edit 1218_P7150 spread value" }));
    let form = within(sheet).getByRole("form", { name: "editing 1218_P7150 spread value" });
    expect(form.querySelectorAll("input, select")).toHaveLength(5);
    measured(sheet, form);
    await userEvent.click(within(form).getByLabelText("name"));
    await userEvent.keyboard("{Escape}");
    expect(within(sheet).queryByRole("form")).toBeNull();
    await animationsDone();
    expect(screen.queryByRole("dialog")).not.toBeNull();

    await userEvent.click(within(sheet).getByRole("button", { name: "edit 1218_P7150 spread value" }));
    form = within(sheet).getByRole("form", { name: "editing 1218_P7150 spread value" });
    await userEvent.fill(within(form).getByLabelText("name"), "dec-put");
    await userEvent.click(within(form).getByRole("button", { name: "save" }));
    await waitFor(() => expect(writes).toEqual([{ what: "PATCH /monitors/w-dec18", body: { name: "dec-put" } }]));
    await within(sheet).findByRole("button", { name: "edit dec-put spread value" });
  });

  it("says a name already taken in the sheet, on screen and on top", async () => {
    await show();
    const sheet = await openSheet("1218_P7150");
    await userEvent.click(within(sheet).getByRole("button", { name: "edit 1218_P7150 spread value" }));
    const form = within(sheet).getByRole("form", { name: "editing 1218_P7150 spread value" });
    await userEvent.fill(within(form).getByLabelText("name"), "1231_C7600");
    await userEvent.click(within(form).getByRole("button", { name: "save" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe("monitor for (1231_C7600, mid_price) already exists");
    expect(visible(alert)).toBe(true);
  });
});

describe("splitting a total entry from a holding's sheet", () => {
  it("shows what each holding gets inside 390px, and the holding's Entry is the service's after", async () => {
    const writes = await show();
    const sheet = await openSheet("1218_P6400");
    await userEvent.click(within(sheet).getByRole("button", { name: "split a total entry across 1218_IC spread value" }));
    const form = within(sheet).getByRole("form", { name: "split a total entry across 1218_IC spread value" });
    await userEvent.fill(within(form).getByLabelText("total entry, per contract"), "6.4");
    const table = within(form).getByRole("table");
    expect(table.getBoundingClientRect().right).toBeLessThanOrEqual(form.getBoundingClientRect().right + 0.5);
    expect(visible(table)).toBe(true);
    measured(sheet, form);
    await userEvent.keyboard("{Escape}");
    await animationsDone();
    expect(screen.queryByRole("dialog")).not.toBeNull();
    await userEvent.click(within(sheet).getByRole("button", { name: "split a total entry across 1218_IC spread value" }));
    await userEvent.fill(within(sheet).getByLabelText("total entry, per contract"), "6.4");
    await userEvent.click(within(sheet).getByRole("button", { name: "save the split" }));
    await waitFor(() => expect(writes).toEqual([{ what: "POST /monitors/r-condor/total-entry", body: { entry: 6.4 } }]));
    await waitFor(() => expect(within(sheet).getByText("entry").nextSibling?.textContent).toBe("4.40"));
  });

  it("says the service's refusal in the sheet, on screen and on top", async () => {
    const refusal = "set the other wings' credits first";
    await show({ totalEntry: () => [422, refusal] });
    const sheet = await openSheet("1218_P6400");
    await userEvent.click(within(sheet).getByRole("button", { name: "split a total entry across 1218_IC spread value" }));
    const form = within(sheet).getByRole("form", { name: "split a total entry across 1218_IC spread value" });
    await userEvent.fill(within(form).getByLabelText("total entry, per contract"), "6.4");
    await userEvent.click(within(form).getByRole("button", { name: "save the split" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe(refusal);
    expect(visible(alert)).toBe(true);
  });
});

describe("recording a holding of a watched contract from its sheet", () => {
  it("records it through POST /spreads, every box 16px and 44pt, and the holding reaches the book", async () => {
    const writes = await show();
    const sheet = await openSheet("261231 8000C");
    await userEvent.click(within(sheet).getByRole("button", { name: "I hold 261231 8000C delta" }));
    const form = within(sheet).getByRole("form", { name: "record a holding of 261231 8000C delta" });
    expect(form.querySelectorAll("input, select")).toHaveLength(5);
    measured(sheet, form);
    await userEvent.click(within(form).getByLabelText("entry, per contract"));
    await userEvent.keyboard("{Escape}");
    expect(within(sheet).queryByRole("form")).toBeNull();
    await animationsDone();
    expect(screen.queryByRole("dialog")).not.toBeNull();

    await userEvent.click(within(sheet).getByRole("button", { name: "I hold 261231 8000C delta" }));
    await userEvent.fill(within(sheet).getByLabelText("entry, per contract"), "0.8");
    await userEvent.click(within(sheet).getByRole("button", { name: "Record holding" }));
    await waitFor(() => expect(writes.map((w) => w.what)).toEqual(["POST /spreads"]));
    // the rule the sheet was about is replaced, so the sheet closes with it, taking its own entry
    // back off the history; the holding is in the book
    await waitFor(() => expect(sheet.isConnected).toBe(false));
    expect(history.state?.panel).toBeFalsy();
    // and said in a toast, which is not drawn over the sheet that has gone
    await screen.findByText("recorded 1231_C8000, replacing 1 watch rule");
    await screen.findByRole("button", { name: "details of 1231_C8000" });
  });

  it("says a refusal in the sheet, on screen and on top", async () => {
    const refusal = "the provider does not know US.SPXW261231C8000000";
    await show({ spreads: () => [422, refusal] });
    const sheet = await openSheet("261231 8000C");
    await userEvent.click(within(sheet).getByRole("button", { name: "I hold 261231 8000C delta" }));
    const form = within(sheet).getByRole("form", { name: "record a holding of 261231 8000C delta" });
    await userEvent.click(within(form).getByRole("button", { name: "Record holding" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe(refusal);
    expect(visible(alert)).toBe(true);
  });

  it("hides the count under privacy, drawn as dots", async () => {
    document.cookie = "ui_privacy=on; path=/";
    await show();
    const sheet = await openSheet("261231 8000C");
    await userEvent.click(within(sheet).getByRole("button", { name: "I hold 261231 8000C delta" }));
    const box = within(sheet).getByLabelText("contracts");
    expect(getComputedStyle(box).getPropertyValue("-webkit-text-security")).toBe("disc");
  });
});
