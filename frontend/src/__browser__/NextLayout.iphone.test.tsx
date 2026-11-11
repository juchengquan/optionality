/** The redesigned page on a phone, under Playwright's iPhone profile (ADR 0023): touch, a coarse
 *  pointer and a 390px screen. Runs in the suite's `iphone` instance only.
 *
 *  What a phone needs that a desk does not: nothing pushed sideways, a 44pt target for every
 *  control, and 16px text in every box, below which iOS zooms the page when a box is focused.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { longBook, overflowsSideways, serveBook, settle } from "./nextBook";

async function show() {
  serveBook();
  render(<Next />);
  await settle();
}

afterEach(cleanup);

/** Every control a finger has to hit — on the whole document, not only inside the page: a
 *  confirmation dialog and a toast are drawn in portals beside it. */
function targets(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("body :is(button, select, input, a)")]
    .filter((el) => el.getClientRects().length > 0 && el.getAttribute("type") !== "hidden");
}

/** A dialog opens with a zoom from 95%, and a box measured mid-animation is 95% of its size. */
async function animationsDone(): Promise<void> {
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
}

function tooSmall(): string[] {
  return targets().flatMap((el) => {
    const r = el.getBoundingClientRect();
    return r.width < 44 || r.height < 44
      ? [`${el.tagName.toLowerCase()} "${el.getAttribute("aria-label") ?? el.textContent?.trim()}" ${Math.round(r.width)}×${Math.round(r.height)}`]
      : [];
  });
}

function zooms(): string[] {
  return [...document.querySelectorAll<HTMLElement>("body :is(select, input, textarea)")]
    .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
    .map((el) => `${el.id || el.tagName} ${getComputedStyle(el).fontSize}`);
}

describe("under the iPhone profile", () => {
  it("is a phone to the page: a coarse pointer, 390px wide", () => {
    // without this the profile could silently not apply and every test below measure a desktop
    expect(matchMedia("(pointer: coarse)").matches).toBe(true);
    expect(document.documentElement.clientWidth).toBe(390);
  });

  it("chooses the cards", async () => {
    await show();
    expect(document.querySelector<HTMLElement>(".nx")!.dataset.arrangement).toBe("phone");
    expect(screen.getByRole("navigation", { name: "views" })).toBeTruthy();
  });
});

describe("the Live view", () => {
  it("pushes nothing sideways", async () => {
    await show();
    expect(overflowsSideways()).toBe(false);
  });

  it("gives every control a 44pt target", async () => {
    await show();
    expect(targets().length).toBeGreaterThan(3);
    expect(tooSmall()).toEqual([]);
  });

  it("shows the needs-you line as banners, a list inside the status region", async () => {
    await show();
    const banners = screen.getByRole("status", { name: "needs you" });
    expect(within(banners).getByRole("list")).toBeTruthy();
    expect(within(banners).getByText("1218_7150P entry signal")).toBeTruthy();
  });

  it("brings the row a banner is about into view when it is tapped", async () => {
    serveBook(longBook(24));
    render(<Next />);
    await settle();
    window.scrollTo(0, 0);
    const row = document.querySelector<HTMLElement>('[data-ref="late"]')!;
    // the precondition the test is worth nothing without: the row starts well out of view
    expect(row.getBoundingClientRect().top).toBeGreaterThan(window.innerHeight);
    const banners = screen.getByRole("status", { name: "needs you" });
    fireEvent.click(within(banners).getByRole("button", { name: /0917_5800P entry signal/ }));
    await new Promise((r) => setTimeout(r, 900));
    const r = row.getBoundingClientRect();
    expect(row.hasAttribute("data-revealed")).toBe(true);
    expect(r.top >= 0 && r.bottom <= window.innerHeight).toBe(true);
  });
});

describe("the Settings tab", () => {
  async function settings() {
    await show();
    fireEvent.click(within(screen.getByRole("navigation", { name: "views" }))
      .getByRole("button", { name: "Settings" }));
    await settle();
  }

  it("pushes nothing sideways", async () => {
    await settings();
    expect(overflowsSideways()).toBe(false);
  });

  it("gives every control a 44pt target, the References form's included", async () => {
    await settings();
    expect(document.querySelectorAll(".nx select").length).toBeGreaterThanOrEqual(5);
    expect(tooSmall()).toEqual([]);
  });

  it("gives the remove confirmation's buttons 44pt targets, though it is drawn outside the page", async () => {
    await settings();
    fireEvent.click(screen.getByRole("button", { name: /remove/ }));
    const dialog = await screen.findByRole("alertdialog");
    await animationsDone();
    expect(within(dialog).getAllByRole("button").length).toBeGreaterThanOrEqual(2);
    expect(tooSmall()).toEqual([]);
  });

  it("gives a refusal's toast a 44pt close button", async () => {
    await settings();
    fireEvent.change(screen.getByLabelText("code"), { target: { value: "US.SPY" } });
    fireEvent.click(screen.getByRole("button", { name: "keep it" }));
    await screen.findByText("refused by the test service");
    await animationsDone();
    expect(tooSmall()).toEqual([]);
  });

  it("sets every box in 16px text, so iOS does not zoom on focus", async () => {
    await settings();
    expect(zooms()).toEqual([]);
  });
});
