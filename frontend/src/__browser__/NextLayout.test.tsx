/** The page at the desk, measured in a real layout engine (ADR 0008, ADR 0023).
 *  The phone is measured in `NextLayout.iphone.test.tsx`, under an iPhone profile. */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { commands, page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
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

/** The desk's header with no switch in it (#375): "optionality", the spacer, and the buttons on one
 *  row at the right — no gap where the Live/Review switch stood, in session and out of it. */
describe("the header, with no switch", () => {
  const SUNDAY = new Date("2026-11-15T17:00:00Z"); // 12:00 New York, outside the session
  for (const width of [900, 1280, 2560]) for (const outside of [false, true]) {
    it(`at ${width}px ${outside ? "outside the session" : "in session"}: the title, then the buttons on one row`, async () => {
      if (outside) vi.setSystemTime(SUNDAY);
      await page.viewport(width, 900);
      await show();
      expect(root().dataset.arrangement).toBe("desk");
      const head = document.querySelector<HTMLElement>(".nx-head")!;
      const kids = [...head.children] as HTMLElement[];
      const [title, spacer, ...buttons] = kids;
      expect(kids.map((k) => k.tagName.toLowerCase() + (k.className.includes("nx-spacer") ? ".spacer" : "")))
        .toEqual(["h1", "span.spacer", "button", "button", "button", "button", "button"]);
      expect(buttons.map((b) => b.getAttribute("aria-label")!.replace(/ \(.*\)$/, "")))
        .toEqual(["save as image", "refresh now", "find and act", "add", "settings"]);
      expect(within(head).queryByRole("group")).toBeNull();
      expect(head.textContent).not.toMatch(/live|review|by the clock|your choice/i);
      const gap = parseFloat(getComputedStyle(head).columnGap);
      const box = (el: Element) => el.getBoundingClientRect();
      // no gap left where the switch stood: the spacer starts one flex gap after the title
      expect(box(spacer!).left - box(title!).right).toBeCloseTo(gap, 0);
      // the buttons on one row, one flex gap apart, the last at the header's own right edge
      const tops = new Set(buttons.map((b) => Math.round(box(b).top)));
      expect(tops.size, "the buttons wrapped").toBe(1);
      for (let i = 1; i < buttons.length; i++) {
        expect(box(buttons[i]!).left - box(buttons[i - 1]!).right, `before ${buttons[i]!.getAttribute("aria-label")}`)
          .toBeCloseTo(gap, 0);
      }
      const inner = box(head).right - parseFloat(getComputedStyle(head).paddingRight);
      expect(box(buttons.at(-1)!).right).toBeCloseTo(inner, 0);
      // and the title on that row too: one row, as tall as its tallest child and its padding
      const row = box(head).height - parseFloat(getComputedStyle(head).paddingTop)
        - parseFloat(getComputedStyle(head).paddingBottom) - 1; // its bottom border
      expect(row).toBeLessThanOrEqual(Math.max(...kids.map((k) => box(k).height)) + 0.5);
      expect(overflowsSideways()).toBe(false);
    });
  }
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
