/** The desk's terminal measured in a real layout engine (ADR 0008, ADR 0023, #289): nothing pushed
 *  sideways from a 900px desk to a 2560px one, in either mode, with the inspector open or shut;
 *  columns dropped by measuring the room and the text rather than by any breakpoint; and the
 *  entry-style setting recolouring the fired entry row and nothing else. The behaviour is the
 *  jsdom suite's (`__tests__/NextDesk.test.tsx`).
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, samplesAnswer, volAnswer } from "../testing/ownerBook";
import { overflowsSideways, settle } from "./nextBook";

/* The owner-shaped book the desk's acceptance criteria name, served to the page. Here and not in a
   helper module beside `nextBook.ts`: only a test may import test support (check-test-support). */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

/** Every holding with an exit schedule, so REVIEW's pace columns have something to say. */
const scheduled = HOLDINGS.map((h) => ({
  ...h, schedule: { dte_at_open: 45, on_pace: 1.23, pace_gap: 0.47, target: 1, stop: 4,
    target_dte: 11, manage_by_dte: 21, reached: null, manage_by_due: false },
}));

/** Every write refused: a layout suite never changes the book. The payoff's POST is a read, and is
 *  answered (#291). */
function serveOwnerBook(extra: object[] = []): void {
  const quotes = [...QUOTES, ...extra];
  window.fetch = ((url: string, init?: RequestInit) => {
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
      : path === "/health" ? health : path === "/positions/values" ? scheduled : [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

const table = () => document.querySelector<HTMLElement>(".nxd-table")!;
const rowOf = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;
const shown = () => [...document.querySelectorAll<HTMLElement>(".nxd-head [data-col]")].map((c) => c.dataset.col!);

/** The page in the mode asked for: the clock picks one, and the switch overrides it. */
async function show(mode: "live" | "review", width: number, extra: object[] = [], height = 900) {
  await page.viewport(width, height);
  serveOwnerBook(extra);
  render(<Next />);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: mode === "live" ? "Live" : "Review" }));
  await settle();
  expect(document.querySelector<HTMLElement>(".nx")!.dataset.mode).toBe(mode);
}

async function inspect(id: string) {
  fireEvent.click(within(rowOf(id)).getByRole("button", { name: /./ }));
  await settle();
  expect(document.querySelector(".nxd-inspector")).toBeTruthy();
}

/** Any cell drawn past the table's right edge, or any figure cut short by its own cell: either one
 *  is a column that was kept without the room to draw it. The flexible column (the rule's sentence,
 *  or the name once that has dropped) gives up what it must, with an ellipsis, by design. */
function misfits(): string[] {
  const right = table().getBoundingClientRect().right;
  const flexible = shown().includes("alarm") ? "alarm" : "name";
  const out: string[] = [];
  for (const row of document.querySelectorAll<HTMLElement>(".nxd-row, .nxd-head")) {
    for (const cell of row.querySelectorAll<HTMLElement>(":scope > [data-col]")) {
      const key = cell.dataset.col!;
      if (cell.getBoundingClientRect().right > right + 0.5) out.push(`${row.dataset.ref} ${key} past the edge`);
      if (key !== flexible && cell.scrollWidth > cell.clientWidth + 1) {
        out.push(`${row.dataset.ref} ${key} cut: ${cell.scrollWidth} > ${cell.clientWidth}`);
      }
      // nothing drawn over a cell: the header's picker once sat on top of its last label
      const r = cell.getBoundingClientRect();
      const top = document.elementFromPoint(r.right - 3, r.top + r.height / 2);
      if (cell.textContent && r.width > 6 && r.height > 0 && top && !cell.contains(top)) out.push(`${row.dataset.ref ?? "header"} ${key} covered`);
    }
  }
  return out;
}

afterEach(async () => {
  cleanup();
  document.documentElement.style.fontSize = "";
  for (const n of ["ui_entry", "ui_cols_combo"]) document.cookie = `${n}=;path=/;max-age=0`;
  await page.viewport(1280, 900);
});

describe("nothing is pushed sideways, from a 900px desk to a 2560px one", () => {
  for (const mode of ["live", "review"] as const) {
    for (const width of [900, 1280, 2560]) {
      it(`at ${width}px in ${mode}, with the inspector shut and open`, async () => {
        await show(mode, width);
        expect(document.querySelector<HTMLElement>(".nx")!.dataset.arrangement).toBe("desk");
        expect(overflowsSideways()).toBe(false);
        expect(table().scrollWidth).toBeLessThanOrEqual(table().clientWidth);
        expect(misfits()).toEqual([]);

        await inspect("h-calls");
        const insp = document.querySelector<HTMLElement>(".nxd-inspector")!.getBoundingClientRect();
        // beside the table, not over it
        expect(insp.left).toBeGreaterThanOrEqual(table().getBoundingClientRect().right);
        expect(insp.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
        expect(overflowsSideways()).toBe(false);
        expect(table().scrollWidth).toBeLessThanOrEqual(table().clientWidth);
        expect(misfits()).toEqual([]);
      });
    }
  }
});

describe("the pace explained fits in the inspector (#333)", () => {
  /** Anything in the section drawn past the inspector's own box. */
  function outside(insp: HTMLElement): string[] {
    const box = insp.getBoundingClientRect();
    return [...insp.querySelectorAll<Element>(".nx-pace, .nx-pace *")]
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < box.left - 0.5 || r.right > box.right + 0.5;
      })
      .map((el) => `${el.tagName.toLowerCase()} ${el.getAttribute("class") ?? ""} ${el.textContent?.slice(0, 20)}`);
  }

  // the call spread's split declined with the route's reason and what would cover the gap; the put
  // spread's split whole — in both modes, since the inspector explains the pace in both
  for (const mode of ["live", "review"] as const) for (const width of [900, 1280, 2560]) {
    for (const id of ["h-calls", "h-puts"]) {
      it(`${id}'s at ${width}px in ${mode}`, async () => {
        await show(mode, width);
        await inspect(id);
        const insp = document.querySelector<HTMLElement>(".nxd-inspector")!;
        const pace = within(insp).getByRole("region", { name: "the pace explained" });
        await settle();
        expect(pace.querySelector("[data-split]")).toBeTruthy();
        expect(pace.getBoundingClientRect().width).toBeGreaterThan(200);
        expect(outside(insp)).toEqual([]);
        expect(insp.scrollWidth).toBeLessThanOrEqual(insp.clientWidth);
        expect(overflowsSideways()).toBe(false);
        expect(misfits()).toEqual([]);
      });
    }
  }
});

