/** Editing a Monitor in place on the phone (#292), MEASURED under Playwright's iPhone profile,
 *  against a service that writes (`testing/editBook.ts`): edited and saved from the detail sheet,
 *  a refusal said in the sheet where it can be read — on screen and on top, which the old page's
 *  toast drawn underneath its form was not — every box 16px so iOS does not zoom, every target
 *  44pt, and mute, unmute and delete with delete asking first. Runs in the `iphone` instance only.
 */
import { userEvent } from "@vitest/browser/context";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { serveEditing } from "../testing/editBook";
import { overflowsSideways, settle } from "./nextBook";

afterEach(cleanup);

const SPREAD = "1218_P7150 spread value";
const DELTA = "261218 7150P delta";

async function show(refuse?: Parameters<typeof serveEditing>[0]) {
  const writes = serveEditing(refuse);
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

/** The 12-18 put spread's sheet, with its own rule and its short leg's. */
async function openSheet() {
  await userEvent.click(screen.getByRole("button", { name: "details of 1218_P7150" }));
  const sheet = await screen.findByRole("dialog");
  await animationsDone();
  return sheet;
}

async function openEditor(sheet: HTMLElement, label: string) {
  await userEvent.click(within(sheet).getByRole("button", { name: `edit ${label}` }));
  return within(sheet).getByRole("form", { name: `editing ${label}` });
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

describe("editing a Monitor from the sheet", () => {
  it("saves a change and shows the service's sentence for it", async () => {
    const writes = await show();
    const sheet = await openSheet();
    const form = await openEditor(sheet, SPREAD);
    await userEvent.fill(within(form).getByLabelText("threshold"), "3");
    expect(within(form).getByTestId("draft").textContent).toBe("|spread value| ≥ 3");
    await userEvent.click(within(form).getByRole("button", { name: "save" }));
    await waitFor(() => expect(writes).toEqual([{ what: "PATCH /monitors/w-dec18", body: { threshold: 3 } }]));
    await waitFor(() => expect(within(sheet).queryByRole("form")).toBeNull());
    // the service's: 3 − |−2.4|, as it now serves the row
    expect(within(sheet).getByText(/^\|spread value\| ≥ 3 — now 2\.40, 0\.60 away$/)).toBeTruthy();
  });

  it("says a signed threshold of 0 in the sheet beside the threshold, on screen and on top", async () => {
    const refusal = "signed threshold cannot be 0; use e.g. ±0.01";
    await show((_, body) => body.threshold === 0 ? refusal : null);
    const sheet = await openSheet();
    const form = await openEditor(sheet, DELTA);
    await userEvent.selectOptions(within(form).getByLabelText("compare"), "signed");
    await userEvent.fill(within(form).getByLabelText("threshold"), "0");
    await userEvent.click(within(form).getByRole("button", { name: "save" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe(refusal);
    expect(sheet.contains(alert)).toBe(true);
    expect(visible(alert)).toBe(true);
    const box = within(form).getByLabelText("threshold").getBoundingClientRect();
    const said = alert.getBoundingClientRect();
    expect(said.top).toBeGreaterThanOrEqual(box.bottom - 0.5);
    expect(said.top - box.bottom).toBeLessThan(16);
  });

  it("gives every box 16px text so iOS does not zoom, every control 44pt, and pushes nothing sideways", async () => {
    await show();
    const sheet = await openSheet();
    const form = await openEditor(sheet, DELTA);
    const boxes = [...form.querySelectorAll("input, select")];
    expect(boxes).toHaveLength(4);
    const small = boxes.filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
      .map((el) => `${el.id} ${getComputedStyle(el).fontSize}`);
    expect(small).toEqual([]);
    const tiny = [...sheet.querySelectorAll<HTMLElement>(".nx-mon button, .nx-mon input, .nx-mon select")]
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width < 44 || r.height < 44; })
      .map((el) => el.getAttribute("aria-label") ?? el.textContent);
    expect(tiny).toEqual([]);
    const edge = document.documentElement.clientWidth;
    expect([...sheet.querySelectorAll<HTMLElement>(".nx-mon *")]
      .filter((el) => el.getBoundingClientRect().right > edge + 0.5).map((el) => el.className)).toEqual([]);
    expect(overflowsSideways()).toBe(false);
  });
});

describe("mute, unmute and delete on the phone", () => {
  it("mutes from the sheet, then unmutes from the switched-off list", async () => {
    const writes = await show();
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: `mute ${DELTA}` }));
    await waitFor(() => expect(writes).toHaveLength(1));
    history.back();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const off = await screen.findByRole("region", { name: "Switched off" });
    await userEvent.click(within(off).getByRole("button", { name: `unmute ${DELTA}` }));
    await waitFor(() => expect(writes.map((w) => [w.what, w.body])).toEqual([
      ["PATCH /monitors/w-dec18-delta", { enabled: false }],
      ["PATCH /monitors/w-dec18-delta", { enabled: true }],
    ]));
  });

  it("asks before deleting, in the sheet where it can be read", async () => {
    const writes = await show();
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: `delete ${DELTA}` }));
    const ask = within(sheet).getByRole("group", { name: `delete ${DELTA}?` });
    expect(visible(ask)).toBe(true);
    expect(writes).toEqual([]);
    await userEvent.click(within(ask).getByRole("button", { name: "delete it" }));
    await waitFor(() => expect(writes).toEqual([{ what: "DELETE /monitors/w-dec18-delta", body: null }]));
  });

  it("switches a quarantined rule back on from the switched-off list, saying why first", async () => {
    const writes = await show();
    const off = await screen.findByRole("region", { name: "Switched off" });
    await userEvent.click(within(off).getByRole("button", { name: "switch 261211 8000C delta back on" }));
    const ask = within(off).getByRole("group", { name: "switch 261211 8000C delta back on?" });
    expect(ask.textContent).toMatch(/does not know its contract US\.SPXW261211C8300000/);
    expect(writes).toEqual([]);
    await userEvent.click(within(ask).getByRole("button", { name: "switch it on" }));
    await waitFor(() => expect(writes).toEqual([{ what: "PATCH /monitors/q-unknown", body: { enabled: true } }]));
  });
});
