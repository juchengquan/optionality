/** The closed trades (#296, ADR 0022), folded at the bottom of the book since #373 — shut on every
 *  load, read only once opened, never polled: a section on the desk, a list on the phone that opens
 *  one trade per screen, each with its burndown and IV through `/positions/{id}/samples`, ending at
 *  its close, and the correction a mistyped close takes. Against a service that remembers what it
 *  was sent (`testing/holdingService.ts`), which serves a closed holding's samples only to the day
 *  it is closed on now, as the route does. Behaviour only; what the phone must MEASURE is
 *  `__browser__/NextJournal.iphone.test.tsx`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../next/Next";
import { closedBookService as service, days } from "../testing/closedBook";
import { holdingService, type HoldingService } from "../testing/holdingService";
import { HOLDINGS } from "../testing/ownerBook";

const COOKIES = ["ui_arrangement", "ui_privacy", "ui_refresh"];
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const n of COOKIES) document.cookie = `${n}=;path=/;max-age=0`;
});

/** 18:00 New York on Thursday 12 November, after the close. */
const AFTER_CLOSE = new Date("2026-11-12T23:00:00Z");
/** Noon in New York the same day, in the session. */
const IN_SESSION = new Date("2026-11-12T17:00:00Z");

async function open(
  arrangement: "desk" | "phone", s: HoldingService,
  { privacy = false, at = AFTER_CLOSE, fetch = s.fetch }: { privacy?: boolean; at?: Date; fetch?: typeof window.fetch } = {},
) {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: at });
  document.cookie = `ui_arrangement=${arrangement};path=/`;
  if (privacy) document.cookie = "ui_privacy=on;path=/";
  vi.stubGlobal("fetch", fetch);
  render(<Next />);
  await waitFor(() => expect(s.sent.some((x) => x.path === "/positions/values")).toBe(true));
}

/** The fold's own button, "Closed trades", at the bottom of the book (#373). */
const fold = () => screen.getByRole("button", { name: "Closed trades" });
const isOpen = () => fold().getAttribute("aria-expanded") === "true";

/** The closed trades, the fold opened first if it is shut: it is shut on every load (#373). */
async function journal(): Promise<HTMLElement> {
  const region = await screen.findByRole("region", { name: "closed trades" });
  if (!isOpen()) fireEvent.click(fold());
  return region;
}

/** Each entry of the journal, in the order drawn. */
async function entries(): Promise<HTMLElement[]> {
  const j = await journal();
  await waitFor(() => expect(j.querySelectorAll("[data-closed]").length).toBeGreaterThan(0));
  return [...j.querySelectorAll<HTMLElement>("[data-closed]")];
}

const fig = (entry: HTMLElement, name: string) => entry.querySelector(`[data-fig="${name}"]`)?.textContent;

/** One trade opened from the journal: on the desk beneath it, on the phone a screen of its own. */
async function openTrade(name: string): Promise<HTMLElement> {
  const j = await journal();
  // the desk's row names the trade; the phone's whole card is one target, "details of" it
  const button = () => within(j).getByRole("button", { name: new RegExp(`^(details of )?${name}$`) });
  await waitFor(() => expect(button()).toBeTruthy());
  fireEvent.click(button());
  return screen.findByRole("region", { name: `closed trade ${name}` });
}

/** The journal's row for `id`, read past the phone's sheet, which hides the page beneath it. */
const rowOf = (id: string) => document.querySelector<HTMLElement>(`[aria-label="closed trades"] [data-closed="${id}"]`);

