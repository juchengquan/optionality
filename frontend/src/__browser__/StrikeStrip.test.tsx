/** The strike strip (#297) on the desk, MEASURED in a real layout engine at 900, 1280 and 2560px:
 *  the row's compact strip and its words fit their cell — the column was sized for both by the
 *  same measuring that fits every other (ADR 0008) — and the inspector's whole strip keeps its
 *  labels inside it and clear of each other, with SPX's dot on the scale. That the table as a whole
 *  still fits with the strip's column in it is `NextDesk.test.tsx`'s, which measures every cell.
 */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import type { Entry, Holding } from "../shared/api";
import { Next } from "../Next";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, samplesAnswer, volAnswer } from "../testing/ownerBook";
import { overflowsSideways, settle } from "./nextBook";

/* The owner-shaped book, served from this file: a non-test module may not import test support. */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

const REASON = "the Provider gives no option premium to derive it from";
function bare<T extends Entry | Holding>(row: T): T {
  return { ...row, spx: null, spx_reason: REASON,
    short_strikes: row.short_strikes.map((s) => ({ ...s, points: null, sigma: null, one_sigma: null })) };
}

function serve(quotes: object[], holdings: object[]): void {
  window.fetch = ((url: string, init?: RequestInit) => {
    // the payoff beside the strip is a read, POST included, and is answered (#291)
    const payoff = payoffAnswer(String(url).replace(/^.*\/api/, ""));
    // and a holding's samples (#295), a read too: an empty list in their place would break the page
    const read = payoff ?? samplesAnswer(String(url).replace(/^.*\/api/, ""))
      // and the pace split (#333), read once when a holding is opened
      ?? volAnswer(String(url).replace(/^.*\/api/, ""));
    if (read) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(read) });
    if (init?.method && init.method !== "GET") {
      return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ detail: "refused" }) });
    }
    const path = String(url).replace(/^.*\/api/, "");
    const body = path === "/quotes" ? quotes : path === "/monitors" ? MONITORS
      : path === "/health" ? health : path === "/positions/values" ? holdings : [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

async function show(width: number, priced = true) {
  await page.viewport(width, 900);
  serve(priced ? QUOTES : QUOTES.map(bare), priced ? HOLDINGS : HOLDINGS.map(bare));
  render(<Next />);
  await settle();
}

afterEach(async () => {
  cleanup();
  await page.viewport(1280, 900);
});

const SPREADS = ["h-puts", "h-calls", "h-ic", "w-dec04", "w-dec18", "w-dec31"];
const rowOf = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;
const shown = () => [...document.querySelectorAll<HTMLElement>(".nxd-head [data-col]")].map((c) => c.dataset.col!);

const inside = (inner: DOMRect, outer: DOMRect) =>
  inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5;
const overlap = (a: DOMRect, b: DOMRect) =>
  a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

/** A row's strip cell drawn whole: the scale and its words inside the cell, nothing cut short. */
function cellFaults(id: string): string[] {
  const cell = rowOf(id).querySelector<HTMLElement>('[data-col="strip"]')!;
  const box = cell.getBoundingClientRect();
  const out: string[] = [];
  const scale = cell.querySelector<HTMLElement>(".nxs[data-compact]");
  if (!scale) return [`${id}: no strip`];
  if (!inside(scale.getBoundingClientRect(), box)) out.push(`${id}: the scale is outside its cell`);
  const words = cell.querySelector<HTMLElement>(".nxd-v")!;
  if (!inside(words.getBoundingClientRect(), box)) out.push(`${id}: the words are outside the cell`);
  if (cell.scrollWidth > cell.clientWidth + 1) out.push(`${id}: cut, ${cell.scrollWidth} > ${cell.clientWidth}`);
  if (overlap(scale.getBoundingClientRect(), words.getBoundingClientRect())) out.push(`${id}: words over the scale`);
  return out;
}

/** The inspector's strip: inside the inspector, every label inside the strip and clear of every
 *  other, and SPX's dot on the scale. */
function stripFaults(): string[] {
  const insp = document.querySelector<HTMLElement>(".nxd-inspector")!;
  const fig = within(insp).getByRole("figure", { name: "strike strip" });
  const f = fig.getBoundingClientRect();
  const out: string[] = [];
  if (!inside(f, insp.getBoundingClientRect())) out.push("the strip is outside the inspector");
  const labels = [...fig.querySelectorAll<HTMLElement>(".nxs-l")];
  for (const l of labels) if (!inside(l.getBoundingClientRect(), f)) out.push(`label ${l.textContent} outside`);
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (overlap(labels[i]!.getBoundingClientRect(), labels[j]!.getBoundingClientRect())) {
        out.push(`labels ${labels[i]!.textContent} and ${labels[j]!.textContent} overlap`);
      }
    }
  }
  const dot = fig.querySelector<HTMLElement>(".nxs-spx");
  if (dot && !inside(dot.getBoundingClientRect(), fig.querySelector<HTMLElement>(".nxs-scale")!.getBoundingClientRect())) {
    out.push("SPX's dot off the scale");
  }
  return out;
}

describe("in the rows", () => {
  for (const width of [1280, 2560]) {
    it(`at ${width}px, every spread's row draws its strip whole, inspector shut and open`, async () => {
      await show(width);
      expect(shown()).toContain("strip");
      expect(SPREADS.flatMap(cellFaults)).toEqual([]);
      fireEvent.click(within(rowOf("h-ic")).getByRole("button", { name: /./ }));
      await settle();
      if (shown().includes("strip")) expect(SPREADS.flatMap(cellFaults)).toEqual([]);
      expect(overflowsSideways()).toBe(false);
    });
  }

  it("at 900px, wherever its column is kept, draws it whole", async () => {
    await show(900);
    if (shown().includes("strip")) expect(SPREADS.flatMap(cellFaults)).toEqual([]);
    expect(overflowsSideways()).toBe(false);
  });

  it("with no derived price, a dash beside the scale, still whole", async () => {
    await show(1280, false);
    expect(SPREADS.flatMap(cellFaults)).toEqual([]);
    expect(rowOf("h-puts").querySelector('[data-col="strip"] .nxd-v')!.textContent).toBe("—");
  });
});

describe("in the inspector", () => {
  for (const width of [900, 1280, 2560]) {
    it(`at ${width}px, a condor's strip and a 4-leg holding's keep every label inside and apart`, async () => {
      await show(width);
      for (const id of ["h-calls", "h-ic", "w-dec18"]) {
        fireEvent.click(within(rowOf(id)).getByRole("button", { name: /./ }));
        await settle();
        expect(stripFaults(), `${id} at ${width}px`).toEqual([]);
      }
      expect(overflowsSideways()).toBe(false);
    });
  }
});
