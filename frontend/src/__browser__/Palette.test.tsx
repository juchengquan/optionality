import { render } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";
import { CONTRACT_VERSION } from "../contract";

/** The palette and the type scale, measured.
 *
 *  The alarm colours arrived with the first htmx version as Bootstrap's alert backgrounds
 *  (#fff3cd, #f8d7da) and outlived three rewrites, so the most loaded thing on the screen
 *  was the only part still in a foreign dialect. These assert the family rather than the
 *  values: a hex colour cannot pass them, and neither can a hue from somewhere else.
 */

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "09:00" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
  contract_version: CONTRACT_VERSION,
};
const leg = {
  id: "m1", code: "US.SPXW261120C8100000", field: "option_delta", threshold: 0.2,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-20",
  dte: 57, fill: 84, scope: "leg", positions: [{ id: "p1", name: "1120_b_8100" }],
  cost_to_close: 3.75, entry: null, pnl: null, error: "unknown contract",
  snapshot: { name: "SPXW 261120 8100.00C", option_delta: 0.1685, mid_price: 31.5 },
};

async function show() {
  window.fetch = ((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        String(url).endsWith("/quotes") ? [leg] : String(url).endsWith("/monitors") ? [] : health),
    })) as unknown as typeof fetch;
  render(<App />);
  await new Promise((r) => setTimeout(r, 200));
}

/** Hue out of an oklch token. Returns null for anything that is not oklch — which is the
 *  point: a leftover hex value fails rather than being quietly accepted. */
function hueOf(token: string): number | null {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const m = /^oklch\(\s*[\d.]+%?\s+[\d.]+\s+([\d.]+)/.exec(raw);
  return m ? Number(m[1]) : null;
}

afterEach(async () => { document.body.innerHTML = ""; await page.viewport(1280, 900); });

describe("the alarm palette", () => {
  it("is expressed in the same colour space as the rest of the app", async () => {
    await show();
    for (const token of ["--hl", "--fill-bar", "--imm-hl", "--imm-fill",
                         "--trig", "--trig-hl", "--trig-fill", "--badge-bg"]) {
      expect(hueOf(token), `${token} is not an oklch colour`).not.toBeNull();
    }
  });

  it("puts the fired state on the app's own destructive hue", async () => {
    await show();
    const fired = hueOf("--trig-fill")!;
    const destructive = hueOf("--destructive")!;
    // not "a red" — THE red this app already uses for refusals and errors
    expect(Math.abs(fired - destructive), `fired hue ${fired} vs destructive ${destructive}`)
      .toBeLessThan(3);
  });

  it("steps the three states along one hue ramp", async () => {
    await show();
    const watching = hueOf("--fill-bar")!;
    const imminent = hueOf("--imm-fill")!;
    const fired = hueOf("--trig-fill")!;
    // yellow to orange to red is a progression; three unrelated hues would not be
    expect(watching).toBeGreaterThan(imminent);
    expect(imminent).toBeGreaterThan(fired);
  });

  it("gives the badge the radius everything else uses", async () => {
    await show();
    const badge = document.querySelector(".badge")!;
    const root = getComputedStyle(document.documentElement);
    const expected = root.getPropertyValue("--radius-sm").trim();
    expect(expected, "--radius-sm is not defined").not.toBe("");
    // a hard-coded 3px was the only radius on the page not derived from --radius
    expect(getComputedStyle(badge).borderRadius).not.toBe("3px");
  });
});

describe("the type scale", () => {
  it("steps down strictly from heading to fine print", async () => {
    await show();
    const size = (sel: string) =>
      parseFloat(getComputedStyle(document.querySelector(sel)!).fontSize);

    const h2 = size("h2");
    const h3 = size("h3");
    const body = parseFloat(getComputedStyle(document.body).fontSize);
    const meta = size(".meta");
    const badge = size(".badge");

    // five sizes existed before this and no two came from any scale: 1.4, 1.05, 0.9,
    // 0.78, 0.7 — each chosen separately, at a different time, by eye
    expect(h2, "h2 is not larger than h3").toBeGreaterThan(h3);
    expect(h3, "h3 is not larger than body text").toBeGreaterThan(body);
    expect(body, "body text is not larger than the meta line").toBeGreaterThan(meta);
    expect(meta, "the meta line is not larger than the badge").toBeGreaterThan(badge);
  });
});
