/** The whole page, walked (review of #418; the owner's standard of 2026-11-16): every place it
 *  draws words or a figure, opened and read from the page itself (`<Next />`) behind a service —
 *  the table or the cards, every inspector and sheet with its payoff's crosshair moved along, the
 *  References strip, the price map, the closed trades each opened, a holding's edit form (its
 *  quantity changed, so its payoff comparison draws) and its close form, a rule's total Entry split,
 *  and Settings. Each place is handed to `read` with where it is, and each guard decides what it
 *  checks there: `NumberFormatPage.test.tsx` the sign of every figure, `WordsPage.test.tsx` the
 *  page's words — "rule", never "Monitor"; a zone on every clock; no ISO date; no raw error.
 *
 *  Copy as text is NOT walked: it writes a figure's minus as the hyphen on purpose (the owner,
 *  2026-11-16, `MARKDOWN_FIGURE_MINUS`), and `NextPlainView.test.tsx` holds it to that.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, vi } from "vitest";

import type { Entry, Holding } from "../shared/api";
import { Next } from "../Next";
import { closedBookService } from "./closedBook";
import { CONDOR } from "./ruleEdits";

export type Read = (where: string, root: Element) => void;

/** Monday 16 November, 10:00 New York: in session, so every payoff and figure is live. */
export const MONDAY = new Date("2026-11-16T15:00:00Z");
/** Sunday 15 November, 10:00 in Singapore: outside every session, so the page says when each thing
 *  was valued and read. */
export const SUNDAY = new Date("2026-11-15T02:00:00Z");

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

/** @param shape changes what the service answers, after the walk's own negatives: a test's world */
export async function openPage(arrangement: "desk" | "phone", now: Date = MONDAY,
  shape: (path: string, body: unknown) => unknown = (_, body) => body) {
  const s = closedBookService();
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now });
  document.cookie = `ui_arrangement=${arrangement};path=/`;
  vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "").replace(/\?.*$/, "");
    const answer = await s.fetch(url, init);
    if ((init?.method ?? "GET") !== "GET" || !answer.ok) return answer;
    const body: unknown = await answer.json().catch(() => null);
    return { ok: true, status: 200, json: () => Promise.resolve(shape(path, negative(path, body))) } as Response;
  }) as typeof fetch);
  render(<Next />);
  await waitFor(() => expect(document.querySelectorAll("[data-ref]").length).toBeGreaterThan(5));
  await settle();
}

/** Turns the event loop until what was asked has answered and drawn (setTimeout is real here). */
export const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20)); });

/** Every payoff chart in `root` moved along with the keys: the readout and its tooltip, read. */
async function moveCrosshairs(root: Element, read: Read): Promise<number> {
  const charts = [...root.querySelectorAll<HTMLElement>("[role=group][aria-label^='payoff at expiry by SPX price']")];
  for (const chart of charts) {
    for (const key of ["Home", "ArrowRight", "ArrowRight", "End"]) {
      fireEvent.keyDown(chart, { key });
      read(`crosshair ${key}`, chart.closest("[aria-label='payoff at expiry']") ?? chart);
    }
  }
  return charts.length;
}

/** Settings, opened from the header: its notes, its References and the service's line. */
async function readSettings(read: Read): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "settings" }));
  await settle();
  const panel = screen.getAllByRole("dialog").at(-1)!;
  read("settings", panel);
  act(() => { window.history.back(); });
  await settle();
}

/** The Add sheet, opened from the header: its spread form and its contract form, each read. */
async function readAdd(read: Read): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "add" }));
  await settle();
  const sheet = screen.getAllByRole("dialog").at(-1)!;
  read("add: a spread", sheet);
  const contract = within(sheet).queryByRole("button", { name: "one contract" });
  if (contract) {
    fireEvent.click(contract);
    await settle();
    read("add: one contract", sheet);
  }
  act(() => { window.history.back(); });
  await settle();
}

/** A rule's editor and its delete question, opened in `root` (an inspector or a sheet) and read,
 *  then left as they were: the editor cancelled, the question kept. Returns whether there was one. */
