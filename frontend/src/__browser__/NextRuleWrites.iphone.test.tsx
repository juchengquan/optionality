/** Renaming a combo and splitting a total entry on the phone (#336), and "Record as held" from a
 *  watch rule's sheet (#408), MEASURED under Playwright's iPhone profile against a service that writes
 *  (`testing/ruleEdits.ts`): each from the detail sheet, through its route; a refusal said in the
 *  sheet, on screen and on top; every box 16px so iOS does not zoom, every control 44pt, nothing
 *  pushed sideways at 390px; and the count hidden under privacy. Runs in the `iphone` instance only.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { serveRuleEdits, type Refusals } from "../testing/ruleEdits";
import { QUOTES } from "../testing/ownerBook";
import type { Entry } from "../shared/api";
import { overflowsSideways, settle } from "./nextBook";
import { hitBox } from "./targets";

beforeEach(() => { vi.setSystemTime(new Date("2026-11-10T15:00:00Z")); });
afterEach(() => { cleanup(); vi.useRealTimers(); document.cookie = "ui_privacy=; max-age=0; path=/"; });

async function show(refuse?: Refusals) {
  const writes = serveRuleEdits(refuse);
  render(<Next />);
  await settle();
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
    .filter((el) => { const r = hitBox(el); return r.width < 44 || r.height < 44; })
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
    await userEvent.click(within(sheet).getByRole("button", { name: "edit 1218_P7150 value" }));
    let form = within(sheet).getByRole("form", { name: "editing 1218_P7150 value" });
    // name, what it watches, compare and threshold, and the direction's ≥ / ≤ pair (#405)
    expect(form.querySelectorAll("input, select")).toHaveLength(4);
    expect(within(within(form).getByRole("group", { name: "direction" })).getAllByRole("button")).toHaveLength(2);
    measured(sheet, form);
    await userEvent.click(within(form).getByLabelText("name"));
    await userEvent.keyboard("{Escape}");
    expect(within(sheet).queryByRole("form")).toBeNull();
    await animationsDone();
    expect(screen.queryByRole("dialog")).not.toBeNull();

    await userEvent.click(within(sheet).getByRole("button", { name: "edit 1218_P7150 value" }));
    form = within(sheet).getByRole("form", { name: "editing 1218_P7150 value" });
    await userEvent.fill(within(form).getByLabelText("name"), "dec-put");
    await userEvent.click(within(form).getByRole("button", { name: "save" }));
    await waitFor(() => expect(writes).toEqual([{ what: "PATCH /monitors/w-dec18", body: { name: "dec-put" } }]));
    await within(sheet).findByRole("button", { name: "edit dec-put value" });
  });

  it("says a name already taken in the sheet, on screen and on top", async () => {
    await show();
    const sheet = await openSheet("1218_P7150");
    await userEvent.click(within(sheet).getByRole("button", { name: "edit 1218_P7150 value" }));
    const form = within(sheet).getByRole("form", { name: "editing 1218_P7150 value" });
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
    await userEvent.click(within(sheet).getByRole("button", { name: "split a total entry across 1218_IC value" }));
    const form = within(sheet).getByRole("form", { name: "split a total entry across 1218_IC value" });
    await userEvent.fill(within(form).getByLabelText("total entry, per contract"), "6.4");
    const table = within(form).getByRole("table");
    expect(table.getBoundingClientRect().right).toBeLessThanOrEqual(form.getBoundingClientRect().right + 0.5);
    expect(visible(table)).toBe(true);
    measured(sheet, form);
    await userEvent.keyboard("{Escape}");
    await animationsDone();
    expect(screen.queryByRole("dialog")).not.toBeNull();
    await userEvent.click(within(sheet).getByRole("button", { name: "split a total entry across 1218_IC value" }));
    await userEvent.fill(within(sheet).getByLabelText("total entry, per contract"), "6.4");
    await userEvent.click(within(sheet).getByRole("button", { name: "save the split" }));
    await waitFor(() => expect(writes).toEqual([{ what: "POST /monitors/r-condor/total-entry", body: { entry: 6.4 } }]));
    await waitFor(() => expect(within(sheet).getByText("entry").nextSibling?.textContent).toBe("4.40"));
  });

  it("says the service's refusal in the sheet, on screen and on top", async () => {
    const refusal = "set the other wings' credits first";
    await show({ totalEntry: () => [422, refusal] });
    const sheet = await openSheet("1218_P6400");
    await userEvent.click(within(sheet).getByRole("button", { name: "split a total entry across 1218_IC value" }));
    const form = within(sheet).getByRole("form", { name: "split a total entry across 1218_IC value" });
    await userEvent.fill(within(form).getByLabelText("total entry, per contract"), "6.4");
    await userEvent.click(within(form).getByRole("button", { name: "save the split" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe(refusal);
    expect(visible(alert)).toBe(true);
  });
});

describe("Record as held from a watch rule's sheet (#408)", () => {
  /** Every control a finger has to hit inside `root`, under 44pt. */
  const tooSmall = (root: Element) => [...root.querySelectorAll<HTMLElement>("button, select, input, a")]
    .filter((el) => el.getClientRects().length > 0)
    .filter((el) => { const r = hitBox(el); return r.width < 44 || r.height < 44; })
    .map((el) => el.getAttribute("aria-label") ?? el.textContent);
  const pastTheEdge = (root: Element) => [...root.querySelectorAll<HTMLElement>("*")]
    .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)
    .map((el) => el.className || el.tagName);

  for (const [card, label, kind] of [
    ["1218_P7150", "1218_P7150 value", "add a spread"], ["261231 8000C", "261231 8000C Δ", "add one contract"],
  ] as const) {
    it(`opens the add sheet over ${card}'s, prefilled, 44pt and inside the screen, and records it`, async () => {
      const writes = await show();
      const detail = await openSheet(card);
      const button = within(detail).getByRole("button", { name: `record ${label} as held` });
      expect(tooSmall(button.parentElement!)).toEqual([]);
      expect(visible(button)).toBe(true);
      await userEvent.click(button);
      const sheet = await screen.findByRole("dialog", { name: "Add a spread or contract" });
      await animationsDone();
      const form = within(sheet).getByRole("form", { name: kind });
      expect(within(form).getByRole("button", { name: "I hold it" }).getAttribute("aria-pressed")).toBe("true");
      const replaces = within(form).getByText(/^Replaces the watch rules:/);
      expect(visible(replaces)).toBe(true);
      expect(tooSmall(sheet)).toEqual([]);
      expect(pastTheEdge(sheet)).toEqual([]);
      expect([...form.querySelectorAll("input, select")].filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16))
        .toEqual([]);
      expect(overflowsSideways()).toBe(false);
      const entry = within(form).getByLabelText(kind === "add a spread" ? "spread 1 entry" : "entry");
      await userEvent.fill(entry, "0.8");
      await userEvent.click(within(form).getByRole("button", { name: /^Record holding/ }));
      await waitFor(() => expect(writes.map((w) => w.what)).toEqual(["POST /spreads"]));
      // both sheets gone, each taking its own entry back off the history, and the holding in the book
      await waitFor(() => expect(sheet.isConnected).toBe(false));
      await waitFor(() => expect(detail.isConnected).toBe(false));
      await waitFor(() => expect(history.state?.panel).toBeFalsy());
      await screen.findByText(/replacing \d watch rules?$/);
    });
  }

  it("says what it replaces, what it takes over and a name already on record, all inside the screen", async () => {
    const THETA = { ...QUOTES.find((q) => q.id === "w-dec18")!, id: "w-theta", field: "option_theta", threshold: 0.5 } as Entry;
    serveRuleEdits({}, [THETA], { names: ["1218_P7150"] });
    render(<Next />);
    await settle();
    await userEvent.click((await screen.findAllByRole("button", { name: "details of 1218_P7150" }))[0]!);
    const detail = await screen.findByRole("dialog");
    await animationsDone();
    await userEvent.click(within(detail).getByRole("button", { name: "record 1218_P7150 value as held" }));
    const sheet = await screen.findByRole("dialog", { name: "Add a spread or contract" });
    await animationsDone();
    const form = within(sheet).getByRole("form", { name: "add a spread" });
    for (const said of [
      within(form).getByText(/^Replaces the watch rules:/), within(form).getByText(/^Also links to this holding:/),
      within(form).getByRole("status", { name: "spread 1's name" }),
    ]) expect(visible(said)).toBe(true);
    expect(tooSmall(sheet)).toEqual([]);
    expect(pastTheEdge(sheet)).toEqual([]);
    expect(overflowsSideways()).toBe(false);
  });
});
