/** Editing, closing, correcting and deleting a holding from `/opt/next` (#294), on the desk's
 *  inspector and the phone's sheet, against a service that remembers what it was sent
 *  (`testing/holdingService.ts`). Behaviour only; what the phone must MEASURE — 44pt targets, 16px
 *  boxes, nothing past the edge — is `__browser__/NextHolding.iphone.test.tsx`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Holding, Monitor } from "../api";
import { Next } from "../next/Next";
import { holdingService, type HoldingService } from "../testing/holdingService";
import { HOLDINGS, MONITORS } from "../testing/ownerBook";

const COOKIES = ["ui_arrangement", "ui_privacy", "ui_cols_combo"];
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const n of COOKIES) document.cookie = `${n}=;path=/;max-age=0`;
});

/** Noon in New York on 12 November, in the session, so the page opens in LIVE: 01:00 on the 13th
 *  in Singapore, where the owner reads it. */
const IN_SESSION = new Date("2026-11-12T17:00:00Z");

async function open(arrangement: "desk" | "phone", service: HoldingService, privacy = false) {
  vi.useFakeTimers({ toFake: ["Date"], now: IN_SESSION });
  document.cookie = `ui_arrangement=${arrangement};path=/`;
  if (privacy) document.cookie = "ui_privacy=on;path=/";
  vi.stubGlobal("fetch", service.fetch);
  render(<Next />);
  await waitFor(() => expect(document.querySelector('[data-ref="h-ic"]')).not.toBeNull());
}

/** The holding's detail: the desk's inspector, or the phone's sheet. */
async function detail(arrangement: "desk" | "phone", id: string): Promise<HTMLElement> {
  if (arrangement === "desk") {
    const row = document.querySelector<HTMLElement>(`.nxd-row[data-ref="${id}"]`)!;
    fireEvent.click(row.querySelector(".nxd-name")!);
    return screen.getByRole("complementary", { name: /^inspector:/ });
  }
  const card = document.querySelector<HTMLElement>(`article[data-ref="${id}"]`)!;
  fireEvent.click(within(card).getAllByRole("button")[0]!);
  return screen.findByRole("dialog");
}

const typeIn = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const writes = (s: HoldingService) => s.writes().map((w) => `${w.method} ${w.path}`);

/** A 4-leg condor whose Cost to close is a half-cent mid, and a long put bought for a debit whose
 *  Cost to close is NEGATIVE — selling it pays you. */
const LONG_PUT = {
  ...HOLDINGS[0]!, id: "h-long", name: "1218_LP6800", entry: -5, cost_to_close: -7.25,
  legs: [{ side: "long", option_type: "PUT", strike: 6800 }],
} as Holding;
const book = () => [...HOLDINGS.map((h) => h.id === "h-ic" ? { ...h, cost_to_close: 1.225 } : h), LONG_PUT];

