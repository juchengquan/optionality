/** The redesigned page at the desk, measured in a real layout engine (ADR 0008, ADR 0023).
 *  The phone is measured in `NextLayout.iphone.test.tsx`, under an iPhone profile. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { commands, page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { contrast, oklab, overflowsSideways, serveBook, settle, token } from "./nextBook";

const root = () => document.querySelector<HTMLElement>(".nx")!;

async function show() {
  serveBook();
  render(<Next />);
  await settle();
}

afterEach(async () => {
  cleanup();
  document.cookie = "ui_up=;path=/;max-age=0";
  document.cookie = "ui_privacy=;path=/;max-age=0";
  await commands.colorScheme("light");
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

  for (const width of [320, 899]) {
    it(`pushes nothing sideways at ${width}px either`, async () => {
      await page.viewport(width, 900);
      await show();
      expect(root().dataset.arrangement).toBe("phone");
      expect(overflowsSideways()).toBe(false);
    });
  }

  it("fits a wide desk too", async () => {
    await page.viewport(2560, 1200);
    await show();
    expect(overflowsSideways()).toBe(false);
  });
});

/** The rule the three colour families exist for: flipping which way is up moves direction and
 *  outcome together, and moves nothing that asks for attention (ADR 0023). */
describe("the colour families", () => {
  const tokens = (names: string[]) => Object.fromEntries(names.map((n) => [n, token(root(), n)]));
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

  for (const scheme of ["light", "dark"] as const) {
    it(`leaves every attention colour where it was, in the ${scheme} scheme`, async () => {
      await commands.colorScheme(scheme);
      await show();
      expect(matchMedia("(prefers-color-scheme: dark)").matches).toBe(scheme === "dark");
      const before = tokens(ATTENTION);
      root().dataset.up = "red";
      expect(tokens(ATTENTION)).toEqual(before);
    });

    /** Not merely different strings: far enough apart to be told apart at a glance, and apart in
     *  LIGHTNESS too, as ADR 0023 says — so a viewer who cannot tell the hues apart still can. */
    it(`keeps every attention colour well away from up and from down, in the ${scheme} scheme`, async () => {
      await commands.colorScheme(scheme);
      await show();
      const near: string[] = [];
      for (const up of ["green", "red"]) {
        root().dataset.up = up;
        for (const direction of ["--up", "--down"]) {
          const d = oklab(token(root(), direction));
          for (const name of ["--alarm", "--warn", "--fault", "--entry"]) {
            const t = oklab(token(root(), name));
            const dE = Math.hypot(t.L - d.L, t.a - d.a, t.b - d.b);
            if (dE < 0.15 || Math.abs(t.L - d.L) < 0.08) {
              near.push(`${name} vs ${direction} (up ${up}): ΔE ${dE.toFixed(3)}, ΔL ${(t.L - d.L).toFixed(3)}`);
            }
          }
        }
      }
      expect(near).toEqual([]);
    });
  }

  for (const scheme of ["light", "dark"] as const) {
    /** Readable, not merely distinct: a chip's text against its fill at the 4.5:1 that small text
     *  needs, and a glyph or a border against the page at the 3:1 a graphic needs (WCAG 2.2). */
    it(`keeps every chip readable and every glyph visible, in the ${scheme} scheme`, async () => {
      await commands.colorScheme(scheme);
      await show();
      const page = token(root(), "--background");
      const weak: string[] = [];
      for (const [fill, ink] of [["--alarm", "--chip-ink"], ["--fault", "--chip-ink"],
        ["--entry", "--chip-ink"], ["--warn", "--warn-ink"]]) {
        const text = contrast(token(root(), fill!), token(root(), ink!));
        if (text < 4.5) weak.push(`${ink} on ${fill}: ${text.toFixed(2)}:1`);
        const glyph = contrast(token(root(), fill!), page);
        if (glyph < 3) weak.push(`${fill} on the page: ${glyph.toFixed(2)}:1`);
      }
      expect(weak).toEqual([]);
    });
  }

  it("draws the dark scheme from colours of its own", async () => {
    await commands.colorScheme("light");
    await show();
    const light = tokens(ATTENTION);
    cleanup();
    await commands.colorScheme("dark");
    await show();
    expect(tokens(ATTENTION)["--alarm"]).not.toBe(light["--alarm"]);
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

describe("privacy, in a real browser", () => {
  it("leaves no money anywhere on the page, and keeps the share captured", async () => {
    document.cookie = "ui_privacy=on;path=/";
    await show();
    const page = root().textContent!;
    expect(page).not.toMatch(/\$\s*[\d,]/);
    for (const m of document.querySelectorAll("[data-money]")) expect(m.textContent).not.toMatch(/\d/);
    expect(page).toContain("captured 60%");
  });
});

describe("the desk's Settings panel, drawn outside the page", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`draws each glyph in its kind's colour, as the line does, in the ${scheme} scheme`, async () => {
      await commands.colorScheme(scheme);
      await show();
      const onLine = document.querySelector('.nx-needs [data-kind="fault"] svg.nx-glyph')!;
      fireEvent.click(screen.getByRole("button", { name: "settings" }));
      const panel = await screen.findByRole("dialog", { name: "Settings" });
      // the panel is a portal: outside .nx, where the colour tokens were not
      expect(panel.closest(".nx")).toBeNull();
      const inPanel = panel.querySelector('[data-testid="needs"] [data-kind="fault"] svg.nx-glyph')!;
      expect(getComputedStyle(inPanel).color).toBe(getComputedStyle(onLine).color);
      expect(getComputedStyle(inPanel).color).not.toBe(getComputedStyle(panel).color);
    });
  }
});