describe("the payoff at expiry fits in the inspector (#291)", () => {
  /** Its chart is drawn at the inspector's measured width: every piece of it inside the inspector's
   *  own box, and the inspector scrolling nothing sideways, from the narrowest desk to a wide one. */
  function outside(insp: HTMLElement): string[] {
    const box = insp.getBoundingClientRect();
    return [...insp.querySelectorAll<Element>(".nx-payoff, .nx-payoff *")]
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < box.left - 0.5 || r.right > box.right + 0.5;
      })
      .map((el) => `${el.tagName.toLowerCase()} ${el.getAttribute("class") ?? ""} ${el.textContent?.slice(0, 20)}`);
  }

  /** Every label drawn past the chart's own edge, where the SVG clips it: inside the inspector
   *  and still cut, which the box test above cannot see. */
  function clipped(svg: SVGSVGElement): string[] {
    const box = svg.getBoundingClientRect();
    return [...svg.querySelectorAll("text")]
      .filter((t) => {
        const r = t.getBoundingClientRect();
        return r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5;
      })
      .map((t) => t.textContent ?? "");
  }

  for (const width of [900, 1280, 2560]) {
    for (const [id, what] of [["h-ic", "a held condor"], ["w-dec18", "a watched spread"]] as const) {
      it(`${what}'s, at ${width}px`, async () => {
        await show("live", width);
        await inspect(id);
        const insp = document.querySelector<HTMLElement>(".nxd-inspector")!;
        const svg = insp.querySelector<SVGSVGElement>(".nx-payoff svg");
        // worth nothing unless the chart is there to be measured, at a usable size
        expect(svg).toBeTruthy();
        expect(svg!.getBoundingClientRect().width).toBeGreaterThan(200);
        expect(insp.querySelector("[data-marker='spx']")).toBeTruthy();
        expect(outside(insp)).toEqual([]);
        expect(clipped(svg!)).toEqual([]);
        expect(insp.scrollWidth).toBeLessThanOrEqual(insp.clientWidth);
        expect(overflowsSideways()).toBe(false);
        expect(misfits()).toEqual([]);
      });
    }
  }

  it("keeps its text its own size in the narrowest inspector, rather than shrinking it to fit", async () => {
    await show("live", 900);
    await inspect("h-ic");
    const label = document.querySelector<SVGTextElement>(".nxd-inspector [data-breakeven] text")!;
    expect(label.getBoundingClientRect().height).toBeGreaterThanOrEqual(10);
  });
});