for (const arrangement of ["desk", "phone"] as const) {
  describe(`on the ${arrangement}`, () => {
    it("edits Entry, contracts and Opened, sending only what changed", async () => {
      const s = holdingService({ holdings: book() });
      await open(arrangement, s);
      const d = await detail(arrangement, "h-ic");
      fireEvent.click(within(d).getByRole("button", { name: "Edit" }));
      const form = within(d).getByRole("form", { name: "edit 1231_IC" });
      expect((within(form).getByLabelText("entry, per contract") as HTMLInputElement).value).toBe("5");
      typeIn(within(form).getByLabelText("entry, per contract"), "5.4");
      typeIn(within(form).getByLabelText("opened"), "2026-11-04");
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(writes(s)).toEqual(["PATCH /positions/h-ic"]));
      expect(s.writes()[0]!.body).toEqual({ entry: 5.4, opened_at: "2026-11-04" });
      await waitFor(() => expect(s.stored.get("h-ic")!.entry).toBe(5.4));
      // said where it was saved, not in a toast that lands over the inspector's buttons
      expect(within(d).getByRole("status").textContent).toBe("saved 1231_IC");
    });

    it("says the name and the legs are not edited, and why, rather than offering boxes that do nothing", async () => {
      const s = holdingService({ holdings: book() });
      await open(arrangement, s);
      const d = await detail(arrangement, "h-ic");
      fireEvent.click(within(d).getByRole("button", { name: "Edit" }));
      const form = within(d).getByRole("form", { name: "edit 1231_IC" });
      expect(within(form).queryByLabelText(/strike|name/)).toBeNull();
      expect(form.textContent).toMatch(/the service does not edit them: a different structure is a different holding/);
      expect(form.textContent).toMatch(/its 1 Monitor is kept/);
    });

    it("prefills the Exit with the served Cost to close and the day with New York's, and posts it", async () => {
      const s = holdingService({ holdings: book() });
      await open(arrangement, s);
      const d = await detail(arrangement, "h-ic");
      fireEvent.click(within(d).getByRole("button", { name: "Close…" }));
      const form = within(d).getByRole("form", { name: "close 1231_IC" });
      const exit = within(form).getByLabelText("exit, per contract") as HTMLInputElement;
      expect(Number(exit.value)).toBe(1.225);
      expect((within(form).getByLabelText("closed on") as HTMLInputElement).value).toBe("2026-11-12");
      fireEvent.click(within(form).getByRole("button", { name: "Close holding" }));
      await waitFor(() => expect(writes(s)).toEqual(["POST /positions/h-ic/close"]));
      expect(s.writes()[0]!.body).toEqual({ exit: 1.225, closed_on: "2026-11-12" });
      expect(s.stored.get("h-ic")!.exit).toBe(1.225);
    });

    it("keeps a long's negative Cost to close negative, and stores an edited Exit as typed", async () => {
      const s = holdingService({ holdings: book() });
      await open(arrangement, s);
      const d = await detail(arrangement, "h-long");
      fireEvent.click(within(d).getByRole("button", { name: "Close…" }));
      const form = within(d).getByRole("form", { name: "close 1218_LP6800" });
      const exit = within(form).getByLabelText("exit, per contract") as HTMLInputElement;
      expect(Number(exit.value)).toBe(-7.25);
      typeIn(exit, "-7.4");
      fireEvent.click(within(form).getByRole("button", { name: "Close holding" }));
      await waitFor(() => expect(s.stored.get("h-long")!.closed_on).toBe("2026-11-12"));
      expect(s.writes()[0]!.body).toEqual({ exit: -7.4, closed_on: "2026-11-12" });
      expect(s.stored.get("h-long")!.exit).toBe(-7.4);
    });

    it("takes a closed holding off the live view at once, and says what it made and where its Monitors went", async () => {
      const extra = {
        ...MONITORS.find((m) => m.id === "r-ic")!, id: "r-ic-put", code: "US.SPXW261231P6300000",
        positions: [{ id: "h-ic", name: "1231_IC" }],
      } as Monitor;
      const s = holdingService({
        holdings: book(), handTo: { "r-ic-put": { id: "h-roll", name: "1231_P6300_roll" } },
        monitors: [...MONITORS.map((m) => m.id === "r-ic" ? { ...m, positions: [{ id: "h-ic", name: "1231_IC" }] } : m), extra],
      });
      await open(arrangement, s);
      // a poll asked before the close and answered after it still lists the holding
      s.stale.values = true;
      const d = await detail(arrangement, "h-ic");
      fireEvent.click(within(d).getByRole("button", { name: "Close…" }));
      const form = within(d).getByRole("form", { name: "close 1231_IC" });
      typeIn(within(form).getByLabelText("exit, per contract"), "1.5");
      fireEvent.click(within(form).getByRole("button", { name: "Close holding" }));

      const result = await screen.findByRole("region", { name: "closed 1231_IC" });
      expect(document.querySelector('[data-ref="h-ic"]')).toBeNull();
      // (5 − 1.5) × 2 contracts, as the service answered it
      expect(within(result).getByTestId("realized").textContent).toBe("7.00 pts");
      const fates = within(result).getAllByRole("listitem").map((li) => li.textContent);
      expect(fates).toEqual([
        expect.stringMatching(/switched off — holding closed$/),
        expect.stringMatching(/handed to 1231_P6300_roll$/),
      ]);
      // read back from the service after the close, not inferred
      const after = s.sent.findIndex((x) => x.method === "POST");
      expect(s.sent.slice(after).some((x) => x.method === "GET" && x.path === "/monitors")).toBe(true);
      // and it stays off the live view when the next poll still lists it
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(document.querySelector('[data-ref="h-ic"]')).toBeNull();
    });

    it("corrects a mistyped close from the result, by PATCH, and says what it now made", async () => {
      const s = holdingService({ holdings: book() });
      await open(arrangement, s);
      const d = await detail(arrangement, "h-ic");
      fireEvent.click(within(d).getByRole("button", { name: "Close…" }));
      fireEvent.click(within(within(d).getByRole("form", { name: "close 1231_IC" })).getByRole("button", { name: "Close holding" }));
      const result = await screen.findByRole("region", { name: "closed 1231_IC" });
      const fix = within(result).getByRole("form", { name: "correct the close of 1231_IC" });
      expect((within(fix).getByLabelText("exit, per contract") as HTMLInputElement).value).toBe("1.225");
      typeIn(within(fix).getByLabelText("exit, per contract"), "1.1");
      typeIn(within(fix).getByLabelText("closed on"), "2026-11-11");
      fireEvent.click(within(fix).getByRole("button", { name: "Save correction" }));
      await waitFor(() => expect(within(result).getByTestId("realized").textContent).toBe("7.80 pts"));
      expect(s.writes().at(-1)).toEqual({ method: "PATCH", path: "/positions/h-ic", body: { exit: 1.1, closed_on: "2026-11-11" } });
      expect(within(result).getByText(/closed on 2026-11-11/)).toBeTruthy();
    });

    it("asks before deleting, says the samples go with it, and offers closing instead", async () => {
      const s = holdingService({ holdings: book() });
      await open(arrangement, s);
      const d = await detail(arrangement, "h-ic");
      fireEvent.click(within(d).getByRole("button", { name: "Delete…" }));
      const ask = within(d).getByRole("group", { name: "delete 1231_IC?" });
      expect(ask.textContent).toMatch(/daily samples are deleted with it/);
      expect(ask.textContent).toMatch(/cannot be re-entered/);
      expect(ask.textContent).toMatch(/If this was a real trade, close it instead/);
      expect(writes(s)).toEqual([]);
      fireEvent.click(within(ask).getByRole("button", { name: "Keep it" }));
      expect(within(d).queryByRole("group", { name: "delete 1231_IC?" })).toBeNull();
      expect(writes(s)).toEqual([]);

      fireEvent.click(within(d).getByRole("button", { name: "Delete…" }));
      fireEvent.click(within(within(d).getByRole("group", { name: "delete 1231_IC?" })).getByRole("button", { name: "Delete for good" }));
      await waitFor(() => expect(writes(s)).toEqual(["DELETE /positions/h-ic"]));
      await waitFor(() => expect(document.querySelector('[data-ref="h-ic"]')).toBeNull());
    });

    it("offers the close from the delete question", async () => {
      const s = holdingService({ holdings: book() });
      await open(arrangement, s);
      const d = await detail(arrangement, "h-ic");
      fireEvent.click(within(d).getByRole("button", { name: "Delete…" }));
      fireEvent.click(within(within(d).getByRole("group", { name: "delete 1231_IC?" })).getByRole("button", { name: "Close it instead" }));
      expect(within(d).getByRole("form", { name: "close 1231_IC" })).toBeTruthy();
    });

    it("says a refusal in the form, and keeps what was typed", async () => {
      const s = holdingService({ holdings: book() });
      s.refuse.set("POST /positions/h-ic/close", { status: 422, detail: "closed on 2026-11-02, before it was opened on 2026-11-03" });
      await open(arrangement, s);
      const d = await detail(arrangement, "h-ic");
      fireEvent.click(within(d).getByRole("button", { name: "Close…" }));
      const form = within(d).getByRole("form", { name: "close 1231_IC" });
      typeIn(within(form).getByLabelText("closed on"), "2026-11-02");
      fireEvent.click(within(form).getByRole("button", { name: "Close holding" }));
      expect((await within(form).findByRole("alert")).textContent).toBe("closed on 2026-11-02, before it was opened on 2026-11-03");
      expect((within(form).getByLabelText("closed on") as HTMLInputElement).value).toBe("2026-11-02");
      expect(document.querySelector('[data-ref="h-ic"]')).not.toBeNull();
    });

    it("hides the contract count under privacy, and what the close made across the contracts", async () => {
      const s = holdingService({ holdings: book() });
      await open(arrangement, s, true);
      const d = await detail(arrangement, "h-ic");
      fireEvent.click(within(d).getByRole("button", { name: "Edit" }));
      expect(within(d).getByLabelText("contracts").classList.contains("nx-private")).toBe(true);
      fireEvent.click(within(d).getByRole("button", { name: "Close…" }));
      fireEvent.click(within(within(d).getByRole("form", { name: "close 1231_IC" })).getByRole("button", { name: "Close holding" }));
      const result = await screen.findByRole("region", { name: "closed 1231_IC" });
      expect(within(result).getByTestId("realized").textContent).toBe("••• pts");
      expect(result.textContent).not.toMatch(/×2/);
    });
  });
}

