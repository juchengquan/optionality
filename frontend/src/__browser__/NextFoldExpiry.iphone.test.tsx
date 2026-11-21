/** The book's expiry groups folded on the phone (the owner, 2026-11-21), under the iPhone 13 profile:
 *  a tap on a heading folds its cards and the next opens them, and every folded heading — the
 *  widest says a row count and several chips — stays inside the screen, wrapping rather than
 *  pushing the page sideways. The behaviour is `__tests__/NextFoldExpiry.test.tsx`'s. */
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../Next";
import { overflowsSideways, settle } from "./nextBook";
import { hitBox } from "./targets";
import { placed, serveOneBook } from "../testing/oneBookServe";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";

afterEach(() => {
  cleanup();
  document.cookie = "ui_folded=;path=/;max-age=0";
});

const heads = () => [...document.querySelectorAll<HTMLButtonElement>("[data-section] [data-expiry] h3 button")];
const cardsOf = (b: HTMLElement) => [...document.getElementById(b.getAttribute("aria-controls")!)!.querySelectorAll<HTMLElement>("article")];

describe("under the iPhone profile", () => {
  it("folds a group's cards at a tap and opens them at the next", async () => {
    serveOneBook();
    render(<Next />);
    await settle();
    await settle();
    expect(document.querySelector<HTMLElement>(".nx")!.dataset.arrangement).toBe("phone");
    const b = document.querySelector<HTMLButtonElement>('[data-section="spreads"] [data-expiry="2026-12-18"] h3 button')!;
    expect(cardsOf(b).length).toBeGreaterThan(0);
    await userEvent.click(b);
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(cardsOf(b).every((c) => c.getBoundingClientRect().height === 0)).toBe(true);
    await userEvent.click(b);
    expect(b.getAttribute("aria-expanded")).toBe("true");
    expect(cardsOf(b).every((c) => c.getBoundingClientRect().height > 0)).toBe(true);
  });

  // the page's rule (next.css, the owner 2026-11-16): a phone's button is DRAWN about 32px high and
  // reaches its 44pt through an invisible area above and below it — so the target is measured where
  // a finger lands (`targets.ts`), never off the button's box (review of #467)
  it("gives every heading, open and folded, a 44pt target of its own", async () => {
    serveOneBook();
    render(<Next />);
    await settle();
    await settle();
    const short = () => heads().map((b) => [b.textContent!, hitBox(b)] as const).filter(([, h]) => h.height < 44 || h.width < 44);
    expect(short()).toEqual([]);
    for (const b of heads()) await userEvent.click(b);
    expect(short()).toEqual([]);
  });

  it("draws every folded heading inside the screen", async () => {
    serveOneBook();
    render(<Next />);
    await settle();
    await settle();
    for (const b of heads()) await userEvent.click(b);
    expect(heads().every((b) => b.getAttribute("aria-expanded") === "false")).toBe(true);
    expect(document.documentElement.clientWidth).toBe(390);
    expect(overflowsSideways()).toBe(false);
    const book = document.querySelector(".nxp-book")!;
    const widest = heads().reduce((a, b) => (b.querySelectorAll(".nx-chip").length > a.querySelectorAll(".nx-chip").length ? b : a));
    expect(widest.querySelectorAll(".nx-chip").length, "a heading with one chip proves little").toBeGreaterThan(1);
    for (const b of heads()) {
      expect(b.scrollWidth, b.textContent!).toBeLessThanOrEqual(b.clientWidth + 0.5);
      expect(placed(b, book), b.textContent!).toBeNull();
      // each chip whole and inside the screen; uncovered is the button's to answer, since a touch
      // profile hit-tests a press inside a button as the button
      const edge = book.getBoundingClientRect();
      for (const chip of b.querySelectorAll(".nx-chip")) {
        const r = chip.getBoundingClientRect();
        expect(r.left >= edge.left - 0.5 && r.right <= edge.right + 0.5, chip.textContent!).toBe(true);
        expect(chip.scrollWidth, chip.textContent!).toBeLessThanOrEqual(chip.clientWidth + 0.5);
      }
    }
  });

  // the owner, 2026-11-21: a banner about a row in a folded group opens the group, then brings the
  // row into view and marks it, as it does for a row in an open group
  it("opens a folded group at a banner's tap, the row brought into view and marked", async () => {
    const health = { db: true, provider: { name: "moomoo", ok: true },
      monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
        fetched_at: "2026-11-10 23:14:05+08:00" },
      settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21, display_tz: "Asia/Singapore" } };
    // the lone contract on the last expiry, fired: its card starts out of view
    const quotes = QUOTES.map((q) => (q.id === "w-lone" ? { ...q, triggered: true } : q));
    window.fetch = ((url: string) => {
      const path = String(url).replace(/^.*\/api/, "");
      const body = path === "/quotes" ? quotes : path === "/monitors" ? MONITORS
        : path === "/health" ? health : path === "/positions/values" ? HOLDINGS : [];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }) as unknown as typeof fetch;
    document.cookie = "ui_folded=contracts:20261231;path=/";
    render(<Next />);
    await settle();
    window.scrollTo(0, 0);
    const b = document.querySelector<HTMLButtonElement>('[data-section="contracts"] [data-expiry="2026-12-31"] h3 button')!;
    expect(b.getAttribute("aria-expanded")).toBe("false");
    const card = document.querySelector<HTMLElement>('article[data-ref="w-lone"]')!;
    expect(card.getBoundingClientRect().height, "folded away to begin with").toBe(0);
    const banners = screen.getByRole("status", { name: "needs you" });
    await userEvent.click(within(banners).getByRole("button", { name: /20261231 C8000 entry signal/ }));
    await new Promise((r) => setTimeout(r, 900));
    expect(b.getAttribute("aria-expanded")).toBe("true");
    expect(document.cookie).not.toMatch(/ui_folded=[^;]*contracts:20261231/);
    const r = card.getBoundingClientRect();
    expect(card.hasAttribute("data-revealed")).toBe(true);
    // in view, below the header held at the top
    const top = document.querySelector<HTMLElement>(".nx-head")!.getBoundingClientRect().bottom;
    expect(r.height).toBeGreaterThan(0);
    expect(r.top >= top - 0.5 && r.bottom <= window.innerHeight + 0.5, `${r.top}–${r.bottom} not in ${top}–${window.innerHeight}`).toBe(true);
  });
});
