/** The page's words, over the WHOLE page (the owner's standard of 2026-11-16, parts F, G and N; ADR
 *  0023): every place `testing/pageWalk.tsx` opens, on the desk and the phone, in session and out of
 *  it, read as it is said — text, and every title and aria-label (`saidBy`):
 *
 *  - "rule", never "Monitor" (part G): the API's word, not the page's;
 *  - every clock carries its zone (part F): `16:14 ET` for the market's, `21:04 SGT` for the
 *    viewer's, and never a bare `+08:00`;
 *  - never an ISO date (part F): an expiry is `261231` where it is dense and `Thu 31 Dec` in prose;
 *  - no raw error (part N): never "Failed to fetch" or "ECONNREFUSED" on screen.
 *
 *  Each check is a function of the text, held by its own self-test below so a guard that has gone
 *  blind fails rather than passes.
 */
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saidBy } from "../testing/hyphens";
import { MONDAY, SUNDAY, walkDesk, walkPhone, type Read } from "../testing/pageWalk";
import { CHECKS } from "../testing/words";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const n of ["ui_arrangement", "ui_price_map", "ui_privacy"]) document.cookie = `${n}=;path=/;max-age=0`;
});

function reading(): { said: string[]; read: Read } {
  const said: string[] = [];
  const read: Read = (where, root) => {
    const text = saidBy(root);
    for (const [name, check] of Object.entries(CHECKS)) said.push(...check(text).map((s) => `${where} — ${name}: ${s}`));
  };
  return { said, read };
}

describe("the checks see what they look for (each fails on a planted fault)", () => {
  it("a clock with no zone, and none with one", () => {
    expect(CHECKS["a clock with no zone"]!("valued at 21:04")).toHaveLength(1);
    expect(CHECKS["a clock with no zone"]!("fetched at 21:04:37 · screen")).toHaveLength(1);
    for (const ok of ["valued at 21:04 SGT", "16:14 ET", "08:04:37 ET", "17:59 GMT-5", "Mon 16 Nov 2026 10:00 ET",
      "observed 20:30 ET, after the 16:15 ET close", "7561.67", "1:2 ratio"]) {
      expect(CHECKS["a clock with no zone"]!(ok), ok).toEqual([]);
    }
  });

  it("an offset, an ISO date, Monitor and a raw error", () => {
    expect(CHECKS["an offset for a zone"]!("fetched at 2026-11-16 21:04:37+08:00")).toHaveLength(1);
    expect(CHECKS["an ISO date"]!("expiry 2026-12-31")).toHaveLength(1);
    expect(CHECKS["an ISO date"]!("1231_-C8050+C8100 · 261231 · Thu 31 Dec")).toEqual([]);
    expect(CHECKS["Monitor, where the page says rule"]!("Record holding + 2 Monitors")).toHaveLength(1);
    expect(CHECKS["Monitor, where the page says rule"]!("Record holding + 2 rules")).toEqual([]);
    expect(CHECKS["a raw error"]!("the holdings could not be valued — Failed to fetch")).toHaveLength(1);
    expect(CHECKS["a raw error"]!("moomoo call failed: connect ECONNREFUSED 127.0.0.1:33333")).toHaveLength(1);
  });
});

describe("the page's words, everywhere it draws them", () => {
  for (const [when, now] of [["in session", MONDAY], ["outside the session", SUNDAY]] as const) {
    it(`on the desk, ${when}`, async () => {
      const { said, read } = reading();
      await walkDesk(read, now);
      expect(said).toEqual([]);
    }, 60_000);

    it(`on the phone, ${when}`, async () => {
      const { said, read } = reading();
      await walkPhone(read, now);
      expect(said).toEqual([]);
    }, 60_000);
  }
});
