/** The hyphen-minus guard over the WHOLE page (review of #418): `NumberFormat.test.tsx` walks the
 *  book's table, inspectors, cards and sheets; this walks everything else the page draws a figure
 *  in, from the page itself (`<Next />`) behind a service — the References strip, the price map, the
 *  closed trades, a holding's edit form with its quantity's payoff comparison and its close form, a
 *  rule's editor with its total Entry split, and every payoff's crosshair readout and tooltip. Text
 *  and every title and aria-label alike (`saidBy`).
 *
 *  Copy as text is NOT walked: it writes a figure's minus as the hyphen on purpose (the owner,
 *  2026-11-16, `MARKDOWN_FIGURE_MINUS`), and `NextPlainView.test.tsx` holds it to that.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Entry, Holding } from "../shared/api";
import { Next } from "../Next";
import { closedBookService } from "../testing/closedBook";
import { hyphenSigns, saidBy } from "../testing/hyphens";
import { CONDOR } from "../testing/ruleEdits";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const n of ["ui_arrangement", "ui_price_map", "ui_privacy"]) document.cookie = `${n}=;path=/;max-age=0`;
});

/** Monday 16 November, 10:00 New York: in session, so every payoff and figure is live. */
const MONDAY = new Date("2026-11-16T15:00:00Z");

/** A Reference down on the day, and one its source could not price. */
const REFERENCES = [
  { id: "ref1", code: "US..SPX", label: "S&P 500", source: "moomoo", figure: 7561.67, change: -0.004, field: "mid_price",
    name: "S&P 500", error: null, last_known: false, delayed: null, delayed_by_minutes: null, fetched_at: "2026-11-16 23:00:05+08:00" },
];

/** The served book with a negative in every figure a holding has, and the split's condor added. */
function negative(path: string, body: unknown): unknown {
  if (path === "/references") return REFERENCES;
  if (path === "/quotes") return [...(body as Entry[]), CONDOR];
  if (path === "/positions/values") {
    return (body as Holding[]).map((h) => ({
      ...h, captured: -0.12,
      greeks: { option_delta: -0.0204, option_gamma: -0.00004, option_theta: -0.11, option_vega: -0.79 },
      schedule: { dte_at_open: 45, on_pace: 4.48, pace_gap: -1.53, target: 2.36, stop: 9.44, target_dte: 11,
        manage_by_dte: 21, reached: null, manage_by_due: false },
    }));
  }
  return body;
}

async function openPage(arrangement: "desk" | "phone") {
  const s = closedBookService();
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: MONDAY });
  document.cookie = `ui_arrangement=${arrangement};path=/`;
  vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "").replace(/\?.*$/, "");
    const answer = await s.fetch(url, init);
    if ((init?.method ?? "GET") !== "GET" || !answer.ok) return answer;
    const body: unknown = await answer.json().catch(() => null);
    return { ok: true, status: 200, json: () => Promise.resolve(negative(path, body)) } as Response;
  }) as typeof fetch);
  render(<Next />);
  await waitFor(() => expect(document.querySelectorAll("[data-ref]").length).toBeGreaterThan(5));
  await settle();
}

/** Turns the event loop until what was asked has answered and drawn (setTimeout is real here). */
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20)); });

/** What a place says, kept with where it was read. */
function reading() {
  const said: string[] = [];
  const read = (where: string, root: Element) => { said.push(...hyphenSigns(saidBy(root)).map((s) => `${where}: ${s}`)); };
  return { said, read };
}

/** Every payoff chart in `root` moved along with the keys: the readout and its tooltip, read. */
async function moveCrosshairs(root: Element, read: (where: string, el: Element) => void): Promise<number> {
  const charts = [...root.querySelectorAll<HTMLElement>("[role=group][aria-label^='payoff at expiry by SPX price']")];
  for (const chart of charts) {
    for (const key of ["Home", "ArrowRight", "ArrowRight", "End"]) {
      fireEvent.keyDown(chart, { key });
      read(`crosshair ${key}`, chart.closest("[aria-label='payoff at expiry']") ?? chart);
    }
  }
  return charts.length;
}

