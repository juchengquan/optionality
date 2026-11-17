/** #298 on the phone, MEASURED under Playwright's iPhone profile: there is no price map — the
 *  strike strips carry its facts per card (ADR 0023). Every route the page calls
 *  is answered explicitly. Runs in the suite's `iphone` instance only. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, samplesAnswer, volAnswer, watchSamplesAnswer } from "../testing/ownerBook";
import { settle } from "./nextBook";

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21, display_tz: "Asia/Singapore" },
};

let unanswered: string[] = [];

function serve(): void {
  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    const read = payoffAnswer(path) ?? samplesAnswer(path) ?? watchSamplesAnswer(path) ?? volAnswer(path);
    if (read) return ok(read);
    if (method === "GET") {
      if (path === "/quotes") return ok(QUOTES);
      if (path === "/monitors") return ok(MONITORS);
      if (path === "/health") return ok(health);
      if (path === "/positions/values") return ok(HOLDINGS);
      // every holding on record, which the closed trades' fold reads (#296, #373): none is closed
      if (path === "/positions") return ok(HOLDINGS);
      if (path === "/references") return ok([]);
      // each rule's last close, read out of the session (#402)
      if (path === "/monitors/closes") return ok([]);
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

describe("the phone", () => {
  for (const session of [true, false]) {
    it(`has no price map ${session ? "in" : "out of"} session, even where the desk left it open`, async () => {
      await show(session);
      expect(screen.queryByRole("region", { name: "price map" })).toBeNull();
      expect(screen.queryByRole("button", { name: "price map" })).toBeNull();
    });
  }
});
