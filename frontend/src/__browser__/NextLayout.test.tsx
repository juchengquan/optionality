/** The redesigned page at the desk, measured in a real layout engine (ADR 0008, ADR 0023).
 *  The phone is measured in `NextLayout.iphone.test.tsx`, under an iPhone profile. */
import { cleanup, render } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { overflowsSideways, serveBook, settle } from "./nextBook";

const root = () => document.querySelector<HTMLElement>(".nx")!;

async function show() {
  serveBook();
  render(<Next />);
  await settle();
}

afterEach(async () => {
  cleanup();
  document.cookie = "ui_up=;path=/;max-age=0";
  await page.viewport(1280, 900);
});

describe("the arrangement is chosen by the measured width", () => {
  it("is the desk at 1280px, with nothing pushed sideways", async () => {
    await page.viewport(1280, 900);
    await show();
    expect(root().dataset.arrangement).toBe("desk");
    expect(overflowsSideways()).toBe(false);
  });

  it("is still the desk at 900px and the phone a pixel narrower", async () => {
    await page.viewport(900, 900);
    await show();
    expect(root().dataset.arrangement).toBe("desk");
    expect(overflowsSideways()).toBe(false);
    cleanup();
    await page.viewport(899, 900);
    await show();
    expect(root().dataset.arrangement).toBe("phone");
  });

  it("re-chooses when the window is resized across the line", async () => {
    await page.viewport(1280, 900);
    await show();
    expect(root().dataset.arrangement).toBe("desk");
    await page.viewport(600, 900);
    await settle();
    expect(root().dataset.arrangement).toBe("phone");
    await page.viewport(1440, 900);
    await settle();
    expect(root().dataset.arrangement).toBe("desk");
  });

  it("fits a wide desk too", async () => {
    await page.viewport(2560, 1200);
    await show();
    expect(overflowsSideways()).toBe(false);
  });
});

/** The rule the three colour families exist for: flipping which way is up moves direction and
 *  outcome together, and moves nothing that asks for attention (ADR 0023). */
describe("the colour families", () => {
  const tokens = (names: string[]) => {
    const style = getComputedStyle(root());
    return Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n).trim()]));
  };
  const ATTENTION = ["--alarm", "--warn", "--fault", "--entry", "--chip-ink"];

  it("swaps up and down, and gain and loss with them, when red is up", async () => {
    await show();
    const green = tokens(["--up", "--down", "--gain", "--loss"]);
    expect(green["--up"]).not.toBe(green["--down"]);
    expect(green["--gain"]).toBe(green["--up"]);
    expect(green["--loss"]).toBe(green["--down"]);

    root().dataset.up = "red";
    const red = tokens(["--up", "--down", "--gain", "--loss"]);
    expect(red["--up"]).toBe(green["--down"]);
    expect(red["--down"]).toBe(green["--up"]);
    expect(red["--gain"]).toBe(red["--up"]);
    expect(red["--loss"]).toBe(red["--down"]);
  });

  it("leaves every attention colour where it was", async () => {
    await show();
    const before = tokens(ATTENTION);
    root().dataset.up = "red";
    expect(tokens(ATTENTION)).toEqual(before);
    // and none of them is either direction's colour, whichever way up
    const directions = Object.values(tokens(["--up", "--down"]));
    for (const value of Object.values(before)) expect(directions).not.toContain(value);
  });

  it("paints a fired entry signal as an alarm only when the viewer asks for that", async () => {
    await show();
    const chip = document.querySelector<HTMLElement>('[data-attention="entry"]')!;
    const alarm = getComputedStyle(root()).getPropertyValue("--alarm").trim();
    expect(getComputedStyle(chip).getPropertyValue("--chip").trim()).not.toBe(alarm);
    root().dataset.entry = "risk";
    expect(getComputedStyle(chip).getPropertyValue("--chip").trim()).toBe(alarm);
  });
});
