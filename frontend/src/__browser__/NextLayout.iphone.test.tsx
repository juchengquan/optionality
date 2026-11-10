/** The redesigned page on a phone, under Playwright's iPhone profile (ADR 0023): touch, a coarse
 *  pointer and a 390px screen. Runs in the suite's `iphone` instance only.
 *
 *  What a phone needs that a desk does not: nothing pushed sideways, a 44pt target for every
 *  control, and 16px text in every box, below which iOS zooms the page when a box is focused.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { overflowsSideways, serveBook, settle } from "./nextBook";

async function show() {
  serveBook();
  render(<Next />);
  await settle();
}

afterEach(cleanup);

/** Every control on the page that a finger has to hit. */
function targets(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".nx :is(button, select, input, a)")]
    .filter((el) => el.getClientRects().length > 0);
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
  return [...document.querySelectorAll<HTMLElement>(".nx :is(select, input, textarea)")]
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

  it("shows the needs-you line as banners, each leading to its row", async () => {
    await show();
    const banners = screen.getByRole("status", { name: "needs you" });
    expect(banners.tagName).toBe("UL");
    expect(within(banners).getByText("1218_7150P entry signal")).toBeTruthy();
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

  it("sets every box in 16px text, so iOS does not zoom on focus", async () => {
    await settings();
    expect(zooms()).toEqual([]);
  });
});
