/** Editing, closing, correcting and deleting a holding on the phone (#294), MEASURED under
 *  Playwright's iPhone profile: each done from the detail sheet against a service that remembers
 *  it; every form's boxes 16px so iOS does not zoom, every target 44pt, nothing past the screen's
 *  edge — in the sheet and in the close's account that replaces it. Runs in the suite's `iphone`
 *  instance only; the desk is `NextHolding.test.tsx`.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../next/Next";
import { holdingService, type HoldingService } from "../testing/holdingService";
import type { Monitor } from "../shared/api";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";
import { overflowsSideways, settle } from "./nextBook";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Noon in New York, in the session, whatever the clock says. */
const IN_SESSION = new Date("2026-11-12T17:00:00Z");

/** The rules as `/monitors` serves them, the condor's own value rule carrying its legs and its scope. */
const withValueRule = () => MONITORS.map((m) => {
  const q = QUOTES.find((e) => e.id === m.id);
  const linked = q && q.positions.length > 0 ? { ...m, positions: q.positions } : m;
  return m.id === "r-ic" ? { ...linked, legs: q!.legs, scope: "all" } : linked;
}) as Monitor[];

async function openPhone(monitors?: Monitor[]): Promise<HoldingService> {
  vi.setSystemTime(IN_SESSION);
  const s = holdingService({
    holdings: HOLDINGS.map((h) => h.id === "h-ic" ? { ...h, cost_to_close: 1.225 } : h), monitors,
  });
  window.fetch = s.fetch;
  render(<Next />);
  await settle();
  return s;
}

/** A dialog slides in, and a box measured mid-animation is not where it will be. */
async function animationsDone(): Promise<void> {
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  await new Promise((r) => setTimeout(r, 50));
}

async function sheetOf(id: string): Promise<HTMLElement> {
  const card = document.querySelector<HTMLElement>(`article[data-ref="${id}"]`)!;
  await userEvent.click(within(card).getAllByRole("button")[0]!);
  const sheet = await screen.findByRole("dialog");
  await animationsDone();
  return sheet;
}

const writes = (s: HoldingService) => s.writes().map((w) => [`${w.method} ${w.path}`, w.body]);

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

/** Every box under 16px text, which iOS zooms the page to on focus. */
const smallText = (root: Element) => [...root.querySelectorAll("input")]
  .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => el.getAttribute("aria-label"));

function pastTheEdge(root: Element): string[] {
  const edge = document.documentElement.clientWidth;
  return [...root.querySelectorAll<HTMLElement>("*")]
    .filter((el) => el.getClientRects().length > 0 && el.getBoundingClientRect().right > edge + 0.5)
    .map((el) => `${el.tagName.toLowerCase()}.${el.className} right=${Math.round(el.getBoundingClientRect().right)}`);
}