describe("the burndown and the IV chart fit in the inspector in REVIEW (#295)", () => {
  /** Each chart drawn at the inspector's measured width: every piece inside the inspector's box,
   *  no label cut by its own SVG, nothing scrolling sideways — and the line under the burndown
   *  saying why a day is not the close when the pointer rests on it. */
  function outside(insp: HTMLElement): string[] {
    const box = insp.getBoundingClientRect();
    return [...insp.querySelectorAll<Element>(".nx-hist, .nx-hist *")]
      .filter((el) => el.getClientRects().length > 0 && !el.classList.contains("nx-hist-hit"))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < box.left - 0.5 || r.right > box.right + 0.5;
      })
      .map((el) => `${el.tagName.toLowerCase()} ${el.getAttribute("class") ?? ""} ${el.textContent?.slice(0, 20)}`);
  }
  function clipped(svg: SVGSVGElement): string[] {
    const box = svg.getBoundingClientRect();
    return [...svg.querySelectorAll("text")]
      .filter((t) => {
        const r = t.getBoundingClientRect();
        return r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5;
      })
      .map((t) => t.textContent ?? "");
  }
  /** Labels drawn over one another, which a box test cannot see either. */
  function overlapping(svg: SVGSVGElement): string[] {
    const boxes = [...svg.querySelectorAll("text")].filter((t) => t.textContent)
      .map((t) => [t.textContent!, t.getBoundingClientRect()] as const);
    const out: string[] = [];
    boxes.forEach(([a, r], i) => boxes.slice(i + 1).forEach(([b, q]) => {
      if (r.left < q.right - 1 && q.left < r.right - 1 && r.top < q.bottom - 1 && q.top < r.bottom - 1) out.push(`${a} / ${b}`);
    }));
    return out;
  }

  // the call spread's week, with a day missing its IV; and the 4-leg condor's two days, whose
  // calls end half a point of IV apart, which put their names on top of each other
  for (const width of [900, 1280, 2560]) for (const [id, days] of [["h-calls", 7], ["h-ic", 2]] as const) {
    it(`${id}'s at ${width}px`, async () => {
      await show("review", width);
      await inspect(id);
      const insp = document.querySelector<HTMLElement>(".nxd-inspector")!;
      await settle();
      const charts = [...insp.querySelectorAll<SVGSVGElement>(".nx-hist svg")];
      // worth nothing unless every chart is there to be measured, at a usable size: the burndown,
      // the IV chart and where SPX was against the strikes (#298)
      expect(charts).toHaveLength(3);
      for (const svg of charts) {
        expect(svg.getBoundingClientRect().width).toBeGreaterThan(200);
        expect(clipped(svg)).toEqual([]);
        expect(overlapping(svg)).toEqual([]);
      }
      expect(insp.querySelectorAll("[data-sample]")).toHaveLength(days);
      expect(outside(insp)).toEqual([]);
      expect(insp.scrollWidth).toBeLessThanOrEqual(insp.clientWidth);
      expect(overflowsSideways()).toBe(false);
      expect(misfits()).toEqual([]);
    });
  }

  it("says why a day is not the close when the pointer rests on it", async () => {
    await show("review", 1280);
    await inspect("h-calls");
    await settle();
    const evening = document.querySelector<SVGGElement>(".nxd-inspector [data-sample][data-timing='after-close']")!;
    // drawn hollow, at a size a pointer can find
    const mark = evening.querySelector<SVGCircleElement>("[data-mark='off-close']")!;
    expect(getComputedStyle(mark).fill).toBe(getComputedStyle(document.querySelector(".nx")!).backgroundColor);
    expect(mark.getBoundingClientRect().width).toBeGreaterThanOrEqual(6);
    await userEvent.hover(mark);
    const said = document.querySelector(".nxd-inspector .nx-hist-said")!;
    expect(said.textContent).toMatch(/not the close: observed 20:30 New York, after the 16:15 close/);
    // and anywhere on the chart picks the nearest day: the right-hand end is the last one
    const svg = document.querySelector<SVGSVGElement>(".nxd-inspector .nx-hist svg")!;
    const box = svg.getBoundingClientRect();
    await userEvent.hover(svg, { position: { x: box.width - 12, y: 10 } });
    expect(said.textContent).toMatch(/^9 Nov · 39 DTE/);
  });

  it("is one tab stop, whose arrow keys move from day to day", async () => {
    await show("review", 1280);
    await inspect("h-calls");
    await settle();
    const days = document.querySelector<HTMLElement>(".nxd-inspector .nx-hist-chart[role='group']")!;
    days.focus();
    expect(document.activeElement).toBe(days);
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    const said = document.querySelector(".nxd-inspector .nx-hist-said")!;
    expect(said.textContent).toMatch(/^4 Nov · 44 DTE/);
    // the day said is the day marked
    expect(document.querySelector(".nxd-inspector [data-pointed]")?.getAttribute("data-sample")).toBe("2026-11-04");
  });

  it("is not drawn in LIVE", async () => {
    await show("live", 1280);
    await inspect("h-calls");
    expect(document.querySelector(".nxd-inspector .nx-hist")).toBeNull();
  });
});