async function readRuleForms(where: string, root: Element, read: Read): Promise<boolean> {
  const edit = root.querySelector<HTMLButtonElement>(".nx-mon-actions button[aria-label^='edit ']");
  if (!edit) return false;
  fireEvent.click(edit);
  await settle();
  read(`${where} rule edit`, root);
  fireEvent.click(within(root.querySelector<HTMLElement>(".nx-mon")!).getByRole("button", { name: "cancel" }));
  await settle();
  const del = root.querySelector<HTMLButtonElement>(".nx-mon-actions button[aria-label^='delete ']")!;
  fireEvent.click(del);
  await settle();
  read(`${where} rule delete`, root);
  fireEvent.click(within(root.querySelector<HTMLElement>(".nx-mon-ask")!).getByRole("button", { name: "keep it" }));
  await settle();
  return true;
}

/** The desk's palette, opened, its finds and its actions read, and shut. */
async function readPalette(read: Read): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /^find and act/ }));
  await settle();
  const palette = screen.getAllByRole("dialog").at(-1)!;
  read("palette", palette);
  fireEvent.keyDown(palette, { key: "Escape" });
  await settle();
}

/** The desk, walked: what it read, and how much of it was drawn to be read. */
/** @param now the page's clock: Monday 10:00 New York, in session, unless given */
export async function walkDesk(read: Read, now: Date = MONDAY): Promise<{ names: number; charts: number; compared: number; split: number }> {
  await openPage("desk", now);
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
      fireEvent.click(within(actions).getByRole("button", { name: "edit" }));
      const qty = insp.querySelector<HTMLInputElement>("input[aria-label^='quantity, ']");
      if (qty) {
        fireEvent.change(qty, { target: { value: "3" } });
        // asked a moment after the typing stops (HoldingActions' QuantityChange)
        for (let i = 0; i < 4; i++) await settle();
        const change = insp.querySelector("[aria-label='what the correction changes']");
        if (change?.querySelector(".nx-payoff-kv")) compared++;
      }
      read(`${name} edit`, insp);
      fireEvent.click(within(insp.querySelector<HTMLElement>(".nx-hold")!).getByRole("button", { name: "cancel" }));
      // the close form
      fireEvent.click(within(actions).getByRole("button", { name: "close…" }));
      await settle();
      read(`${name} close`, insp);
      charts += await moveCrosshairs(insp, read);
      fireEvent.click(within(insp).getByRole("button", { name: "keep it" }));
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
  // a rule's editor and its delete question, from the first rule row's inspector
  let ruleForms = 0;
  for (const name of names) {
    fireEvent.click([...document.querySelectorAll<HTMLButtonElement>(".nxd-row .nxd-name")].find((b) => b.textContent === name)!);
    await settle();
    const insp = screen.getByRole("complementary", { name: `inspector: ${name}` });
    if (!insp.querySelector(".nx-hold-actions") && await readRuleForms(name, insp, read)) { ruleForms++; break; }
  }
  expect(ruleForms, "a rule's forms read").toBe(1);
  await readSettings(read);
  await readAdd(read);
  await readPalette(read);
  return { names: names.length, charts, compared, split };
}

/** The phone, walked. */
export async function walkPhone(read: Read, now: Date = MONDAY): Promise<{ opens: number; charts: number; closes: number }> {
  await openPage("phone", now);
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
    if (actions && within(actions).queryByRole("button", { name: "close…" })) {
      closes++;
      fireEvent.click(within(actions).getByRole("button", { name: "close…" }));
      await settle();
      read(`${label} close`, sheet);
      fireEvent.click(within(sheet).getByRole("button", { name: "keep it" }));
    }
    act(() => { window.history.back(); });
    await settle();
  }
  expect(opens.length).toBeGreaterThan(5);
  // out of the session a watched spread with no close recorded has no payoff to draw
  expect(charts).toBeGreaterThan(now === MONDAY ? 3 : 2);
  expect(closes, "close forms read").toBeGreaterThan(1);
  // a rule's editor and its delete question, in a watched row's sheet
  let ruleForms = 0;
  for (const label of opens) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    await settle();
    const sheet = screen.getByRole("dialog");
    const done = !sheet.querySelector(".nx-hold-actions") && await readRuleForms(label, sheet, read);
    act(() => { window.history.back(); });
    await settle();
    if (done) { ruleForms++; break; }
  }
  expect(ruleForms, "a rule's forms read").toBe(1);
  await readSettings(read);
  await readAdd(read);
  return { opens: opens.length, charts, closes };
}
