/** "Save the view as an image" and "Copy the view as text" from the desk's palette (#299 with #300
 *  and #394): the same presses as the header's buttons, and a picture with neither the palette nor
 *  the table's selection in it. The presses themselves are `NextSaveImage.test.tsx`'s; this holds
 *  only that the palette reaches them. */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const toBlob = vi.fn();
vi.mock("html-to-image", () => ({ toBlob: (...a: unknown[]) => toBlob(...a) }));

const delivered: string[] = [];
vi.mock("../shared/snapshot", async (orig) => ({
  ...(await orig<typeof import("../shared/snapshot")>()),
  deliver: (_blob: Blob, name: string) => { delivered.push(name); return Promise.resolve("downloaded"); },
}));

const { Next } = await import("../Next");
const { holdingService } = await import("../testing/holdingService");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  toBlob.mockReset();
  delivered.length = 0;
  document.cookie = "ui_arrangement=;path=/;max-age=0";
});

async function open() {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T17:00:00Z") });
  document.cookie = "ui_arrangement=desk;path=/";
  vi.stubGlobal("fetch", holdingService().fetch);
  const user = userEvent.setup();
  render(<Next />);
  await waitFor(() => expect(document.querySelector('[data-ref="h-ic"]')).not.toBeNull());
  return user;
}

describe("saving the view from the palette", () => {
  it("takes the same picture the header's button does, with no palette and no selection in it", async () => {
    let shot: HTMLElement | null = null;
    toBlob.mockImplementation((node: HTMLElement) => {
      shot = node;
      // what the picture holds, read while it is on the page
      expect(node.querySelector('[role="dialog"], [data-cursor], [data-selected], [role="combobox"]')).toBeNull();
      expect(node.textContent).toMatch(/1231_IC/);
      return Promise.resolve(new Blob(["png"]));
    });
    const user = await open();
    // a row selected and the inspector open, as the owner would have it when pressing
    await user.keyboard("jj{Enter}");
    await waitFor(() => expect(screen.queryByRole("complementary", { name: /^inspector:/ })).not.toBeNull());
    await user.keyboard("{Control>}k{/Control}");
    const palette = screen.getByRole("dialog", { name: "commands" });
    await user.type(within(palette).getByRole("combobox"), "save the view");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(delivered).toHaveLength(1));
    expect(toBlob).toHaveBeenCalledTimes(1);
    expect(shot!.classList.contains("nx-still")).toBe(true);
    // and the header's button reaches the very same press
    await user.click(screen.getByRole("button", { name: "save as image" }));
    await waitFor(() => expect(delivered).toHaveLength(2));
  });

  it("copies the view as text, as the header's button does (#394)", async () => {
    const written: string[] = [];
    /** whether the palette was still up when each text was written: Safari grants the clipboard only
     *  inside the gesture, so the write must happen in the pick, before the close runs its course */
    const paletteUp: boolean[] = [];
    const user = await open();
    // after user-event's setup, which puts a clipboard of its own on the navigator
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: (t: string) => {
        written.push(t);
        // Base UI marks the popup `data-open` until the close begins
        paletteUp.push(document.querySelector(".nx-palette[data-open]") !== null);
        return Promise.resolve();
      } }, configurable: true,
    });
    try {
      await user.keyboard("{Control>}k{/Control}");
      const palette = screen.getByRole("dialog", { name: "commands" });
      await user.type(within(palette).getByRole("combobox"), "copy the view");
      await user.keyboard("{Enter}");
      await waitFor(() => expect(written).toHaveLength(1));
      expect(paletteUp, "the text was written after the palette closed: outside the gesture").toEqual([true]);
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "commands" })).toBeNull());
      expect(written[0]).toContain("1231_IC");
      // and the header's button reaches the very same press
      await user.click(screen.getByRole("button", { name: "copy as text" }));
      await waitFor(() => expect(written).toHaveLength(2));
      expect(written[1]).toBe(written[0]);
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});