describe("columns are dropped as measured (ADR 0008)", () => {
  it("draws every column on a wide desk and fewer on a narrow one", async () => {
    await show("live", 2560);
    expect(shown()).toEqual(["name", "legs", "value", "pnl", "captured", "delta", "strip", "dte", "manage", "alarm"]);
    cleanup();
    await show("live", 900);
    await inspect("h-calls");
    expect(shown().length).toBeLessThan(10);
    expect(shown()[0]).toBe("name");
  });

  it("only ever gains columns as the window widens, never trades one for another", async () => {
    await show("live", 900);
    await inspect("w-dec18");
    let before = shown();
    for (let width = 940; width <= 1700; width += 40) {
      await page.viewport(width, 900);
      await settle();
      const now = shown();
      expect(before.filter((k) => !now.includes(k)), `lost at ${width}px`).toEqual([]);
      expect(misfits(), `at ${width}px`).toEqual([]);
      before = now;
    }
  });

  it("drops columns when the text grows, at the same width — which no breakpoint can see", async () => {
    await show("live", 1280);
    await inspect("h-ic");
    const at16 = shown();
    document.documentElement.style.fontSize = "22px";
    window.dispatchEvent(new Event("resize"));
    await settle();
    expect(shown().length).toBeLessThan(at16.length);
    expect(overflowsSideways()).toBe(false);
    expect(misfits()).toEqual([]);
  });

  it("moves the fill bar into the name cell when the rule's column has dropped", async () => {
    document.cookie = "ui_cols_combo=alarm;path=/";
    await show("live", 1280);
    expect(shown()).not.toContain("alarm");
    expect(rowOf("w-dec18").querySelector('[data-col="name"] [data-fill]')).toBeTruthy();
  });
});

