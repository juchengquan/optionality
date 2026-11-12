/** Saving the redesigned page as an image, from the phone (#300, ADR 0023), under Playwright's
 *  iPhone profile. The picture is B's cards, drawn again off screen at the picture's own width —
 *  so every phone gives the same picture of one book — without a control in it and with privacy
 *  honoured. The fills and the attention chips are found in that tree, and their pixels in the
 *  delivered PNG must be painted: `Rasterize.test.tsx`'s proof, carried over to this page.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../next/Next";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";
import { settle } from "./nextBook";
import { catchShare, CONTROLS, decode, forgetShare, placeIn, still } from "./picture";

/** Every node handed to the rasterizer, with its text as it stood then (NextSnapshot.test.tsx). */
const captured = vi.hoisted(() => [] as { node: HTMLElement; text: string }[]);
vi.mock("html-to-image", async (orig) => {
  const real = await orig<typeof import("html-to-image")>();
  return {
    ...real,
    toBlob: (node: HTMLElement, options?: object) => {
      captured.push({ node, text: node.textContent ?? "" });
      return real.toBlob(node, options);
    },
  };
});

/** A sweep slower than any test, so no poll lands between the press and the file. */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 600, expired_retention_days: 7, manage_by_dte: 21 },
};

/** Every route the page calls in either mode, answered by name, every request kept. REVIEW's
 *  pages ask for each holding's samples, so those are answered too — with nothing recorded. */
function serve(): string[] {
  const asked: string[] = [];
  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    asked.push(`${method} ${path}`);
    const routes: Record<string, unknown> = {
      "/quotes": QUOTES, "/monitors": MONITORS, "/health": health, "/positions/values": HOLDINGS,
      "/references": [],
    };
    const samples = method === "GET" && /^\/positions\/[^/]+\/samples$/.test(path);
    const known = samples || (method === "GET" && path in routes);
    const body = samples ? { levels: null, plan: [], samples: [] } : routes[path];
    return Promise.resolve({
      ok: known, status: known ? 200 : 404,
      json: () => Promise.resolve(known ? body : { detail: `${method} ${path} is not served here` }),
    });
  }) as unknown as typeof fetch;
  return asked;
}

async function show(view: "Live" | "Review" = "Live"): Promise<string[]> {
  const asked = serve();
  render(<Next />);
  await settle();
  await userEvent.click(within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name: view }));
  await settle();
  return asked;
}

const save = () => screen.getByRole("button", { name: "save as image" });
const cardIn = (root: ParentNode, id: string) =>
  [...root.querySelectorAll<HTMLElement>(".nxp-card[data-ref]")].find((c) => c.dataset.ref === id)!;

afterEach(() => {
  cleanup();
  captured.length = 0;
  forgetShare();
  document.cookie = "ui_privacy=;path=/;max-age=0";
});

describe("saving the phone's cards as an image", () => {
  it("is a target a finger can hit", async () => {
    await show();
    const r = save().getBoundingClientRect();
    expect(r.width).toBeGreaterThanOrEqual(44);
    expect(r.height).toBeGreaterThanOrEqual(44);
  });

  it("paints the progress bars and the attention chips, in their own colours", async () => {
    await show();
    const shared = catchShare();
    await userEvent.click(save());
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    const root = still()!;
    expect(captured[0]!.node, "the file was made from something other than the picture's tree").toBe(root);
    const png = await decode(shared.file()!);
    const ratio = png.w / root.scrollWidth;
    const at = (el: Element, dx?: number) => png.at(...placeIn(root, el, ratio, dx));

    // the fired entry signal's card, a calm watched spread's card, and the ringing risk rule
    // inside its holding's card
    const entry = cardIn(root, "w-dec04");
    const calm = cardIn(root, "w-dec31");
    const ringing = [...root.querySelectorAll<HTMLElement>(".nxp-rule[data-ref]")].find((r) => r.dataset.ref === "r-calls")!;
    const bar = (card: HTMLElement) => at(card.querySelector(".nxp-progress > span")!);
    const chip = (el: HTMLElement) => at(el.querySelector(".nx-chip")!, 3);
    const ground = png.at(4, 4);

    for (const [name, px] of [["entry bar", bar(entry)], ["calm bar", bar(calm)],
      ["entry chip", chip(entry)], ["alarm chip", chip(ringing)]]) {
      expect(px, `the ${name} came out transparent`).not.toMatch(/,0$/);
      expect(px, `the ${name} is the page's own ground — it was not painted`).not.toBe(ground);
    }
    expect(chip(entry), "the entry chip and the alarm chip are one colour").not.toBe(chip(ringing));
    expect(bar(entry), "a fired bar is painted as a calm one").not.toBe(bar(calm));
    shared.release();
  });

  it("is the picture's own width, not the phone's, and carries no control", async () => {
    await show();
    const shared = catchShare();
    await userEvent.click(save());
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    const root = still()!;
    expect(root.dataset.arrangement).toBe("phone");
    expect(root.getBoundingClientRect().width).toBe(420);
    expect([...root.querySelectorAll<HTMLElement>(CONTROLS)].map((el) => el.outerHTML.slice(0, 80))).toEqual([]);
    for (const id of ["h-puts", "h-calls", "h-ic", "w-dec04", "w-dec31", "w-lone"]) {
      expect(cardIn(root, id), `${id} is not in the picture`).toBeTruthy();
    }
    expect(root.textContent, "the quarantined rule is left out").toContain("quarantined");
    shared.release();
  });

  for (const view of ["Live", "Review"] as const) {
    it(`hides every $ amount and every contract count under privacy, in ${view.toUpperCase()}`, async () => {
      document.cookie = "ui_privacy=on;path=/";
      await show(view);
      const shared = catchShare();
      await userEvent.click(save());
      await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
      expect(captured, "one capture per press").toHaveLength(1);
      expect(captured[0]!.node, "the file was made from something other than the picture's tree").toBe(still());
      const text = captured[0]!.text;
      expect(text, "no P&L is drawn at all, so privacy proves nothing").toContain("$•••");
      expect(text).not.toMatch(/\$\s*[+-]?\d/);
      expect(text).not.toMatch(/[+-]\$\d/);
      expect(text).not.toMatch(/×\s*\d/);
      if (view === "Review") expect(text, "REVIEW's count of contracts is not in the picture").toContain("×•••");
      shared.release();
    });
  }

  it("asks the service for nothing, and takes the tree down when it is done", async () => {
    const asked = await show("Review");
    await settle();
    const before = asked.length;
    const shared = catchShare();
    await userEvent.click(save());
    await expect.poll(() => shared.file(), { timeout: 8000 }).toBeTruthy();
    shared.release();
    await expect.poll(() => document.querySelector(".nx-still-stage"), { timeout: 4000 }).toBeNull();
    await settle();
    // REVIEW's charts read samples: the picture draws none, so it asks for none
    expect(asked.slice(before), "the press asked the service for something").toEqual([]);
  });
});
