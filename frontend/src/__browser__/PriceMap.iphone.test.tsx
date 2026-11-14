/** #298 on the phone, MEASURED under Playwright's iPhone profile: there is no price map — the
 *  strike strips carry its facts per card (ADR 0023) — and a holding's sheet carries "where SPX was
 *  against my strikes" in its history, open from the start outside the session (#374), its labels
 *  inside the screen and apart. Every route the page calls
 *  is answered explicitly. Runs in the suite's `iphone` instance only. */
import { userEvent } from "@vitest/browser/context";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
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
      // every holding on record, which the closed trades' fold reads (#296, #373): none is closed
      if (path === "/positions") return ok(HOLDINGS);
      if (path === "/references") return ok([]);
    }
    unanswered.push(`${method} ${path}`);
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ detail: "not answered" }) });
  }) as unknown as typeof fetch;
}

/** The Book tab, in session or on a Sunday outside it. */
async function show(session: boolean) {
  if (!session) vi.setSystemTime(new Date("2026-11-15T17:00:00Z"));
  serve();
  render(<Next />);
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
  for (const session of [true, false]) {
    it(`has no price map ${session ? "in" : "out of"} session, even where the desk left it open`, async () => {
      await show(session);
      expect(screen.queryByRole("region", { name: "price map" })).toBeNull();
      expect(screen.queryByRole("button", { name: "price map" })).toBeNull();
    });
  }

  it("draws where SPX was against the strikes in each holding's sheet, its labels inside and apart", async () => {
    await show(false);
    const cards = [...document.querySelectorAll<HTMLElement>("article.nxp-holding")];
    expect(cards.length).toBeGreaterThan(0);
    const faults: string[] = [];
    for (const c of cards) {
      await userEvent.click(within(c).getByRole("button", { name: /^details of / }));
      const sheet = await screen.findByRole("dialog");
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
      const chart = await within(sheet).findByRole("group", { name: "SPX against the strikes" });
      const svg = await waitFor(() => chart.querySelector("svg") ?? Promise.reject(new Error("no chart yet")));
      svg.scrollIntoView({ block: "center" });
      const box = svg.getBoundingClientRect();
      const page = sheet.getBoundingClientRect();
      if (!inside(box, page)) faults.push(`${c.dataset.ref}: the chart is outside its sheet`);
      const texts = [...svg.querySelectorAll<SVGTextElement>("text")];
      for (const t of texts) if (!inside(t.getBoundingClientRect(), box)) faults.push(`${c.dataset.ref}: "${t.textContent}" outside`);
      for (let i = 0; i < texts.length; i++) {
        for (let j = i + 1; j < texts.length; j++) {
          if (overlap(texts[i]!.getBoundingClientRect(), texts[j]!.getBoundingClientRect())) {
            faults.push(`${c.dataset.ref}: "${texts[i]!.textContent}" over "${texts[j]!.textContent}"`);
          }
        }
      }
      await userEvent.click(within(sheet).getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    expect(faults).toEqual([]);
    expect(overflowsSideways()).toBe(false);
  });
});
