/** The page's words, over the WHOLE page (the owner's standard of 2026-11-16, parts F, G and N; ADR
 *  0023): every place `testing/pageWalk.tsx` opens, on the desk and the phone, in session and out of
 *  it, read as it is said — text, and every title and aria-label (`saidBy`):
 *
 *  - "rule", never "Monitor" (part G): the API's word, not the page's;
 *  - every clock carries its zone (part F): `16:14 ET` for the market's, `21:04 SGT` for the
 *    viewer's, and never a bare `+08:00`;
 *  - never an ISO date (part F), and since 2026-11-17 every date YYYYMMDD: `20261231`, never `261231`
 *    or `Thu 31 Dec`, on the desk and the phone alike — `Mon 20261116 20:15 ET` beside a time;
 *  - no raw error (part N): never "Failed to fetch" or "ECONNREFUSED" on screen.
 *
 *  Each check is a function of the text, held by its own self-test below so a guard that has gone
 *  blind fails rather than passes.
 */
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saidBy } from "../testing/hyphens";
import { MONDAY, SUNDAY, walkDesk, walkPhone, type Read } from "../testing/pageWalk";
import { CHECKS, DATE_CHECKS, textsOf, wordsOf } from "../testing/words";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const n of ["ui_arrangement", "ui_price_map", "ui_privacy"]) document.cookie = `${n}=;path=/;max-age=0`;
});

function reading(): { said: string[]; read: Read } {
  const said: string[] = [];
  const read: Read = (where, root) => {
    const text = wordsOf(root, saidBy);
    for (const [name, check] of Object.entries(CHECKS)) said.push(...check(text).map((s) => `${where} — ${name}: ${s}`));
    // a date's checks read the whole and each node apart, where text run together hides six digits
    const nodes = textsOf(root);
    for (const [name, check] of Object.entries(DATE_CHECKS)) {
      said.push(...[...new Set([...check(text), ...check(nodes)])].map((s) => `${where} — ${name}: ${s}`));
    }
  };
  return { said, read };
}

describe("the checks see what they look for (each fails on a planted fault)", () => {
  it("a clock with no zone, and none with one", () => {
    expect(CHECKS["a clock with no zone"]!("valued at 21:04")).toHaveLength(1);
    expect(CHECKS["a clock with no zone"]!("fetched at 21:04:37 · screen")).toHaveLength(1);
    // only the walk's two zones: another zone's name, or capitals that are no zone, is no mark
    for (const bad of ["21:04 EST", "17:59 GMT-5", "21:04 SG", "16:14 CLOSE"]) {
      expect(CHECKS["a clock with no zone"]!(bad), bad).toHaveLength(1);
    }
    for (const ok of ["valued at 21:04 SGT", "16:14 ET", "08:04:37 ET", "Mon 16 Nov 2026 10:00 ET",
      "observed 20:30 ET, after the 16:15 ET close", "7561.67", "1:2 ratio"]) {
      expect(CHECKS["a clock with no zone"]!(ok), ok).toEqual([]);
    }
  });

  it("an offset, an ISO date, Monitor and a raw error", () => {
    expect(CHECKS["an offset for a zone"]!("fetched at 2026-11-16 21:04:37+08:00")).toHaveLength(1);
    expect(CHECKS["an ISO date"]!("expiry 2026-12-31")).toHaveLength(1);
    expect(CHECKS["an ISO date"]!("1231_-C8050+C8100 · 20261231 · 20261231")).toEqual([]);
    expect(CHECKS["Monitor, where the page says rule"]!("Record holding + 2 Monitors")).toHaveLength(1);
    expect(CHECKS["Monitor, where the page says rule"]!("Record holding + 2 rules")).toEqual([]);
    expect(CHECKS["a raw error"]!("the holdings could not be valued — Failed to fetch")).toHaveLength(1);
    expect(CHECKS["a raw error"]!("moomoo call failed: connect ECONNREFUSED 127.0.0.1:33333")).toHaveLength(1);
  });

  it("a date written any way but YYYYMMDD (2026-11-17)", () => {
    for (const bad of ["Thu 31 Dec · 45 DTE", "expired 6 Nov", "as of the close, Fri 13 Nov 16:14 ET", "on Dec 31",
      "261231 · 45 DTE", "261218 6800P", "expired 261106"]) {
      expect([...DATE_CHECKS["a date in words"]!(bad), ...DATE_CHECKS["a six-digit date"]!(bad)], bad).toHaveLength(1);
    }
    for (const ok of ["20261231 · 45 DTE", "20261218 6800P", "Mon 20261116 20:15 ET", "US.SPXW261231C8100000",
      "1231_8050", "1218-6800", "261231_8050", "+$261,218", "7416.62", "12 DTE", "in 24d", "3 legs", "Dec rules"]) {
      expect([...DATE_CHECKS["a date in words"]!(ok), ...DATE_CHECKS["a six-digit date"]!(ok)], ok).toEqual([]);
    }
  });

  it("reads each node apart, where the page's text runs together", () => {
    const root = document.createElement("div");
    root.innerHTML = "<span>261218</span><span>7150P</span>";
    expect(DATE_CHECKS["a six-digit date"]!(root.textContent ?? "")).toEqual([]);
    expect(DATE_CHECKS["a six-digit date"]!(textsOf(root))).toHaveLength(1);
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