describe("no figure signed with a hyphen-minus, anywhere on the page (review of #418)", () => {
  it("on the desk: the References, the price map, the closed trades, the holding forms, the split and the crosshairs", async () => {
    await openPage("desk");
    const { said, read } = reading();
    read("page", document.body);
    // the References strip, down on the day
    expect(document.body.textContent).toContain("−0.40%");

    // the price map, opened
    fireEvent.click(screen.getByRole("button", { name: "price map" }));
    await settle();
    const map = document.querySelector(".nxm")!;
    expect(map, "the price map drew nothing").toBeTruthy();
    expect(map.textContent).toMatch(/Δ/);
    read("price map", map);

    // the closed trades, each opened
    fireEvent.click(screen.getByRole("button", { name: "Closed trades" }));
    const journal = await screen.findByRole("region", { name: "closed trades" });
    await waitFor(() => expect(journal.querySelectorAll("[data-closed]").length).toBeGreaterThan(2));
    for (const row of [...journal.querySelectorAll<HTMLElement>("[data-closed] button[aria-expanded]")]) {
      fireEvent.click(row);
      await settle();
      read("journal", journal);
    }
    expect(journal.textContent).toContain("−");

    // each holding's forms, and each payoff's crosshair
    let charts = 0, compared = 0, split = 0;
    const names = [...document.querySelectorAll<HTMLButtonElement>(".nxd-row .nxd-name")].map((b) => b.textContent!);
    for (const name of names) {
      fireEvent.click([...document.querySelectorAll<HTMLButtonElement>(".nxd-row .nxd-name")].find((b) => b.textContent === name)!);
      await settle();
      const insp = screen.getByRole("complementary", { name: `inspector: ${name}` });
      read(name, insp);
      charts += await moveCrosshairs(insp, read);
      const actions = insp.querySelector<HTMLElement>(".nx-hold-actions");
      if (actions) {
        // the edit form, a leg's quantity changed: the payoff as recorded and as corrected
        fireEvent.click(within(actions).getByRole("button", { name: "Edit" }));
        const qty = insp.querySelector<HTMLInputElement>("input[aria-label^='quantity, ']");
        if (qty) {
          fireEvent.change(qty, { target: { value: "3" } });
          // asked a moment after the typing stops (HoldingActions' QuantityChange)
          for (let i = 0; i < 4; i++) await settle();
          const change = insp.querySelector("[aria-label='what the correction changes']");
          if (change?.querySelector(".nx-payoff-kv")) compared++;
        }
        read(`${name} edit`, insp);
        fireEvent.click(within(insp).getByRole("button", { name: "Cancel" }));
        // the close form
        fireEvent.click(within(actions).getByRole("button", { name: "Close…" }));
        await settle();
        read(`${name} close`, insp);
        charts += await moveCrosshairs(insp, read);
        fireEvent.click(within(insp).getByRole("button", { name: "Cancel" }));
      }
      // a rule's total Entry split, where it is offered: a total paid, so every share is negative
      const splitButton = insp.querySelector<HTMLButtonElement>("button[aria-label^='split a total entry across']");
      if (splitButton) {
        if (splitButton.getAttribute("aria-expanded") !== "true") fireEvent.click(splitButton);
        await settle();
        const total = within(insp).getByLabelText("total entry, per contract");
        fireEvent.change(total, { target: { value: "-9" } });
        await settle();
        if (insp.querySelector("table")) split++;
        read(`${name} split`, insp);
      }
    }
    expect(names.length).toBeGreaterThan(8);
    // worth nothing unless each was drawn and read
    expect(charts, "crosshairs moved").toBeGreaterThan(3);
    expect(compared, "quantity comparisons drawn").toBeGreaterThan(1);
    expect(split, "split tables drawn").toBeGreaterThan(0);
    expect(said).toEqual([]);
  }, 60_000);

  it("on the phone: the References, the closed trades, the holding forms in the sheet and the crosshairs", async () => {
    await openPage("phone");
    const { said, read } = reading();
    read("page", document.body);
    expect(document.body.textContent).toContain("−0.40%");
    fireEvent.click(screen.getByRole("button", { name: "Closed trades" }));
    const journal = await screen.findByRole("region", { name: "closed trades" });
    await waitFor(() => expect(journal.querySelectorAll("[data-closed]").length).toBeGreaterThan(2));
    for (const row of [...journal.querySelectorAll<HTMLElement>("[data-closed] button[aria-expanded]")]) {
      fireEvent.click(row);
      await settle();
      read("journal", journal);
    }
    let charts = 0, closes = 0;
    const opens = [...document.querySelectorAll<HTMLButtonElement>(".nxp-open")].map((b) => b.getAttribute("aria-label")!);
    for (const label of opens) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      await settle();
      const sheet = screen.getByRole("dialog");
      read(label, sheet);
      charts += await moveCrosshairs(sheet, read);
      const actions = sheet.querySelector<HTMLElement>(".nx-hold-actions");
      // a closed trade's sheet offers no close
      if (actions && within(actions).queryByRole("button", { name: "Close…" })) {
        closes++;
        fireEvent.click(within(actions).getByRole("button", { name: "Close…" }));
        await settle();
        read(`${label} close`, sheet);
        fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
      }
      act(() => { window.history.back(); });
      await settle();
    }
    expect(opens.length).toBeGreaterThan(5);
    expect(charts).toBeGreaterThan(3);
    expect(closes, "close forms read").toBeGreaterThan(1);
    expect(said).toEqual([]);
  }, 60_000);
});
