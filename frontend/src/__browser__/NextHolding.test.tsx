/** Editing, closing, correcting and deleting a holding on the desk (#294), in a real layout engine:
 *  each done from the inspector against a service that remembers it, the forms and the close's
 *  account fitting beside the table from a 900px desk to a wide one, and the account where it can
 *  be read. The phone's half is `NextHolding.iphone.test.tsx`; the behaviour is the jsdom suite's.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../next/Next";
import { holdingService, type HoldingService } from "../testing/holdingService";
import { HOLDINGS } from "../testing/ownerBook";
import { overflowsSideways, settle } from "./nextBook";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.cookie = "ui_arrangement=;path=/;max-age=0";
});

/** Noon in New York, in the session, so the page opens in LIVE whatever the machine's clock says. */
const IN_SESSION = new Date("2026-11-12T17:00:00Z");

async function openDesk(width = 1440): Promise<HoldingService> {
  vi.useFakeTimers({ toFake: ["Date"], now: IN_SESSION });
  await page.viewport(width, 900);
  document.cookie = "ui_arrangement=desk;path=/";
  const s = holdingService({ holdings: HOLDINGS.map((h) => h.id === "h-ic" ? { ...h, cost_to_close: 1.225 } : h) });
  window.fetch = s.fetch;
  render(<Next />);
  await settle();
  return s;
}

async function inspect(id: string): Promise<HTMLElement> {
  const row = document.querySelector<HTMLElement>(`.nxd-row[data-ref="${id}"]`)!;
  await userEvent.click(row.querySelector<HTMLElement>(".nxd-name")!);
  return screen.getByRole("complementary", { name: /^inspector:/ });
}

const writes = (s: HoldingService) => s.writes().map((w) => [`${w.method} ${w.path}`, w.body]);

/** Everything inside `root` that reaches past the screen's right edge. */
function pastTheEdge(root: Element): string[] {
  const edge = document.documentElement.clientWidth;
  return [...root.querySelectorAll<HTMLElement>("*")]
    .filter((el) => el.getBoundingClientRect().right > edge + 0.5)
    .map((el) => `${el.tagName.toLowerCase()}.${el.className} right=${Math.round(el.getBoundingClientRect().right)}`);
}

describe("changing a holding from the inspector", () => {
  it("edits it, closes it with the served Cost to close, corrects the close, and deletes another", async () => {
    const s = await openDesk();
    let insp = await inspect("h-ic");
    await userEvent.click(within(insp).getByRole("button", { name: "Edit" }));
    await userEvent.fill(within(insp).getByLabelText("entry, per contract"), "5.2");
    await userEvent.click(within(insp).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes(s)).toEqual([["PATCH /positions/h-ic", { entry: 5.2 }]]));

    insp = screen.getByRole("complementary", { name: /^inspector:/ });
    await userEvent.click(within(insp).getByRole("button", { name: "Close…" }));
    expect(Number((within(insp).getByLabelText("exit, per contract") as HTMLInputElement).value)).toBe(1.225);
    await userEvent.click(within(insp).getByRole("button", { name: "Close holding" }));
    const result = await screen.findByRole("region", { name: "closed 1231_IC" });
    expect(writes(s)[1]).toEqual(["POST /positions/h-ic/close", { exit: 1.225, closed_on: "2026-11-12" }]);
    expect(document.querySelector('[data-ref="h-ic"]')).toBeNull();
    expect(within(result).getByText(/switched off — holding closed/)).toBeTruthy();

    const fix = within(result).getByRole("form", { name: "correct the close of 1231_IC" });
    await userEvent.fill(within(fix).getByLabelText("exit, per contract"), "1.1");
    await userEvent.click(within(fix).getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(writes(s)[2]).toEqual(["PATCH /positions/h-ic", { exit: 1.1 }]));
    // (5.2 − 1.1) × 2, as the service answered the correction
    await waitFor(() => expect(within(result).getByTestId("realized").textContent).toBe("8.2 pts"));
    await userEvent.click(within(result).getByRole("button", { name: "Done" }));

    insp = await inspect("h-puts");
    await userEvent.click(within(insp).getByRole("button", { name: "Delete…" }));
    const ask = within(insp).getByRole("group", { name: "delete 1218_P6400?" });
    expect(ask.textContent).toMatch(/daily samples are deleted with it/);
    await userEvent.click(within(ask).getByRole("button", { name: "Delete for good" }));
    await waitFor(() => expect(writes(s)[3]).toEqual(["DELETE /positions/h-puts", null]));
    await waitFor(() => expect(document.querySelector('[data-ref="h-puts"]')).toBeNull());
  });

  for (const width of [900, 1440]) {
    it(`fits every form beside the table at ${width}px, pushing nothing sideways`, async () => {
      await openDesk(width);
      const insp = await inspect("h-ic");
      for (const name of ["Edit", "Close…", "Delete…"]) {
        await userEvent.click(within(insp).getByRole("button", { name }));
        await settle();
        expect(overflowsSideways()).toBe(false);
        expect(pastTheEdge(insp)).toEqual([]);
      }
    });
  }

  for (const width of [900, 1440]) {
    it(`fits a quantity's correction and its preview in the inspector at ${width}px (#359)`, async () => {
      const s = await openDesk(width);
      const insp = await inspect("h-ic");
      await userEvent.click(within(insp).getByRole("button", { name: "Edit" }));
      const qty = within(insp).getByRole("group", { name: "quantity of each leg" });
      const boxes = within(qty).getAllByLabelText(/^quantity, /);
      expect(boxes).toHaveLength(4);
      // a box a digit can be read in, and a label beside it that says which leg
      for (const box of boxes) expect(box.getBoundingClientRect().width).toBeGreaterThanOrEqual(40);
      await userEvent.fill(within(qty).getByLabelText("quantity, short PUT 6300"), "2");
      const change = await within(qty).findByRole("group", { name: "what the correction changes" });
      await waitFor(() => expect(change.textContent).toMatch(/max loss/));
      await settle();
      expect(overflowsSideways()).toBe(false);
      expect(pastTheEdge(insp)).toEqual([]);
      await userEvent.click(within(insp).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(writes(s)).toHaveLength(1));
      expect((writes(s)[0]![1] as { legs: { qty?: number }[] }).legs.map((l) => l.qty ?? 1)).toEqual([1, 1, 2, 1]);
    });
  }

  it("draws the close's account above the table, in view and with the focus on it", async () => {
    await openDesk();
    const insp = await inspect("h-ic");
    await userEvent.click(within(insp).getByRole("button", { name: "Close…" }));
    await userEvent.click(within(insp).getByRole("button", { name: "Close holding" }));
    const result = await screen.findByRole("region", { name: "closed 1231_IC" });
    await settle();
    const r = result.getBoundingClientRect();
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.top).toBeLessThan(window.innerHeight);
    expect(result.contains(document.activeElement)).toBe(true);
    expect(overflowsSideways()).toBe(false);
  });
});
