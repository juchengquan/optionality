/** Crossing 900px with a sheet open: the window dragged narrower, a phone turned (a Pro Max in
 *  landscape is 932px). The Add form is the page's, drawn in the phone's bottom sheet or the desk's
 *  side sheet, and moving from one to the other must not lose what was typed in it — it remounts,
 *  so its draft is kept by the page (`Next`), next to the prefill it was opened with.
 *
 *  And the Back entries: with the phone's detail sheet open under "Record as held"'s Add, the detail
 *  goes as the phone's book does, and the entry it gives up is BENEATH Add's. It is given up through
 *  the one list every sheet's entry is kept in (`useDismissOnBack`): taken back once the entries
 *  above it are gone, never by a back() that pops Add's entry from under it — which closed the Add
 *  sheet the switch was meant to keep, and left the detail's entry behind it on the stack. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { holdingService } from "../testing/holdingService";
import { serveRuleEdits } from "../testing/ruleEdits";

let width = 400;
let back: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  width = 400;
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, get: () => width });
  back = vi.spyOn(window.history, "back");
});
afterEach(() => {
  cleanup();
  back.mockRestore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document.documentElement as { clientWidth?: number }).clientWidth;
  document.cookie = "ui_arrangement=;path=/;max-age=0";
});

const widen = (to: number) => act(() => { width = to; window.dispatchEvent(new Event("resize")); });
const addSheet = () => screen.findByRole("dialog", { name: "Add" });
const value = (root: HTMLElement, label: string) => (within(root).getByLabelText(label) as HTMLInputElement).value;
const drain = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });

describe("the Add form across a switch of arrangement", () => {
  it.each([[400, 1000], [1000, 400]])("keeps a spread's draft from %ipx to %ipx", async (from, to) => {
    width = from;
    vi.stubGlobal("fetch", holdingService().fetch);
    render(<Next />);
    await waitFor(() => expect(document.querySelector('[data-ref="h-ic"]')).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "add" }));
    const form = within(await addSheet()).getByRole("form", { name: "add a spread" });
    fireEvent.change(within(form).getByLabelText("expiry"), { target: { value: "2026-12-18" } });
    fireEvent.change(within(form).getByLabelText("spread 1, leg 1 strike"), { target: { value: "7150" } });
    const arrangement = document.querySelector<HTMLElement>(".nx")!.dataset.arrangement;

    widen(to);
    expect(document.querySelector<HTMLElement>(".nx")!.dataset.arrangement).not.toBe(arrangement);
    const after = within(await addSheet()).getByRole("form", { name: "add a spread" });
    expect(value(after, "expiry")).toBe("2026-12-18");
    expect(value(after, "spread 1, leg 1 strike")).toBe("7150");

    // and back again, still there
    widen(from);
    const again = within(await addSheet()).getByRole("form", { name: "add a spread" });
    expect(value(again, "spread 1, leg 1 strike")).toBe("7150");
  });

  it("keeps the choice of one contract, and its draft", async () => {
    vi.stubGlobal("fetch", holdingService().fetch);
    render(<Next />);
    await waitFor(() => expect(document.querySelector('[data-ref="h-ic"]')).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "add" }));
    const sheet = await addSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: "one contract" }));
    const strike = within(sheet).getByLabelText("strike");
    fireEvent.change(strike, { target: { value: "7150" } });

    widen(1000);
    const after = await addSheet();
    expect(within(after).getByRole("button", { name: "one contract" }).getAttribute("aria-pressed")).toBe("true");
    expect((within(after).getByLabelText("strike") as HTMLInputElement).value).toBe("7150");
  });

  it("starts afresh when it is opened again after a close", async () => {
    vi.stubGlobal("fetch", holdingService().fetch);
    render(<Next />);
    await waitFor(() => expect(document.querySelector('[data-ref="h-ic"]')).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "add" }));
    const form = within(await addSheet()).getByRole("form", { name: "add a spread" });
    fireEvent.change(within(form).getByLabelText("spread 1, leg 1 strike"), { target: { value: "7150" } });
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "add" }));
    const fresh = within(await addSheet()).getByRole("form", { name: "add a spread" });
    expect(value(fresh, "spread 1, leg 1 strike")).toBe("");
  });
});

describe("a save out across a switch of arrangement", () => {
  it("keeps the new form's Save shut until it answers: the same spread is never sent twice", async () => {
    const s = holdingService();
    const posts: unknown[] = [];
    let answer!: (r: Response) => void;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST" && String(url).endsWith("/api/spreads")) {
        posts.push(init?.body);
        return new Promise<Response>((r) => { answer = r; });
      }
      return s.fetch(url, init);
    });
    render(<Next />);
    await waitFor(() => expect(document.querySelector('[data-ref="h-ic"]')).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "add" }));
    const form = within(await addSheet()).getByRole("form", { name: "add a spread" });
    const type = (l: string, v: string) => fireEvent.change(within(form).getByLabelText(l), { target: { value: v } });
    type("expiry", "2026-12-18"); type("spread 1, leg 1 strike", "7150"); type("spread 1, leg 2 strike", "7100");
    type("spread 1 entry", "1.50");
    fireEvent.click(within(form).getByRole("button", { name: /^Record/ }));
    await waitFor(() => expect(posts).toHaveLength(1));

    widen(1000);
    const after = within(await addSheet()).getByRole("form", { name: "add a spread" });
    const save = within(after).getByRole("button", { name: "saving…" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    fireEvent.submit(after);
    await drain();
    expect(posts).toHaveLength(1);

    // the save the old form sent answers, refused: the new form's Save is open again
    await act(async () => {
      answer({ ok: false, status: 409, json: () => Promise.resolve({ detail: "refused" }) } as Response);
    });
    await drain();
    expect((within(after).getByRole("button", { name: /^Record/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Record as held over the phone's detail, across a switch to the desk", () => {
  async function recordAsHeld() {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T15:00:00Z") });
    serveRuleEdits();
    render(<Next />);
    fireEvent.click(await screen.findByRole("button", { name: "details of 1218_P7150" }));
    const detail = await screen.findByRole("dialog");
    fireEvent.click(within(detail).getByRole("button", { name: "record 1218_P7150 value as held" }));
    const form = within(await addSheet()).getByRole("form", { name: "add a spread" });
    fireEvent.change(within(form).getByLabelText("spread 1 entry"), { target: { value: "2.40" } });
    widen(1000);
    await drain();
  }

  it("keeps the Add sheet open, prefilled and typed into, and takes no entry from under it", async () => {
    await recordAsHeld();
    const form = within(await addSheet()).getByRole("form", { name: "add a spread" });
    expect(value(form, "spread 1 entry")).toBe("2.40");
    expect(value(form, "spread 1 name")).toBe("1218_P7150");
    expect(back).not.toHaveBeenCalled();
  });

  it("gives the detail's entry back with Add's when Add is cancelled", async () => {
    await recordAsHeld();
    fireEvent.click(within(await addSheet()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add" })).toBeNull());
    // Add's own, then the detail's, which was beneath it
    await waitFor(() => expect(back).toHaveBeenCalledTimes(2));
    await drain();
    expect(back).toHaveBeenCalledTimes(2);
  });

  it("gives both entries back after a round trip to the desk and back, then a Cancel", async () => {
    await recordAsHeld();
    widen(400);
    await drain();
    const sheet = await addSheet();
    expect(value(within(sheet).getByRole("form", { name: "add a spread" }), "spread 1 entry")).toBe("2.40");
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add" })).toBeNull());
    await waitFor(() => expect(back).toHaveBeenCalledTimes(2));
    await drain();
    expect(back).toHaveBeenCalledTimes(2);
  });

  it("gives both entries back when the Add over the orphan saves", async () => {
    await recordAsHeld();
    const sheet = await addSheet();
    fireEvent.click(within(sheet).getAllByRole("button").find((b) => /^Record/.test(b.textContent ?? ""))!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add" })).toBeNull(), { timeout: 3000 });
    await waitFor(() => expect(back).toHaveBeenCalledTimes(2));
    await drain();
    expect(back).toHaveBeenCalledTimes(2);
  });

  it("gives the detail's entry back after a Back closes Add, and nothing more", async () => {
    await recordAsHeld();
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add" })).toBeNull());
    // the press, then the detail's entry taken back by the page
    await waitFor(() => expect(back).toHaveBeenCalledTimes(2));
    await drain();
    expect(back).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-ref="w-dec18"]')).toBeTruthy();
  });
});
