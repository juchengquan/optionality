import { render } from "@testing-library/react";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";
import { CONTRACT_VERSION } from "../contract";

/** Three states, three colours — measured. A class name is not evidence of a visible
 *  difference, and this project has shipped three assertions that reported confidence they
 *  had not earned by confusing the two. */

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
  contract_version: CONTRACT_VERSION,
};
const base = {
  id: "m1", code: "US.SPXW261120C8100000", field: "option_delta", threshold: 0.2,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-20",
  dte: 57, scope: "leg", positions: [{ id: "p1", name: "1120_b_8100" }],
  cost_to_close: 3.75, entry: null, pnl: null,
  snapshot: { name: "SPXW 261120 8100.00C", option_delta: 0.1685, mid_price: 31.5 },
};

async function bandColour(fill: number, triggered: boolean): Promise<string> {
  document.body.innerHTML = "";
  window.fetch = ((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(
        String(url).endsWith("/quotes") ? [{ ...base, fill, triggered }]
        : String(url).endsWith("/monitors") ? [] : health),
    })) as unknown as typeof fetch;
  render(<App />);
  await new Promise((r) => setTimeout(r, 180));
  const cell = document.querySelector("td.hl")!;
  // Only the COLOURS, with the percentages stripped out.
  //
  // The first version of this returned the whole backgroundImage string and compared those.
  // They always differ — a gradient at 60% and one at 95% are different strings however
  // identical their colours — so the test could not fail, and it duly passed with the
  // imminent palette set to the watching palette and again with the class never applied.
  const image = getComputedStyle(cell).backgroundImage;
  // oklch OR rgb: the palette moved to oklch and browsers serialise it as itself, so a
  // regex that only knew rgb() reported no colours at all and the test stopped working
  return (image.match(/(?:oklch|rgba?)\([^)]*\)/g) ?? []).join(" ");
}

afterEach(async () => { document.body.innerHTML = ""; await page.viewport(1280, 900); });

describe("the three fill states", () => {
  it("look different from each other", async () => {
    const watching = await bandColour(60, false);
    const imminent = await bandColour(95, false);
    const fired = await bandColour(100, true);

    for (const [name, c] of [["watching", watching], ["imminent", imminent], ["fired", fired]]) {
      expect(c, `${name} reported no colours at all`).not.toBe("");
    }

    expect(watching).not.toBe(imminent);
    expect(imminent).not.toBe(fired);
    expect(watching).not.toBe(fired);
  });

  it("all actually draw a bar rather than a flat colour", async () => {
    for (const [fill, trig] of [[60, false], [95, false], [100, true]] as const) {
      // DISTINCT colours, not a count of stops: the browser repeats stops when it
      // serialises a gradient, so the raw count is 6 for a two-colour bar and means nothing.
      // What separates a bar from a flat fill is that it has more than one colour in it.
      const distinct = new Set((await bandColour(fill, trig)).split(" "));
      expect(distinct.size, `fill ${fill} is a flat colour, not a bar`).toBeGreaterThan(1);
    }
  });

  it("puts the bar at the fill, not at a fixed point", async () => {
    // the colour is the new part; the bar must still report the actual figure
    const cell = () => document.querySelector<HTMLElement>("td.hl")!;
    await bandColour(95, false);
    expect(cell().style.getPropertyValue("--fill")).toBe("95%");
  });
});
