/** The strike strip (#297) on the phone, MEASURED under Playwright's iPhone profile — touch,
 *  `isMobile`, a 390px screen — on the owner-shaped book: every card's strip and the sheet's sit
 *  inside their card and the screen, push nothing sideways, keep each label inside the strip and
 *  clear of every other, and put SPX's dot on the scale. With no derived price the same strikes
 *  and Δ are drawn and the reason wraps inside the card. Runs in the suite's `iphone` instance.
 */
import { userEvent } from "@vitest/browser/context";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Entry, Holding } from "../shared/api";
import { Next } from "../next/Next";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, samplesAnswer, volAnswer, served } from "../testing/ownerBook";
import { overflowsSideways, settle } from "./nextBook";

afterEach(cleanup);

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
    // and REVIEW's samples (#295), a read too: an empty list in their place would break the page
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

/** A debit put spread on the watchlist, bought at 6950 and sold at 6900: its SHORT strike is the
 *  outermost mark, so its label — strike and Δ, the widest on a strip — sits at the scale's edge. */
const DEBIT = {
  ...QUOTES.find((q) => q.id === "w-dec04")!, id: "w-debit", code: "1204_P6950D", strike_date: "2026-12-04",
  legs: [{ sign: 1, option_type: "PUT", strike: 6950 }, { sign: -1, option_type: "PUT", strike: 6900 }],
  short_strikes: [served("2026-12-04", "PUT", 6900, -0.481, 38, 7100.25)], spx: 7100.25,
  triggered: false, fill: 40,
};

async function show(priced = true) {
  serve(priced ? [...QUOTES, DEBIT] : QUOTES.map(bare), priced ? HOLDINGS : HOLDINGS.map(bare));
  render(<Next />);
  await settle();
  await userEvent.click(within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name: "Live" }));
  await settle();
  window.scrollTo(0, 0);
}

const SPREADS = ["h-puts", "h-calls", "h-ic", "w-dec04", "w-dec18", "w-dec31"];
const PRICED = [...SPREADS, "w-debit"];
const card = (ref: string) =>
  [...document.querySelectorAll<HTMLElement>(".nxp-card[data-ref]")].find((el) => el.dataset.ref === ref)!;

const inside = (inner: DOMRect, outer: DOMRect) =>
  inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5;
const overlap = (a: DOMRect, b: DOMRect) =>
  a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

/** Everything wrong with one strip's geometry, in words: a strip outside its box or the screen, a
 *  label outside the strip, two labels on top of each other, a dot off the scale. */
function faults(fig: HTMLElement, box: HTMLElement): string[] {
  const out: string[] = [];
  const edge = document.documentElement.clientWidth;
  const f = fig.getBoundingClientRect();
  if (!inside(f, box.getBoundingClientRect())) out.push(`strip ${f.left}–${f.right} outside its box`);
  if (f.left < 0 || f.right > edge + 0.5) out.push(`strip ${f.left}–${f.right} past the screen`);
  const labels = [...fig.querySelectorAll<HTMLElement>(".nxs-l")];
  if (labels.length === 0) out.push("no labels drawn");
  for (const l of labels) {
    if (!inside(l.getBoundingClientRect(), f)) out.push(`label ${l.textContent} outside the strip`);
  }
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (overlap(labels[i]!.getBoundingClientRect(), labels[j]!.getBoundingClientRect())) {
        out.push(`labels ${labels[i]!.textContent} and ${labels[j]!.textContent} overlap`);
      }
    }
  }
  const words = fig.querySelector<HTMLElement>(".nxs-words")!;
  if (!inside(words.getBoundingClientRect(), f)) out.push("the words reach past the strip");
  const dot = fig.querySelector<HTMLElement>(".nxs-spx");
  if (dot && !inside(dot.getBoundingClientRect(), fig.querySelector<HTMLElement>(".nxs-scale")!.getBoundingClientRect())) {
    out.push("SPX's dot off the scale");
  }
  return out;
}

describe("on the cards", () => {
  it("every held and watched spread's card has a strip that fits it, pushing nothing sideways", async () => {
    await show();
    for (const ref of PRICED) {
      const fig = within(card(ref)).getByRole("figure", { name: "strike strip" });
      expect(faults(fig, card(ref)), ref).toEqual([]);
      expect(fig.querySelector(".nxs-spx"), ref).toBeTruthy();
    }
    expect(overflowsSideways()).toBe(false);
  });

  it("keeps every label inside its strip and apart when the reader's text is larger", async () => {
    // a larger text size widens every label while the scale stays the card's width: the scale's
    // padding is what keeps a label centred on the outermost mark inside the strip
    document.documentElement.style.fontSize = "24px";
    try {
      await show();
      for (const ref of PRICED) {
        const fig = within(card(ref)).getByRole("figure", { name: "strike strip" });
        expect(faults(fig, card(ref)), ref).toEqual([]);
      }
      expect(overflowsSideways()).toBe(false);
    } finally {
      document.documentElement.style.fontSize = "";
    }
  });

  it("with no derived price, keeps its strikes and Δ, and its reason wraps inside the card", async () => {
    await show(false);
    for (const ref of SPREADS) {
      const fig = within(card(ref)).getByRole("figure", { name: "strike strip" });
      expect(faults(fig, card(ref)), ref).toEqual([]);
      expect(fig.querySelector(".nxs-spx"), ref).toBeNull();
      expect(fig.textContent, ref).toContain(REASON);
    }
    expect(overflowsSideways()).toBe(false);
  });

  it("takes no tap from the card: a tap on the strip opens the card's sheet", async () => {
    await show();
    const fig = within(card("h-puts")).getByRole("figure", { name: "strike strip" });
    fig.scrollIntoView({ block: "center" });
    const r = fig.getBoundingClientRect();
    expect(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.getAttribute("aria-label"))
      .toBe("details of 1218_P6400");
  });
});

describe("in the detail sheet", () => {
  it("draws the 4-leg condor's strip inside the sheet", async () => {
    await show();
    window.scrollTo(0, 400);
    await settle();
    await userEvent.click(within(card("h-ic")).getByRole("button", { name: /details of/ }));
    const sheet = await screen.findByRole("dialog");
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    await new Promise((r) => setTimeout(r, 50));
    const fig = within(sheet).getByRole("figure", { name: "strike strip" });
    expect(faults(fig, sheet)).toEqual([]);
    expect(overflowsSideways()).toBe(false);
  });
});