describe("on the desk's inspector", () => {
  it("cancels a form with Escape and keeps the inspector open, the focus back on its button", async () => {
    const s = holdingService({ holdings: book() });
    await open("desk", s);
    const d = await detail("desk", "h-ic");
    const edit = within(d).getByRole("button", { name: "Edit" });
    fireEvent.click(edit);
    const entry = within(d).getByLabelText("entry, per contract");
    expect(document.activeElement).toBe(entry);
    fireEvent.keyDown(entry, { key: "Escape" });
    expect(within(d).queryByRole("form", { name: "edit 1231_IC" })).toBeNull();
    expect(screen.getByRole("complementary", { name: /^inspector:/ })).toBeTruthy();
    expect(document.activeElement).toBe(edit);
  });

  it("puts the focus on the result after a close", async () => {
    const s = holdingService({ holdings: book() });
    await open("desk", s);
    const d = await detail("desk", "h-ic");
    fireEvent.click(within(d).getByRole("button", { name: "Close…" }));
    fireEvent.click(within(within(d).getByRole("form", { name: "close 1231_IC" })).getByRole("button", { name: "Close holding" }));
    const result = await screen.findByRole("region", { name: "closed 1231_IC" });
    await waitFor(() => expect(document.activeElement).toBe(within(result).getByRole("heading", { name: "Closed 1231_IC" })));
    fireEvent.click(within(result).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("region", { name: "closed 1231_IC" })).toBeNull();
  });
});
