/** Back closes a sheet on `/opt/next` (ADR 0005, ADR 0023) — carried from `BackButton.test.tsx`
 *  (#337), which holds it against today's `App` and goes with it in #301.
 *
 *  The interesting case is not that it works: it is that closing a sheet some OTHER way has to take
 *  its history entry back too, or the next press of Back does nothing at all and looks like the page
 *  ignoring you. jsdom's `history.length` never shrinks, so the pushes and the backs are counted.
 *
 *  Every sheet the page opens over itself: the phone's detail and Add sheets, and the desk's
 *  Settings. (The desk's add panel and inspector are not sheets: they sit in the page, and Back is
 *  not theirs.) The journal's trade sheet in REVIEW is `NextJournal`'s.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Next } from "../next/Next";
import { servePage } from "../testing/pageService";

let pushed: ReturnType<typeof vi.spyOn>;
let back: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  pushed = vi.spyOn(window.history, "pushState");
  back = vi.spyOn(window.history, "back");
});
afterEach(() => {
  cleanup();
  pushed.mockRestore();
  back.mockRestore();
  vi.useRealTimers();
  document.cookie = "ui_arrangement=;path=/;max-age=0";
});

const tab = (name: string) =>
  within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name });

/** Each sheet: the arrangement it is on, how it is opened, and how it is found once open. */
const SHEETS = [
  {
    name: "the phone's detail sheet", arrangement: "phone",
    open: () => fireEvent.click(screen.getByRole("button", { name: "details of 1218_P7150" })),
    find: () => screen.queryByRole("dialog"),
  },
  {
    name: "the phone's Add sheet", arrangement: "phone",
    open: () => fireEvent.click(tab("Add")),
    find: () => screen.queryByRole("dialog", { name: "Add a spread or contract" }),
  },
  {
    name: "the desk's Settings", arrangement: "desk",
    open: () => fireEvent.click(screen.getByRole("button", { name: "settings" })),
    find: () => screen.queryByRole("dialog", { name: "Settings" }),
  },
] as const;

async function show(arrangement: "phone" | "desk") {
  servePage();
  // 10:00 New York on a Tuesday: LIVE, where the phone draws its cards
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T15:00:00Z") });
  if (arrangement === "desk") document.cookie = "ui_arrangement=desk;path=/";
  render(<Next />);
  await waitFor(() => expect(document.querySelector('[data-ref="w-dec18"]')).toBeTruthy());
}

describe.each(SHEETS.map((s) => [s.name, s] as const))("%s", (_, sheet) => {
  it("closes on Back, and the page stays", async () => {
    await show(sheet.arrangement);
    sheet.open();
    await waitFor(() => expect(sheet.find()).toBeTruthy());
    expect(pushed).toHaveBeenCalledTimes(1);

    act(() => { window.history.back(); });
    await waitFor(() => expect(sheet.find()).toBeNull());
    // still on the page, not gone from it
    expect(document.querySelector('[data-ref="w-dec18"]')).toBeTruthy();
  });

  it("takes its history entry back when it is closed another way", async () => {
    await show(sheet.arrangement);
    sheet.open();
    await waitFor(() => expect(sheet.find()).toBeTruthy());
    expect(pushed).toHaveBeenCalledTimes(1);

    // Escape, not Back — the case that strands an entry if closing ignores it
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(sheet.find()).toBeNull());
    await waitFor(() => expect(back).toHaveBeenCalledTimes(1));
  });

  it("gives back every entry it pushed, opened and closed again and again", async () => {
    await show(sheet.arrangement);
    for (let i = 0; i < 3; i += 1) {
      sheet.open();
      await waitFor(() => expect(sheet.find()).toBeTruthy());
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(sheet.find()).toBeNull());
    }
    // three opens and three closes must not grow the stack by three
    expect(pushed).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(back).toHaveBeenCalledTimes(3));
  });
});
