/** Editing, closing, correcting and deleting a holding from `/opt/next` (#294), on the desk's
 *  inspector and the phone's sheet, against a service that remembers what it was sent
 *  (`testing/holdingService.ts`). Behaviour only; what the phone must MEASURE — 44pt targets, 16px
 *  boxes, nothing past the edge — is `__browser__/NextHolding.iphone.test.tsx`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Holding, Monitor } from "../shared/api";
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

async function open(arrangement: "desk" | "phone", service: HoldingService, privacy = false, at = IN_SESSION) {
  vi.useFakeTimers({ toFake: ["Date"], now: at });
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
const book = () => [
  ...HOLDINGS.map((h) => h.id === "h-ic" ? { ...h, cost_to_close: 1.225, fetched_at: "2026-11-12 23:14:05+08:00" } : h),
  LONG_PUT,
];

for (const arrangement of ["desk", "phone"] as const) {
  describe(`on the ${arrangement}`, () => {
    it("edits Entry, contracts and Opened, sending only what changed", async () => {
      const s = holdingService({ holdings: book() });
      await open(arrangement, s);
      const d = await detail(arrangement, "h-ic");
      // mounted empty, so a screen reader announces it when it fills
      expect(within(d).getByRole("status").textContent).toBe("");
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
      expect(form.textContent).toMatch(/the service does not edit them/);
      // a wrong name is not worth the samples; delete-and-add-again is for wrong LEGS, and says the cost
      expect(form.textContent).toMatch(/A wrong name cannot be changed, and the daily samples are worth more than the name/);
      expect(form.textContent).toMatch(/A wrong strike or side is a different holding: delete it and add it again — which deletes its daily samples for good/);
      expect(form.textContent).toMatch(/its 1 Monitor is kept/);
      expect(form.textContent).not.toMatch(/Recorded wrongly\? Delete it/);
    });

    it("corrects a leg's quantity, previewing what changes and saying what becomes of the samples (#359)", async () => {
      const s = holdingService({ holdings: book() });
      await open(arrangement, s);
      const d = await detail(arrangement, "h-ic");
      fireEvent.click(within(d).getByRole("button", { name: "Edit" }));
      const form = within(d).getByRole("form", { name: "edit 1231_IC" });
      const qty = within(form).getByRole("group", { name: "quantity of each leg" });
      const putQty = within(qty).getByLabelText("quantity, short PUT 6300") as HTMLInputElement;
      expect(putQty.value).toBe("1");
      // nothing to preview until a quantity differs
      expect(within(qty).queryByRole("group", { name: "what the correction changes" })).toBeNull();
      typeIn(putQty, "2");
      const change = await within(qty).findByRole("group", { name: "what the correction changes" });
      // the service's payoff, per contract, before and after: nothing is worked out here
      await waitFor(() => expect(s.sent.filter((w) => w.path === "/positions/payoff")).toHaveLength(2));
      const asked = s.sent.filter((w) => w.path === "/positions/payoff").map((w) => w.body as { legs: { qty?: number }[] });
      expect(asked.map((b) => b.legs.map((l) => l.qty ?? 1))).toEqual([[1, 1, 1, 1], [1, 1, 2, 1]]);
      await waitFor(() => expect(change.textContent).toMatch(/max loss/));
      expect(qty.textContent).toMatch(/daily samples are kept as they are/);
      expect(qty.textContent).toMatch(/value rule takes the new quantities/);
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(writes(s)).toEqual(["PATCH /positions/h-ic"]));
      expect(s.writes()[0]!.body).toEqual({ legs: [
        { side: "short", option_type: "CALL", strike: 7400 }, { side: "long", option_type: "CALL", strike: 7450 },
        { side: "short", option_type: "PUT", strike: 6300, qty: 2 }, { side: "long", option_type: "PUT", strike: 6250 },
      ] });
    });

    it("refuses a quantity beside the quantities, and shows the service's refusal there too", async () => {
      const s = holdingService({ holdings: book() });
      await open(arrangement, s);
      const d = await detail(arrangement, "h-ic");
      fireEvent.click(within(d).getByRole("button", { name: "Edit" }));
      const form = within(d).getByRole("form", { name: "edit 1231_IC" });
      const qty = within(form).getByRole("group", { name: "quantity of each leg" });
      typeIn(within(qty).getByLabelText("quantity, short PUT 6300"), "11");
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
      expect(within(qty).getByRole("alert").textContent).toBe("short PUT 6300: a quantity is a whole number from 1 to 10");
      expect(writes(s)).toEqual([]);

      s.refuse.set("PATCH /positions/h-ic", { status: 422, detail: "position '1231_IC' is closed: a leg's quantity is corrected only while it is held" });
      typeIn(within(qty).getByLabelText("quantity, short PUT 6300"), "2");
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(within(qty).getByRole("alert").textContent).toMatch(/is closed/));
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
      expect(within(result).getByTestId("realized").textContent).toBe("7 pts");
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
      await waitFor(() => expect(within(result).getByTestId("realized").textContent).toBe("7.8 pts"));
      expect(s.writes().at(-1)).toEqual({ method: "PATCH", path: "/positions/h-ic", body: { exit: 1.1, closed_on: "2026-11-11" } });
      expect(within(result).getByText(/closed on 2026-11-11/)).toBeTruthy();
    });

    it("asks before deleting, says the samples go with it, and offers closing instead", async () => {
      const s = holdingService({ holdings: book() });
      await open(arrangement, s);
      // a poll asked before the delete and answered after it still lists the holding
      s.stale.values = true;
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
      // and it stays off the live view when the re-read still lists it
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(document.querySelector('[data-ref="h-ic"]')).toBeNull();
    });

    it("says how old the Cost to close it starts at is, and links the sign's words to the box", async () => {
      const s = holdingService({ holdings: book() });
      await open(arrangement, s);
      const d = await detail(arrangement, "h-ic");
      fireEvent.click(within(d).getByRole("button", { name: "Close…" }));
      const exit = within(d).getByLabelText("exit, per contract");
      const hint = document.getElementById(exit.getAttribute("aria-describedby") ?? "")!;
      expect(hint.textContent).toMatch(/signed like the Cost to close/);
      expect(hint.textContent).toMatch(/Starts at the Cost to close as last valued, at 2026-11-12 23:14:05\+08:00/);
      expect(hint.textContent).not.toMatch(/Cost to close now/);
    });

    it("sends one close however fast the button is pressed twice", async () => {
      const s = holdingService({ holdings: book() });
      await open(arrangement, s);
      const d = await detail(arrangement, "h-ic");
      fireEvent.click(within(d).getByRole("button", { name: "Close…" }));
      const form = within(d).getByRole("form", { name: "close 1231_IC" });
      fireEvent.submit(form);
      fireEvent.submit(form);
      await screen.findByRole("region", { name: "closed 1231_IC" });
      expect(writes(s)).toEqual(["POST /positions/h-ic/close"]);
    });

    it("sends one correction however fast it is pressed twice, and announces it in a live region", async () => {
      const s = holdingService({ holdings: book() });
      await open(arrangement, s);
      const d = await detail(arrangement, "h-ic");
      fireEvent.click(within(d).getByRole("button", { name: "Close…" }));
      fireEvent.click(within(within(d).getByRole("form", { name: "close 1231_IC" })).getByRole("button", { name: "Close holding" }));
      const result = await screen.findByRole("region", { name: "closed 1231_IC" });
      const fix = within(result).getByRole("form", { name: "correct the close of 1231_IC" });
      // mounted empty, so a screen reader announces it when it fills
      expect(within(fix).getByRole("status").textContent).toBe("");
      typeIn(within(fix).getByLabelText("exit, per contract"), "1.3");
      fireEvent.submit(fix);
      fireEvent.submit(fix);
      await waitFor(() => expect(within(fix).getByRole("status").textContent).toBe("corrected"));
      expect(writes(s)).toEqual(["POST /positions/h-ic/close", "PATCH /positions/h-ic"]);
    });

    it("shows Entry and Exit as stored, not rounded to the cent", async () => {
      const s = holdingService({ holdings: book() });
      await open(arrangement, s);
      const d = await detail(arrangement, "h-ic");
      fireEvent.click(within(d).getByRole("button", { name: "Close…" }));
      fireEvent.click(within(within(d).getByRole("form", { name: "close 1231_IC" })).getByRole("button", { name: "Close holding" }));
      const result = await screen.findByRole("region", { name: "closed 1231_IC" });
      expect(result.textContent).toMatch(/entry 5 → exit 1\.225/);
    });

    it("keeps each close's account, and its correction, until its own Done", async () => {
      const s = holdingService({ holdings: book() });
      await open(arrangement, s);
      let d = await detail(arrangement, "h-ic");
      fireEvent.click(within(d).getByRole("button", { name: "Close…" }));
      fireEvent.click(within(within(d).getByRole("form", { name: "close 1231_IC" })).getByRole("button", { name: "Close holding" }));
      const first = await screen.findByRole("region", { name: "closed 1231_IC" });
      typeIn(within(first).getByLabelText("exit, per contract"), "1.3");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "1231_IC" })).toBeNull());
      d = await detail(arrangement, "h-calls");
      fireEvent.click(within(d).getByRole("button", { name: "Close…" }));
      fireEvent.click(within(within(d).getByRole("form", { name: "close 1218_C7300" })).getByRole("button", { name: "Close holding" }));
      const second = await screen.findByRole("region", { name: "closed 1218_C7300" });
      const again = screen.getByRole("region", { name: "closed 1231_IC" });
      expect((within(again).getByLabelText("exit, per contract") as HTMLInputElement).value).toBe("1.3");
      fireEvent.click(within(second).getByRole("button", { name: "Done" }));
      expect(screen.queryByRole("region", { name: "closed 1218_C7300" })).toBeNull();
      expect(screen.getByRole("region", { name: "closed 1231_IC" })).toBeTruthy();
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

describe("the day a close starts at", () => {
  /** 01:00 UTC on the 13th: 20:00 on the 12th in New York, where a close is dated. */
  const NY_EVENING = new Date("2026-11-13T01:00:00Z");

  it("is New York's day, not UTC's", async () => {
    const s = holdingService({ holdings: book() });
    await open("desk", s, false, NY_EVENING);
    const d = await detail("desk", "h-ic");
    fireEvent.click(within(d).getByRole("button", { name: "Close…" }));
    fireEvent.click(within(within(d).getByRole("form", { name: "close 1231_IC" })).getByRole("button", { name: "Close holding" }));
    await waitFor(() => expect(writes(s)).toEqual(["POST /positions/h-ic/close"]));
    expect(s.writes()[0]!.body).toEqual({ exit: 1.225, closed_on: "2026-11-12" });
  });

  it("is the expiry for a holding that expired before today, with a hint for a worthless one and no prefill", async () => {
    const expired = { ...LONG_PUT, id: "h-old", name: "1106_P6000", strike_date: "2026-11-06", cost_to_close: null };
    const s = holdingService({ holdings: [...book(), expired as Holding] });
    await open("desk", s, false, NY_EVENING);
    let d = await detail("desk", "h-old");
    fireEvent.click(within(d).getByRole("button", { name: "Close…" }));
    let form = within(d).getByRole("form", { name: "close 1106_P6000" });
    // blank is unknown (ADR 0022): 0 is offered in words, never typed for the owner
    expect((within(form).getByLabelText("exit, per contract") as HTMLInputElement).value).toBe("");
    expect(form.textContent).toMatch(/expired worthless\? type 0/i);
    fireEvent.click(within(form).getByRole("button", { name: "Close holding" }));
    await waitFor(() => expect(writes(s)).toEqual(["POST /positions/h-old/close"]));
    expect(s.writes()[0]!.body).toEqual({ exit: null, closed_on: "2026-11-06" });
    // and no hint on one still to expire
    await screen.findByRole("region", { name: "closed 1106_P6000" });
    d = await detail("desk", "h-ic");
    fireEvent.click(within(d).getByRole("button", { name: "Close…" }));
    form = within(d).getByRole("form", { name: "close 1231_IC" });
    expect(form.textContent).not.toMatch(/expired worthless/i);
  });
});

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