describe("the header row", () => {
  it("stays at the top of the page while a long book scrolls under it", async () => {
    const more = Array.from({ length: 40 }, (_, i) => ({
      ...QUOTES.find((q) => q.id === "w-dec31")!, id: `more-${i}`, code: `0115_C${7000 + i * 10}`,
      strike_date: "2027-01-15",
    }));
    await show("live", 1280, more, 700);
    const head = document.querySelector<HTMLElement>(".nxd-head")!;
    expect(document.documentElement.scrollHeight).toBeGreaterThan(1400);
    window.scrollTo(0, 600);
    await settle();
    expect(Math.abs(head.getBoundingClientRect().top)).toBeLessThan(1);
    window.scrollTo(0, 0);
  });
});

describe("the bracket and the attention colours, as drawn", () => {
  /** The owner's usual setup: a delta rule under each held spread's short leg. */
  const legRule = (id: string, holding: string, code: string, type: string) => ({
    ...QUOTES.find((q) => q.id === "w-lone")!, id, code, option_type: type, strike_date: "2026-12-18",
    held: true, scope: "leg", in_combos: [], positions: [{ id: holding, name: holding }],
  });
  const underBoth = [
    legRule("r-call-leg", "h-calls", "US.SPXW261218C7300000", "CALL"),
    legRule("r-put-leg", "h-puts", "US.SPXW261218P6400000", "PUT"),
  ];

  for (const [what, extra] of [["with the fixture's rules", []], ["with rules under both spreads", underBoth]] as const) {
    it(`joins exactly the condor's two holding rows, ${what}`, async () => {
      await show("live", 1280, [...extra]);
      const parts = [...document.querySelectorAll<HTMLElement>(".nxd-bracket")]
        .map((b) => b.getBoundingClientRect()).sort((a, b) => a.top - b.top);
      expect(parts.length).toBeGreaterThan(0);
      const mid = (id: string) => { const r = rowOf(id).getBoundingClientRect(); return r.top + r.height / 2; };
      expect(Math.abs(parts[0]!.top - mid("h-calls"))).toBeLessThan(2);
      expect(Math.abs(parts[parts.length - 1]!.bottom - mid("h-puts"))).toBeLessThan(2);
      // one unbroken line, whatever rows lie between
      for (let i = 1; i < parts.length; i++) expect(parts[i]!.top).toBeLessThanOrEqual(parts[i - 1]!.bottom + 1);
    });
  }

  it("recolours only the fired entry row when entries are set to look like risk", async () => {
    const paint = () => Object.fromEntries(["w-dec04", "r-calls", "q-unknown", "w-dec18"].map((id) => {
      const row = rowOf(id);
      const chip = row.querySelector(".nx-chip");
      return [id, `${getComputedStyle(row).backgroundColor} ${chip ? getComputedStyle(chip).backgroundColor : "-"}`];
    }));
    await show("live", 1280);
    const opportunity = paint();
    cleanup();
    document.cookie = "ui_entry=risk;path=/";
    await show("live", 1280);
    const risk = paint();
    expect(risk["w-dec04"]).not.toBe(opportunity["w-dec04"]);
    // and it now looks exactly like the fired risk rule
    expect(risk["w-dec04"]).toBe(risk["r-calls"]);
    for (const id of ["r-calls", "q-unknown", "w-dec18"]) expect(risk[id]).toBe(opportunity[id]);
  });
});