/** 1231_IC closed from its detail outside the session, at `exit`: the close's account, once it is drawn. */
async function closeHeld(arrangement: "desk" | "phone", exit?: string): Promise<HTMLElement> {
  // drawn, not only asked for: a loaded runner answers the valuation after `open` returns
  await waitFor(() => expect(document.querySelector('[data-ref="h-ic"]')).not.toBeNull());
  if (arrangement === "desk") {
    const row = document.querySelector<HTMLElement>('.nxd-row[data-ref="h-ic"]')!;
    fireEvent.click(row.querySelector(".nxd-name")!);
  } else {
    const card = document.querySelector<HTMLElement>('article[data-ref="h-ic"]')!;
    fireEvent.click(within(card).getByRole("button", { name: "details of 1231_IC" }));
  }
  const d = arrangement === "desk"
    ? screen.getByRole("complementary", { name: /^inspector:/ }) : await screen.findByRole("dialog");
  fireEvent.click(within(d).getByRole("button", { name: "Close…" }));
  const form = within(d).getByRole("form", { name: "close 1231_IC" });
  if (exit !== undefined) fireEvent.change(within(form).getByLabelText("exit, per contract"), { target: { value: exit } });
  fireEvent.click(within(form).getByRole("button", { name: "Close holding" }));
  const account = await screen.findByRole("region", { name: "closed 1231_IC" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // listed at once where the fold is open; shut, it lists nothing and reads nothing (#373)
  if (isOpen()) await waitFor(() => expect(rowOf("h-ic")).not.toBeNull());
  return account;
}

const asked = (s: HoldingService, path: string) => s.sent.filter((x) => x.method === "GET" && x.path === path).length;
const typeIn = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

for (const arrangement of ["desk", "phone"] as const) {
  describe(`the journal on the ${arrangement}`, () => {
    it("lists the closed holdings newest first, with Opened, the close, Entry, Exit and what each made", async () => {
      const s = service();
      await open(arrangement, s);
      const rows = await entries();
      expect(rows.map((r) => r.dataset.closed)).toEqual(["c-blank", "c-tie", "c-old"]);
      const [blank, tie, old] = rows as [HTMLElement, HTMLElement, HTMLElement];
      expect(fig(old, "opened")).toBe("2026-11-01");
      expect(fig(old, "closed")).toBe("2026-11-06");
      expect(fig(old, "entry")).toBe("2");
      expect(fig(old, "exit")).toBe("0.5");
      // (2 − 0.5) × 3, as the service answered it
      expect(fig(old, "made")).toBe("4.5 pts");
      expect(fig(tie, "made")).toBe("-0.6 pts");
      // blank is unknown, never 0
      expect(fig(blank, "exit")).toBe("unknown");
      expect(fig(blank, "made")).toBe("unknown");
      // read from the one listing, with no market call
      expect(asked(s, "/positions")).toBe(1);
    });

    it("hides what each made and every contract count under privacy, and keeps Entry and Exit per contract", async () => {
      const s = service();
      await open(arrangement, s, { privacy: true });
      const old = (await entries()).find((r) => r.dataset.closed === "c-old")!;
      expect(fig(old, "made")).toBe("••• pts");
      expect(fig(old, "entry")).toBe("2");
      const trade = await openTrade("1120_P6000");
      expect(fig(trade, "made")).toBe("••• pts");
      expect(fig(trade, "contracts")).toBe("×•••");
      expect(trade.textContent).not.toMatch(/×3|3 contracts/);
      expect(trade.textContent).not.toMatch(/4\.50/);
    });

    it("never draws a closed holding among the open ones", async () => {
      const s = service();
      await open(arrangement, s);
      await entries();
      for (const id of ["c-old", "c-tie", "c-blank"]) {
        expect(document.querySelector(`[data-ref="${id}"]`)).toBeNull();
      }
    });

    it("opens one trade with its burndown and IV, ending at the day it closed", async () => {
      const s = service();
      await open(arrangement, s);
      const trade = await openTrade("1120_P6000");
      const burndown = await within(trade).findByRole("group", { name: "burndown" });
      await waitFor(() => expect(burndown.querySelectorAll("[data-sample]").length).toBeGreaterThan(0));
      const drawn = [...burndown.querySelectorAll<SVGElement>("[data-sample]")].map((p) => p.dataset.sample);
      // the sweep wrote the 7th and the 8th; the service hides them, and the page draws what it served
      expect(drawn).toEqual(days("2026-11-01", 6));
      // the close is marked where it was, and nothing is valued "now" for a trade that is over
      expect(burndown.querySelector("[data-close]")?.textContent).toContain("closed");
      expect(burndown.querySelector("[data-now]")).toBeNull();
      expect(await within(trade).findByRole("group", { name: "IV by leg" })).toBeTruthy();
      expect(asked(s, "/positions/c-old/samples")).toBe(1);
    });

    it("reads the journal once and each trade's samples once, and polls neither", async () => {
      const s = service();
      document.cookie = "ui_refresh=5;path=/";
      await open(arrangement, s);
      const trade = await openTrade("1120_P6000");
      await within(trade).findByRole("group", { name: "IV by leg" });
      for (let i = 0; i < 4; i++) await act(async () => { vi.advanceTimersByTime(15_000); });
      // the line WAS polled in that minute, so the clock did run
      expect(asked(s, "/health")).toBeGreaterThan(1);
      expect(asked(s, "/positions")).toBe(1);
      expect(asked(s, "/positions/c-old/samples")).toBe(1);
    });

    it("corrects a mistyped close from its entry, by PATCH, and draws the corrected figures and days", async () => {
      const s = service();
      await open(arrangement, s);
      const trade = await openTrade("1120_P6000");
      const burndown = await within(trade).findByRole("group", { name: "burndown" });
      await waitFor(() => expect(burndown.querySelectorAll("[data-sample]")).toHaveLength(6));
      const fix = within(trade).getByRole("form", { name: "correct the close of 1120_P6000" });
      expect((within(fix).getByLabelText("exit, per contract") as HTMLInputElement).value).toBe("0.5");
      expect((within(fix).getByLabelText("closed on") as HTMLInputElement).value).toBe("2026-11-06");
      typeIn(within(fix).getByLabelText("exit, per contract"), "0.7");
      typeIn(within(fix).getByLabelText("closed on"), "2026-11-04");
      fireEvent.click(within(fix).getByRole("button", { name: "Save correction" }));
      await waitFor(() => expect(s.writes().map((w) => [`${w.method} ${w.path}`, w.body]))
        .toEqual([["PATCH /positions/c-old", { exit: 0.7, closed_on: "2026-11-04" }]]));
      await waitFor(() => expect(within(fix).getByRole("status").textContent).toBe("corrected"));

      // the journal as the service now has it: (2 − 0.7) × 3
      await waitFor(() => expect(fig(trade, "made")).toBe("3.9 pts"));
      expect(fig(trade, "exit")).toBe("0.7");
      expect(fig(trade, "closed")).toBe("2026-11-04");
      // the journal's own row too — read past the phone's sheet, which hides the page beneath it
      const row = document.querySelector<HTMLElement>('[aria-label="closed trades"] [data-closed="c-old"]')!;
      await waitFor(() => expect(fig(row, "made")).toBe("3.9 pts"));
      expect(fig(row, "closed")).toBe("2026-11-04");
      // and the charts end at the corrected day, read again because the day moved
      await waitFor(() => {
        const now = within(trade).getByRole("group", { name: "burndown" });
        expect([...now.querySelectorAll<SVGElement>("[data-sample]")].map((p) => p.dataset.sample))
          .toEqual(days("2026-11-01", 4));
      });
      expect(asked(s, "/positions/c-old/samples")).toBe(2);
      expect(asked(s, "/positions")).toBe(2);
    });

    it("says a refusal of the correction in its form, and changes nothing", async () => {
      const s = service();
      s.refuse.set("PATCH /positions/c-old", { status: 422, detail: "closed on 2026-10-30, before it was opened on 2026-11-01" });
      await open(arrangement, s);
      const trade = await openTrade("1120_P6000");
      const fix = within(trade).getByRole("form", { name: "correct the close of 1120_P6000" });
      typeIn(within(fix).getByLabelText("closed on"), "2026-10-30");
      fireEvent.click(within(fix).getByRole("button", { name: "Save correction" }));
      expect((await within(fix).findByRole("alert")).textContent).toBe("closed on 2026-10-30, before it was opened on 2026-11-01");
      expect(fig(trade, "closed")).toBe("2026-11-06");
      expect(asked(s, "/positions")).toBe(1);
    });

    it("lists a holding closed outside the session at once, newest first", async () => {
      const s = service();
      await open(arrangement, s);
      await entries();
      if (arrangement === "desk") {
        const row = document.querySelector<HTMLElement>('.nxd-row[data-ref="h-ic"]')!;
        fireEvent.click(row.querySelector(".nxd-name")!);
      } else {
        const card = document.querySelector<HTMLElement>('article[data-ref="h-ic"]')!;
        fireEvent.click(within(card).getByRole("button", { name: "details of 1231_IC" }));
      }
      const d = arrangement === "desk"
        ? screen.getByRole("complementary", { name: /^inspector:/ }) : await screen.findByRole("dialog");
      fireEvent.click(within(d).getByRole("button", { name: "Close…" }));
      fireEvent.click(within(within(d).getByRole("form", { name: "close 1231_IC" })).getByRole("button", { name: "Close holding" }));
      await screen.findByRole("region", { name: "closed 1231_IC" });
      await waitFor(async () => expect((await entries()).map((r) => r.dataset.closed)[0]).toBe("h-ic"));
      expect(fig((await entries())[0]!, "closed")).toBe("2026-11-12");
    });

    it("reads the journal again after a correction made from the close's account", async () => {
      const s = service();
      await open(arrangement, s);
      await entries();
      const account = await closeHeld(arrangement, "1");
      const fix = within(account).getByRole("form", { name: "correct the close of 1231_IC" });
      typeIn(within(fix).getByLabelText("exit, per contract"), "1.3");
      fireEvent.click(within(fix).getByRole("button", { name: "Save correction" }));
      await waitFor(() => expect(fig(rowOf("h-ic")!, "exit")).toBe("1.3"));
    });

    it("keeps the trade open when the re-read after a correction fails, and says so beside it", async () => {
      const s = service();
      await open(arrangement, s);
      const trade = await openTrade("1120_P6000");
      s.refuse.set("GET /positions", { status: 500, detail: "database is locked" });
      const fix = within(trade).getByRole("form", { name: "correct the close of 1120_P6000" });
      typeIn(within(fix).getByLabelText("exit, per contract"), "0.7");
      fireEvent.click(within(fix).getByRole("button", { name: "Save correction" }));
      await waitFor(() => expect(asked(s, "/positions")).toBe(2));
      const j = document.querySelector<HTMLElement>('[aria-label="closed trades"]')!;
      await waitFor(() => expect(j.textContent).toMatch(/could not be read — \/positions → 500/));
      // the rows it had stay, and so does the trade that is open
      expect(rowOf("c-old")).not.toBeNull();
      expect(screen.getByRole("region", { name: "closed trade 1120_P6000", hidden: true })).toBe(trade);
      if (arrangement === "phone") expect(screen.getByRole("dialog", { name: "1120_P6000" })).toBeTruthy();
      // and the next good read clears the error, with the figures as the service has them
      s.refuse.delete("GET /positions");
      typeIn(within(fix).getByLabelText("exit, per contract"), "0.8");
      fireEvent.click(within(fix).getByRole("button", { name: "Save correction" }));
      await waitFor(() => expect(fig(trade, "exit")).toBe("0.8"));
      expect(j.textContent).not.toMatch(/could not be read/);
      if (arrangement === "phone") expect(screen.getByRole("dialog", { name: "1120_P6000" })).toBeTruthy();
    });

    it("never lets an older read of the journal land over a newer one", async () => {
      const s = service();
      // the second read of /positions is held back until the test lets it go
      let reads = 0;
      let release: () => void = () => undefined;
      const fetch = ((url: string, init?: RequestInit) => {
        const answer = s.fetch(url, init);
        if (String(url).replace(/^.*\/api/, "") !== "/positions" || ++reads !== 2) return answer;
        return new Promise((resolve) => { release = () => resolve(answer); });
      }) as unknown as typeof window.fetch;
      await open(arrangement, s, { fetch });
      const trade = await openTrade("1120_P6000");
      const fix = within(trade).getByRole("form", { name: "correct the close of 1120_P6000" });
      typeIn(within(fix).getByLabelText("exit, per contract"), "0.7");
      fireEvent.click(within(fix).getByRole("button", { name: "Save correction" }));
      // waited for on the page: the held read changes nothing a waitFor would notice
      await waitFor(() => expect(within(fix).getByRole("status").textContent).toBe("corrected"));
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(reads).toBe(2);
      typeIn(within(fix).getByLabelText("exit, per contract"), "0.9");
      fireEvent.click(within(fix).getByRole("button", { name: "Save correction" }));
      await waitFor(() => expect(fig(trade, "exit")).toBe("0.9"));
      // the read asked after the first correction answers last, saying 0.7: it must land nowhere
      await act(async () => { release(); await new Promise((r) => setTimeout(r, 20)); });
      expect(fig(trade, "exit")).toBe("0.9");
      expect(fig(rowOf("c-old")!, "exit")).toBe("0.9");
    });

    it("draws a closed trade's burndown in points per contract, never in dollars", async () => {
      const s = service();
      await open(arrangement, s);
      const trade = await openTrade("1120_P6000");
      const burndown = await within(trade).findByRole("group", { name: "burndown" });
      await waitFor(() => expect(burndown.querySelectorAll("[data-sample]").length).toBeGreaterThan(0));
      expect(burndown.querySelector("h4")?.textContent).toContain("points to close, per contract");
      expect(burndown.textContent).not.toMatch(/\$/);
    });

    it("says a trade with no samples has none, rather than that the sweep will write one", async () => {
      const s = service();
      await open(arrangement, s);
      const trade = await openTrade("1204_P6500");
      const burndown = await within(trade).findByRole("group", { name: "burndown" });
      await waitFor(() => expect(burndown.textContent).toMatch(/no daily samples for this trade/));
      expect(burndown.textContent).not.toMatch(/while it is held/);
    });

    it("marks the close on the day it was, whichever way the expiry is spelled", async () => {
      const s = service({ "c-old": { strike_date: "20261120" } });
      await open(arrangement, s);
      const trade = await openTrade("1120_P6000");
      const burndown = await within(trade).findByRole("group", { name: "burndown" });
      await waitFor(() => expect(burndown.querySelectorAll("[data-sample]")).toHaveLength(6));
      const mark = Number(burndown.querySelector("[data-close] line")?.getAttribute("x1"));
      const last = Number([...burndown.querySelectorAll("[data-sample] circle")].at(-1)!.getAttribute("cx"));
      expect(Math.abs(mark - last)).toBeLessThan(0.5);
    });

    it("deletes a trade recorded by mistake, only after asking, and takes it out of the journal", async () => {
      const s = service();
      await open(arrangement, s);
      const trade = await openTrade("1120_P6000");
      fireEvent.click(within(trade).getByRole("button", { name: "Delete…" }));
      const ask = within(trade).getByRole("group", { name: "delete 1120_P6000?" });
      expect(ask.textContent).toMatch(/daily samples are deleted with it/);
      expect(ask.textContent).toMatch(/cannot be re-entered/);
      // a closed trade cannot be closed instead
      expect(within(ask).queryByRole("button", { name: "Close it instead" })).toBeNull();
      // the safe answer takes the focus, so Enter on arrival deletes nothing
      expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Keep it" }));
      fireEvent.click(within(ask).getByRole("button", { name: "Keep it" }));
      expect(within(trade).queryByRole("group", { name: "delete 1120_P6000?" })).toBeNull();
      expect(s.writes()).toEqual([]);

      fireEvent.click(within(trade).getByRole("button", { name: "Delete…" }));
      fireEvent.click(within(within(trade).getByRole("group", { name: "delete 1120_P6000?" }))
        .getByRole("button", { name: "Delete for good" }));
      await waitFor(() => expect(s.writes().map((w) => `${w.method} ${w.path}`)).toEqual(["DELETE /positions/c-old"]));
      await waitFor(() => expect(rowOf("c-old")).toBeNull());
      // and the section read again, once
      await waitFor(() => expect(asked(s, "/positions")).toBe(2));
      await waitFor(() => expect(screen.queryByRole("region", { name: "closed trade 1120_P6000", hidden: true })).toBeNull());
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(rowOf("c-tie")).not.toBeNull();
    });

    it("says the journal could not be read, rather than that nothing was closed", async () => {
      const s = service();
      s.refuse.set("GET /positions", { status: 500, detail: "database is locked" });
      await open(arrangement, s);
      const j = await journal();
      await waitFor(() => expect(j.textContent).toMatch(/closed trades could not be read — \/positions → 500/));
      expect(j.textContent).not.toMatch(/nothing closed/);
    });

    it("says when nothing has been closed", async () => {
      const s = holdingService({ holdings: HOLDINGS });
      await open(arrangement, s);
      const j = await journal();
      await waitFor(() => expect(j.textContent).toMatch(/nothing closed yet/));
    });
  });
}

describe("the desk's journal", () => {
  it("keeps two correction forms of one close from undoing each other", async () => {
    const s = service();
    await open("desk", s);
    await entries();
    const account = await closeHeld("desk", "1");
    const trade = await openTrade("1231_IC");
    // corrected from the close's account while the journal's form is open on the same close
    const fromAccount = within(account).getByRole("form", { name: "correct the close of 1231_IC" });
    typeIn(within(fromAccount).getByLabelText("exit, per contract"), "0.7");
    fireEvent.click(within(fromAccount).getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(fig(trade, "exit")).toBe("0.7"));
    // then only the day, from the journal's
    const fromJournal = within(trade).getByRole("form", { name: "correct the close of 1231_IC" });
    expect((within(fromJournal).getByLabelText("exit, per contract") as HTMLInputElement).value).toBe("0.7");
    typeIn(within(fromJournal).getByLabelText("closed on"), "2026-11-11");
    fireEvent.click(within(fromJournal).getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(s.writes().at(-1)).toEqual(
      { method: "PATCH", path: "/positions/h-ic", body: { closed_on: "2026-11-11" } }));
    expect(s.stored.get("h-ic")!.exit).toBe(0.7);
    await waitFor(() => expect(fig(trade, "closed")).toBe("2026-11-11"));
    expect(fig(trade, "exit")).toBe("0.7");
    // and the close's account says the close as the service now has it
    await waitFor(() => expect(account.textContent).toMatch(/closed on 2026-11-11/));
    expect(account.textContent).toMatch(/exit 0\.7 ·/);
  });

  it("brings an opened trade into view, the focus on it, and marks its row with valid ARIA", async () => {
    const s = service();
    await open("desk", s);
    const trade = await openTrade("1120_P6000");
    await waitFor(() => expect(trade.contains(document.activeElement)).toBe(true));
    const row = rowOf("c-old")!;
    expect(row.hasAttribute("aria-selected")).toBe(false);
    expect(within(row).getByRole("button", { name: "1120_P6000" }).getAttribute("aria-expanded")).toBe("true");
  });
});

/** The page's poll, `n` times: the line is asked at each, so the clock did run. */
async function polls(n: number) {
  for (let i = 0; i < n; i++) await act(async () => { vi.advanceTimersByTime(15_000); });
}

/** The book as drawn: the desk's table or the phone's cards. */
const book = () => document.querySelector<HTMLElement>(".nx-book")!;

describe("folded at the bottom of the book (#373)", () => {
  for (const arrangement of ["desk", "phone"] as const) {
    for (const [when, at] of [["in session", IN_SESSION], ["outside it", AFTER_CLOSE]] as const) {
      it(`is shut on loading, ${when} on the ${arrangement}, and asks for nothing across polls`, async () => {
        const s = service();
        document.cookie = "ui_refresh=5;path=/";
        await open(arrangement, s, { at });
        await waitFor(() => expect(document.querySelector('[data-ref="h-ic"]')).not.toBeNull());
        const region = screen.getByRole("region", { name: "closed trades" });
        expect(fold().getAttribute("aria-expanded")).toBe("false");
        // shut, it mounts no row and names no closed trade
        expect(region.querySelector("[data-closed]")).toBeNull();
        expect(document.body.textContent).not.toMatch(/1120_P6000|1204_P6500|1204_C7500/);
        const line = asked(s, "/health");
        await polls(4);
        expect(asked(s, "/health")).toBeGreaterThan(line);
        expect(asked(s, "/positions")).toBe(0);
      });

      it(`is the last thing in the book, ${when} on the ${arrangement}: after the watchlist`, async () => {
        const s = service();
        await open(arrangement, s, { at });
        const region = await screen.findByRole("region", { name: "closed trades" });
        expect(book().lastElementChild).toBe(region);
        const watchlist = book().querySelector(`[aria-labelledby="${arrangement === "desk" ? "nxd" : "nxp"}-watchlist"]`)!;
        expect(watchlist.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      });
    }

    it(`reads the closed trades once on opening, on the ${arrangement}, and never again by polling or reopening`, async () => {
      const s = service();
      document.cookie = "ui_refresh=5;path=/";
      await open(arrangement, s);
      fireEvent.click(fold());
      expect(fold().getAttribute("aria-expanded")).toBe("true");
      const region = screen.getByRole("region", { name: "closed trades" });
      expect(fold().getAttribute("aria-controls")).toBeTruthy();
      expect(document.getElementById(fold().getAttribute("aria-controls")!)).not.toBeNull();
      await waitFor(() => expect(region.querySelectorAll("[data-closed]")).toHaveLength(3));
      expect(asked(s, "/positions")).toBe(1);
      await polls(4);
      expect(asked(s, "/positions")).toBe(1);
      // shut: the rows are hidden — kept, with whatever is open in them — and nothing is asked
      fireEvent.click(fold());
      expect(fold().getAttribute("aria-expanded")).toBe("false");
      expect(document.getElementById(fold().getAttribute("aria-controls")!)!.hidden).toBe(true);
      expect(within(region).queryAllByRole("button", { name: /1120_P6000/ })).toEqual([]);
      await polls(2);
      // opened again: the rows it read, and still nothing asked
      fireEvent.click(fold());
      expect(region.querySelectorAll("[data-closed]")).toHaveLength(3);
      await polls(2);
      expect(asked(s, "/positions")).toBe(1);
    });

    it(`reads nothing for a close made before the fold was ever opened, on the ${arrangement}, and the close's own answer is its account`, async () => {
      const s = service();
      await open(arrangement, s);
      const account = await closeHeld(arrangement, "1");
      // drawn from the close's answer: the journal was never read
      expect(account.textContent).toMatch(/closed on 2026-11-12/);
      const fix = within(account).getByRole("form", { name: "correct the close of 1231_IC" });
      typeIn(within(fix).getByLabelText("exit, per contract"), "1.3");
      fireEvent.click(within(fix).getByRole("button", { name: "Save correction" }));
      await waitFor(() => expect(within(fix).getByRole("status").textContent).toBe("corrected"));
      // and the account says the correction from its own answer, the journal still unread
      await waitFor(() => expect(account.textContent).toMatch(/exit 1\.3 ·/));
      await polls(2);
      expect(asked(s, "/positions")).toBe(0);
      // opened after both: ONE read, saying the close as the service now has it
      fireEvent.click(fold());
      await waitFor(() => expect(fig(rowOf("h-ic")!, "exit")).toBe("1.3"));
      expect(asked(s, "/positions")).toBe(1);
    });

    it(`reads again once for a close made after the fold was opened, shut since, on the ${arrangement}`, async () => {
      const s = service();
      await open(arrangement, s);
      await entries();
      fireEvent.click(fold());
      expect(asked(s, "/positions")).toBe(1);
      await closeHeld(arrangement, "1");
      await waitFor(() => expect(asked(s, "/positions")).toBe(2));
      await polls(2);
      expect(asked(s, "/positions")).toBe(2);
    });

    it(`corrects a close from the section in session too, on the ${arrangement}`, async () => {
      const s = service();
      await open(arrangement, s, { at: IN_SESSION });
      const trade = await openTrade("1120_P6000");
      const fix = within(trade).getByRole("form", { name: "correct the close of 1120_P6000" });
      typeIn(within(fix).getByLabelText("exit, per contract"), "0.7");
      fireEvent.click(within(fix).getByRole("button", { name: "Save correction" }));
      await waitFor(() => expect(fig(rowOf("c-old")!, "made")).toBe("3.9 pts"));
      expect(asked(s, "/positions")).toBe(2);
    });
  }

  it("on the phone, is the last thing in the book, at every hour, picked by no tab (#374)", async () => {
    const s = service();
    await open("phone", s, { at: IN_SESSION });
    expect(within(screen.getByRole("navigation", { name: "views" })).getAllByRole("button").map((b) => b.textContent))
      .toEqual(["Book", "Add", "Settings"]);
    expect(await entries()).toHaveLength(3);
    expect(book().lastElementChild).toBe(screen.getByRole("region", { name: "closed trades" }));
    expect(asked(s, "/positions")).toBe(1);
  });
});

/** The desk's cursor: the row j and k are on. */
const cursor = () => document.querySelector<HTMLElement>(".nxd-row[data-cursor]")?.dataset.ref ?? null;
const inspector = () => screen.queryByRole("complementary", { name: /^inspector:/ });

describe("the fold beside the desk's own keys", () => {
  it("leaves j to the table while a trade is open in the fold and the focus is outside it", async () => {
    const s = service();
    await open("desk", s, { at: IN_SESSION });
    await openTrade("1120_P6000");
    (document.activeElement as HTMLElement | null)?.blur();
    expect(cursor()).toBeNull();
    fireEvent.keyDown(document.body, { key: "j" });
    await waitFor(() => expect(cursor()).not.toBeNull());
  });

  it("leaves j alone while the focus is inside the fold's correction", async () => {
    const s = service();
    await open("desk", s, { at: IN_SESSION });
    const trade = await openTrade("1120_P6000");
    const save = within(trade).getByRole("button", { name: "Save correction" });
    save.focus();
    fireEvent.keyDown(save, { key: "j" });
    expect(cursor()).toBeNull();
  });

  it("lets the palette land on a row while a trade is open in the fold", async () => {
    const s = service();
    await open("desk", s, { at: IN_SESSION });
    await openTrade("1120_P6000");
    const user = userEvent.setup();
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard("{Control>}k{/Control}");
    const palette = screen.getByRole("dialog", { name: "commands" });
    await user.type(within(palette).getByRole("combobox"), "1231_IC holding");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "commands" })).toBeNull());
    await waitFor(() => expect(inspector()?.getAttribute("aria-label")).toBe("inspector: 1231_IC"));
  });

  it("keeps the inspector open on an Escape inside the fold, and the correction's Escape puts its figures back", async () => {
    const s = service();
    await open("desk", s, { at: IN_SESSION });
    fireEvent.click(document.querySelector<HTMLElement>('.nxd-row[data-ref="h-ic"] .nxd-name')!);
    await waitFor(() => expect(inspector()).not.toBeNull());
    const trade = await openTrade("1120_P6000");
    const fix = within(trade).getByRole("form", { name: "correct the close of 1120_P6000" });
    const exit = within(fix).getByLabelText("exit, per contract") as HTMLInputElement;
    typeIn(exit, "0.9");
    exit.focus();
    fireEvent.keyDown(exit, { key: "Escape" });
    // the edit cancelled, to the close as the service has it, and the inspector left open
    expect(exit.value).toBe("0.5");
    expect(inspector()).not.toBeNull();
    // and an Escape with nothing to cancel is still not the inspector's
    fireEvent.keyDown(exit, { key: "Escape" });
    expect(inspector()).not.toBeNull();
    expect(s.writes()).toEqual([]);
  });

  it("keeps a correction's draft and the open trade across a shut, and reads nothing for it", async () => {
    const s = service();
    await open("desk", s, { at: IN_SESSION });
    const trade = await openTrade("1120_P6000");
    typeIn(within(trade).getByLabelText("exit, per contract"), "0.9");
    fireEvent.click(fold());
    expect(fold().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fold());
    const again = screen.getByRole("region", { name: "closed trade 1120_P6000" });
    expect((within(again).getByLabelText("exit, per contract") as HTMLInputElement).value).toBe("0.9");
    expect(asked(s, "/positions")).toBe(1);
  });
});

for (const arrangement of ["desk", "phone"] as const) {
  it(`reads again on reopening, on the ${arrangement}, when the first read failed and nothing was drawn`, async () => {
    const s = service();
    s.refuse.set("GET /positions", { status: 503, detail: "busy" });
    await open(arrangement, s);
    const j = await journal();
    await waitFor(() => expect(j.textContent).toMatch(/could not be read/));
    s.refuse.delete("GET /positions");
    fireEvent.click(fold());
    fireEvent.click(fold());
    await waitFor(() => expect(j.querySelectorAll("[data-closed]")).toHaveLength(3));
    expect(asked(s, "/positions")).toBe(2);
    expect(j.textContent).not.toMatch(/could not be read/);
  });
}
