/** The rule's short form at the desk (#388), MEASURED: the RULE column draws "|val| ≥ 4.51   2.10
 *  ↑2.41" where it drew the sentence, so it must come out narrower than the sentences would make it,
 *  at the widths the desk is used at — on the owner-shaped book the desk's table is held to.
 *
 *  "Narrower" is measured against the sentences themselves, in the cell's own font: the widest
 *  sentence the column would have had to hold (its title, which is the sentence) against the width
 *  the column was given. The phone's rule line is measured in `NextRuleShort.iphone.test.tsx`. */
import { cleanup, render } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../Next";
import { settle } from "./nextBook";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "2026-11-10 23:14:05+08:00", alarms: { label: "active", bad: false },
    fetched_at: "2026-11-10 23:14:05+08:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

function serve(): void {
  window.fetch = ((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ detail: "refused by the test service" }) });
    }
    const path = String(url).replace(/^.*\/api/, "");
    const body = path === "/quotes" ? QUOTES : path === "/monitors" ? MONITORS
      : path === "/health" ? health : path === "/positions/values" ? HOLDINGS : [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
}

/** The narrowest window, in 40px steps, that drew the rule column beside the other ten with the
 *  sentences, on this book: measured by drawing the sentences in the column (#388). Only 40px more,
 *  because the book's quarantined rule says why at length, and that line is the column's widest
 *  either way; its RULES alone need a third less room. */
const SENTENCE_WIDTH = 1680;

afterEach(async () => {
  cleanup();
  await page.viewport(1280, 900);
});

/** The width `text` takes in `like`'s font, on one line. */
function widthOf(text: string, like: Element): number {
  const probe = document.createElement("span");
  const style = getComputedStyle(like);
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${style.font};letter-spacing:${style.letterSpacing}`;
  probe.textContent = text;
  document.body.append(probe);
  const w = probe.getBoundingClientRect().width;
  probe.remove();
  return w;
}

/** The rule column survives narrowing LAST (ADR 0008), so at 1280 and 1440 the owner's book has no
 *  room for it beside the other ten: it is measured there with the columns before it in the
 *  survival order hidden, as a viewer may hide them — the width it is then given is what its
 *  widest line needs (`charsOf`), short or sentence. */
const HIDE = ["captured", "dte", "legs", "manage", "pace_gap", "strip"];

describe("the desk's RULE column, short (#388)", () => {
  afterEach(() => { document.cookie = "ui_cols_combo=;path=/;max-age=0"; });

  for (const width of [1280, 1440]) {
    it(`is narrower at ${width}px than its sentences would make it, and fits every short line`, async () => {
      await page.viewport(width, 900);
      document.cookie = `ui_cols_combo=${HIDE.join(".")};path=/`;
      serve();
      render(<Next />);
      await settle();
      const head = document.querySelector(".nxd-head [data-col=\"alarm\"]");
      expect(head, "the rule column is drawn").not.toBeNull();
      const drawn = [...document.querySelectorAll<HTMLElement>(".nxd-row [data-col=\"alarm\"] .nxd-v")];
      expect(drawn.length).toBeGreaterThan(3);
      // the column is the table's last, so it stretches to the edge: what it NEEDS is its widest line
      const need = (rows: HTMLElement[], pick: (v: HTMLElement) => string) => Math.max(...rows.map((v) => widthOf(pick(v), v)));
      const rules = drawn.filter((v) => v.closest(".nxd-row")!.getAttribute("data-kind") === "rule");
      const short = need(drawn, (v) => v.textContent!), sentences = need(drawn, (v) => v.title);
      const shortRules = need(rules, (v) => v.textContent!), sentenceRules = need(rules, (v) => v.title);
      console.log(`#388 at ${width}px: the column needs ${Math.round(short)}px where its sentences needed ${Math.round(sentences)}px `
        + `(a quarantined rule's reason is the widest); its rules alone ${Math.round(shortRules)}px where they needed ${Math.round(sentenceRules)}px`);
      for (const v of drawn) expect(v.scrollWidth, v.textContent!).toBeLessThanOrEqual(v.clientWidth + 1);
      expect(short).toBeLessThan(sentences);
      expect(shortRules).toBeLessThan(sentenceRules * 0.8);
    });
  }

  it("is drawn beside every other column from a narrower window than before", async () => {
    // the narrowest window, in steps of 40px, that draws all eleven columns
    let first: number | null = null;
    serve();
    render(<Next />);
    for (let width = 1280; width <= 2560 && first === null; width += 40) {
      await page.viewport(width, 900);
      await settle();
      if (document.querySelector(".nxd-head [data-col=\"alarm\"]")) first = width;
    }
    console.log(`#388 every column drawn from ${first}px`);
    expect(first).not.toBeNull();
    expect(first!).toBeLessThan(SENTENCE_WIDTH);
  });
});