describe("changing a holding from the phone's sheet", () => {
  it("gives every form 44pt targets and 16px boxes, and pushes nothing past the edge", async () => {
    await openPhone();
    const sheet = await sheetOf("h-ic");
    for (const name of ["Edit", "Close…", "Delete…"]) {
      await userEvent.click(within(sheet).getByRole("button", { name }));
      await settle();
      const form = sheet.querySelector(".nx-hold")!;
      expect(tooSmall(form)).toEqual([]);
      expect(smallText(form)).toEqual([]);
      expect(pastTheEdge(sheet)).toEqual([]);
    }
    expect(overflowsSideways()).toBe(false);
  });

  it("corrects a leg's quantity with 44pt boxes, its preview inside the screen (#359)", async () => {
    const s = await openPhone();
    const sheet = await sheetOf("h-ic");
    await userEvent.click(within(sheet).getByRole("button", { name: "Edit" }));
    const qty = within(sheet).getByRole("group", { name: "quantity of each leg" });
    await userEvent.fill(within(qty).getByLabelText("quantity, short PUT 6300"), "2");
    const change = await within(qty).findByRole("group", { name: "what the correction changes" });
    await waitFor(() => expect(change.textContent).toMatch(/max loss/));
    await settle();
    const form = sheet.querySelector(".nx-hold")!;
    expect(tooSmall(form)).toEqual([]);
    expect(smallText(form)).toEqual([]);
    expect(pastTheEdge(sheet)).toEqual([]);
    expect(overflowsSideways()).toBe(false);
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes(s)).toHaveLength(1));
    expect((writes(s)[0]![1] as { legs: { qty?: number }[] }).legs.map((l) => l.qty ?? 1)).toEqual([1, 1, 2, 1]);
  });

  it("offers the rename of the rule that followed with 44pt targets, inside the screen (#359's review)", async () => {
    const s = await openPhone(withValueRule());
    const sheet = await sheetOf("h-ic");
    await userEvent.click(within(sheet).getByRole("button", { name: "Edit" }));
    await userEvent.fill(within(sheet).getByLabelText("quantity, short PUT 6300"), "2");
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes(s)).toHaveLength(1));
    const renames = await within(sheet).findByRole("group", { name: "rename the rules that followed" });
    await settle();
    expect(renames.textContent).toMatch(/Its alarms still call it 1231_IC/);
    expect(tooSmall(renames)).toEqual([]);
    expect(smallText(renames)).toEqual([]);
    expect(pastTheEdge(sheet)).toEqual([]);
    expect(overflowsSideways()).toBe(false);
    // its editor opens there, and is as usable as the sheet
    await userEvent.click(within(renames).getByRole("button", { name: /^edit / }));
    await settle();
    expect(tooSmall(renames)).toEqual([]);
    expect(smallText(renames)).toEqual([]);
    expect(pastTheEdge(sheet)).toEqual([]);
  });

  it("cancels the close form with Escape and keeps the sheet open, the focus back on Close…", async () => {
    const s = await openPhone();
    const sheet = await sheetOf("h-ic");
    const button = within(sheet).getByRole("button", { name: "Close…" });
    await userEvent.click(button);
    expect(document.activeElement).toBe(within(sheet).getByLabelText("exit, per contract"));
    await userEvent.keyboard("{Escape}");
    await animationsDone();
    expect(within(sheet).queryByRole("form", { name: "close 1231_IC" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "1231_IC" })).toBeTruthy();
    expect(document.activeElement).toBe(button);
    expect(writes(s)).toEqual([]);
  });

  it("edits a holding", async () => {
    const s = await openPhone();
    const sheet = await sheetOf("h-ic");
    await userEvent.click(within(sheet).getByRole("button", { name: "Edit" }));
    await userEvent.fill(within(sheet).getByLabelText("opened"), "2026-11-04");
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes(s)).toEqual([["PATCH /positions/h-ic", { opened_at: "2026-11-04" }]]));
  });

  it("closes one, says where its Monitors went in view, and corrects the close there", async () => {
    const s = await openPhone();
    const sheet = await sheetOf("h-ic");
    await userEvent.click(within(sheet).getByRole("button", { name: "Close…" }));
    expect(Number((within(sheet).getByLabelText("exit, per contract") as HTMLInputElement).value)).toBe(1.225);
    await userEvent.click(within(sheet).getByRole("button", { name: "Close holding" }));
    const result = await screen.findByRole("region", { name: "closed 1231_IC" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "1231_IC" })).toBeNull());
    await animationsDone();
    await waitFor(() => expect(result.contains(document.activeElement)).toBe(true));
    expect(writes(s)[0]).toEqual(["POST /positions/h-ic/close", { exit: 1.225, closed_on: "2026-11-12" }]);
    expect(document.querySelector('article[data-ref="h-ic"]')).toBeNull();
    expect(within(result).getByText(/switched off — holding closed/)).toBeTruthy();

    // in view, where it can be read, and as usable as the sheet was
    const r = result.getBoundingClientRect();
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.top).toBeLessThan(window.innerHeight);
    expect(tooSmall(result)).toEqual([]);
    expect(smallText(result)).toEqual([]);
    expect(pastTheEdge(result)).toEqual([]);
    expect(overflowsSideways()).toBe(false);

    const fix = within(result).getByRole("form", { name: "correct the close of 1231_IC" });
    await userEvent.fill(within(fix).getByLabelText("closed on"), "2026-11-11");
    await userEvent.click(within(fix).getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(writes(s)[1]).toEqual(["PATCH /positions/h-ic", { closed_on: "2026-11-11" }]));
    await waitFor(() => expect(within(result).getByText(/closed on 2026-11-11/)).toBeTruthy());
  });

  it("deletes one only after asking, saying the samples go with it", async () => {
    const s = await openPhone();
    const sheet = await sheetOf("h-puts");
    await userEvent.click(within(sheet).getByRole("button", { name: "Delete…" }));
    const ask = within(sheet).getByRole("group", { name: "delete 1218_P6400?" });
    expect(ask.textContent).toMatch(/daily samples are deleted with it/);
    expect(writes(s)).toEqual([]);
    await userEvent.click(within(ask).getByRole("button", { name: "Delete for good" }));
    await waitFor(() => expect(writes(s)).toEqual([["DELETE /positions/h-puts", null]]));
    await waitFor(() => expect(document.querySelector('article[data-ref="h-puts"]')).toBeNull());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "1218_P6400" })).toBeNull());
  });
});
