/** #298 on the phone, MEASURED under Playwright's iPhone profile: there is no price map — the
 *  strike strips carry its facts per card (ADR 0023) — and REVIEW's one-holding page carries "where
 *  SPX was against my strikes", its labels inside the screen and apart. Every route the page calls
 *  is answered explicitly. Runs in the suite's `iphone` instance only. */
import { userEvent } from "@vitest/browser/context";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, samplesAnswer, volAnswer } from "../testing/ownerBook";
import { overflowsSideways, settle } from "./nextBook";

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

let unanswered: string[] = [];

function serve(): void {
  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    const read = payoffAnswer(path) ?? samplesAnswer(path) ?? volAnswer(path);
    if (read) return ok(read);
    if (method === "GET") {
      if (path === "/quotes") return ok(QUOTES);
      if (path === "/monitors") return ok(MONITORS);
      if (path === "/health") return ok(health);
      if (path === "/positions/values") return ok(HOLDINGS);
      // every holding on record, which REVIEW's closed trades read (#296): none of these is closed
      if (path === "/positions") return ok(HOLDINGS);
      if (path === "/references") return ok([]);
    }
    unanswered.push(`${method} ${path}`);
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ detail: "not answered" }) });
  }) as unknown as typeof fetch;
}

async function show(view: "Live" | "Review") {
  serve();
  render(<Next />);
  await settle();
  await userEvent.click(within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name: view }));
  await settle();
  window.scrollTo(0, 0);
}

beforeEach(() => {
  unanswered = [];
  // opened on a desk, it stays shut on the phone: the phone has no price map to open
  document.cookie = "ui_price_map=open;path=/";
});

afterEach(() => {
  cleanup();
  document.cookie = "ui_price_map=;path=/";
  expect(unanswered).toEqual([]);
});

const inside = (inner: DOMRect, outer: DOMRect) =>
  inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5
  && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
const overlap = (a: DOMRect, b: DOMRect) =>
  a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

describe("the phone", () => {
  it("has no price map, in either mode, even where the desk left it open", async () => {
    await show("Live");
    expect(screen.queryByRole("region", { name: "price map" })).toBeNull();
    expect(screen.queryByRole("button", { name: "price map" })).toBeNull();
  });

  it("draws where SPX was against the strikes on each REVIEW page, its labels inside and apart", async () => {
    await show("Review");
    const pages = [...document.querySelectorAll<HTMLElement>("[data-page]")];
    expect(pages.length).toBeGreaterThan(0);
    const faults: string[] = [];
    for (const p of pages) {
      const chart = within(p).getByRole("group", { name: "SPX against the strikes" });
      const svg = chart.querySelector("svg")!;
      const box = svg.getBoundingClientRect();
      const page = p.getBoundingClientRect();
      if (!inside(box, page)) faults.push(`${p.dataset.ref}: the chart is outside its page`);
      const texts = [...svg.querySelectorAll<SVGTextElement>("text")];
      for (const t of texts) if (!inside(t.getBoundingClientRect(), box)) faults.push(`${p.dataset.ref}: "${t.textContent}" outside`);
      for (let i = 0; i < texts.length; i++) {
        for (let j = i + 1; j < texts.length; j++) {
          if (overlap(texts[i]!.getBoundingClientRect(), texts[j]!.getBoundingClientRect())) {
            faults.push(`${p.dataset.ref}: "${texts[i]!.textContent}" over "${texts[j]!.textContent}"`);
          }
        }
      }
    }
    expect(faults).toEqual([]);
    expect(overflowsSideways()).toBe(false);
  });
});
