/** The desk's ⌘K palette and its keys (#299), in a real browser with real keystrokes: every action
 *  the palette lists is reached from it by the keyboard alone, a found row is brought into view and
 *  opened, the focus stays inside the dialog and comes back on Escape, and j/k walk the table. The
 *  behaviour in detail is the jsdom suite's (`__tests__/NextPalette.test.tsx`, `NextDeskKeys`).
 *
 *  The service is `testing/holdingService.ts`, which answers every route the page calls; nothing
 *  here saves, so a write would be a 404 that names itself.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../next/Next";
import { holdingService, type HoldingService } from "../testing/holdingService";
import { settle } from "./nextBook";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const n of ["ui_arrangement", "ui_privacy", "ui_pricemap"]) document.cookie = `${n}=;path=/;max-age=0`;
});

/** Noon in New York, in the session, so the page opens in LIVE whatever the machine's clock says. */
const IN_SESSION = new Date("2026-11-12T17:00:00Z");

/** The page on a Mac unless told otherwise: the platform is STUBBED, so the suite exercises the
 *  page's own detection both ways rather than asking it which chord to press. */
async function openDesk(height = 900, platform = "MacIntel"): Promise<HoldingService> {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  vi.useFakeTimers({ toFake: ["Date"], now: IN_SESSION });
  await page.viewport(1440, height);
  const s = holdingService();
  window.fetch = s.fetch;
  render(<Next />);
  await settle();
  return s;
}

/** ⌘K, as the stubbed Mac answers to. */
const chord = () => userEvent.keyboard("{Meta>}k{/Meta}");
const palette = () => screen.getByRole("dialog", { name: "commands" });
const gone = () => waitFor(() => expect(screen.queryByRole("dialog", { name: "commands" })).toBeNull());
const inspector = () => screen.queryByRole("complementary", { name: /^inspector:/ });
const row = (id: string) => document.querySelector<HTMLElement>(`.nxd-row[data-ref="${id}"]`)!;

/** Opens the palette, types `q`, and chooses with Enter — all from the keyboard. */
async function run(q: string) {
  await chord();
  await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("combobox"));
  await userEvent.keyboard(q);
  await userEvent.keyboard("{Enter}");
  await gone();
}

/** Whether `el` is inside the viewport. */
function onScreen(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight + 0.5 && r.left >= 0 && r.right <= window.innerWidth + 0.5;
}

describe("every action, from the keyboard", () => {
  it("adds a spread", async () => {
    await openDesk();
    await run("add a spread");
    const panel = await screen.findByRole("region", { name: "adding a spread" });
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
  });

  it("edits the selected Monitor, found first by its strike", async () => {
    await openDesk();
    await run("7150 delta");
    await waitFor(() => expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 261218 7150P"));
    await run("edit the selected");
    const form = await screen.findByRole("form", { name: "editing 261218 7150P delta" });
    await waitFor(() => expect(document.activeElement).toBe(within(form).getByLabelText("threshold")));
  });

  it("closes the selected holding, found first by its name", async () => {
    await openDesk();
    await run("1218_C7300 holding");
    await waitFor(() => expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 1218_C7300"));
    await run("close the selected");
    const form = await screen.findByRole("form", { name: "close 1218_C7300" });
    await waitFor(() => expect(form.contains(document.activeElement)).toBe(true));
  });

  it("switches the mode", async () => {
    await openDesk();
    const nx = document.querySelector<HTMLElement>(".nx")!;
    await run("switch to review");
    await waitFor(() => expect(nx.dataset.mode).toBe("review"));
    await run("switch to live");
    await waitFor(() => expect(nx.dataset.mode).toBe("live"));
  });

  it("forces the phone, which has no palette", async () => {
    await openDesk();
    await run("arrangement: phone");
    await waitFor(() => expect(document.querySelector(".nx")!.getAttribute("data-arrangement")).toBe("phone"));
    // the phone has no palette: the chord is the browser's again
    await chord();
    expect(screen.queryByRole("dialog", { name: "commands" })).toBeNull();
  });

  it("forces the desk, and hands it back to the screen's width", async () => {
    await openDesk();
    await run("arrangement: desk");
    expect(document.cookie).toMatch(/ui_arrangement=desk/);
    await run("arrangement: by the screen");
    expect(document.cookie).toMatch(/ui_arrangement=auto/);
    // 1440px wide: by the width, still the desk
    expect(document.querySelector(".nx")!.getAttribute("data-arrangement")).toBe("desk");
  });
});

describe("a dialog that behaves like one", () => {
  it("keeps Tab inside, and gives the focus back where it was on Escape", async () => {
    await openDesk();
    const name = within(row("w-dec31")).getByRole("button", { name: "1231_C7600" });
    name.focus();
    await chord();
    await userEvent.keyboard("{Tab}{Tab}{Shift>}{Tab}{/Shift}");
    expect(palette().contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    await gone();
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(inspector()).toBeNull();
  });

  it("sits on the screen, over the page", async () => {
    await openDesk();
    await chord();
    const box = palette();
    expect(onScreen(box)).toBe(true);
    const r = box.getBoundingClientRect();
    expect(box.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 20))).toBe(true);
  });

  it("brings a found row into view and opens it", async () => {
    await openDesk(420);
    expect(onScreen(row("q-unknown"))).toBe(false);
    await run("8300");
    await waitFor(() => expect(row("q-unknown").hasAttribute("data-selected")).toBe(true));
    await waitFor(() => expect(onScreen(row("q-unknown"))).toBe(true));
    expect(inspector()!.contains(document.activeElement)).toBe(true);
  });
});

describe("j and k", () => {
  it("walk the table, Enter opens the inspector and Escape closes it", async () => {
    await openDesk();
    await userEvent.keyboard("jjj");
    expect(document.querySelector<HTMLElement>(".nxd-row[data-cursor]")!.dataset.ref).toBe("h-puts");
    expect(inspector()).toBeNull();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 1218_P6400"));
    await userEvent.keyboard("j");
    await waitFor(() => expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 1231_IC"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(inspector()).toBeNull());
    expect(document.activeElement).toBe(within(row("h-ic")).getByRole("button", { name: "1231_IC" }));
  });

  it("type into a box rather than move the table (the box is in a form, which holds them too)", async () => {
    await openDesk();
    await userEvent.keyboard("j");
    await userEvent.click(row("h-calls").querySelector<HTMLElement>(".nxd-name")!);
    await userEvent.click(within(inspector()!).getByRole("button", { name: "Close…" }));
    const form = screen.getByRole("form", { name: "close 1218_C7300" });
    const exit = within(form).getAllByRole("textbox")[0]!;
    await userEvent.click(exit);
    await userEvent.keyboard("jk");
    expect((exit as HTMLInputElement).value).toMatch(/jk$/);
    expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 1218_C7300");
  });
});

describe("the chord the platform answers to", () => {
  it("is ⌘K on a Mac, where Ctrl+K stays the text field's", async () => {
    await openDesk(900, "MacIntel");
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(screen.queryByRole("dialog", { name: "commands" })).toBeNull();
    await userEvent.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByRole("dialog", { name: "commands" })).toBeTruthy();
  });

  it("is Ctrl+K off a Mac, and ⌘K does nothing there", async () => {
    await openDesk(900, "Linux x86_64");
    expect(screen.getByRole("button", { name: /^find and act/ }).getAttribute("aria-keyshortcuts")).toBe("Control+K");
    await userEvent.keyboard("{Meta>}k{/Meta}");
    expect(screen.queryByRole("dialog", { name: "commands" })).toBeNull();
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("dialog", { name: "commands" })).toBeTruthy();
  });
});

