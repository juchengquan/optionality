/** `shared/numbers.ts`: the one formatter every figure on the page goes through (ADR 0023, the
 *  owner's standard of 2026-11-16). */
import { describe, expect, it } from "vitest";

import {
  delta, figureOf, fixed, gamma, iv, money, moneyPlain, percent, points, signedPoints, spx, theta, trueMinus, vega,
} from "../shared/numbers";

describe("the true minus", () => {
  it("writes every negative with U+2212 — points, greeks, money and percentages", () => {
    expect(points(-2.95)).toBe("−2.95");
    expect(delta(-0.0812)).toBe("−0.081");
    expect(money(-4528)).toBe("−$4,528");
    expect(moneyPlain(-4528)).toBe("−$4,528");
    expect(percent(-0.12)).toBe("−12%");
    expect(signedPoints(-45.28)).toBe("−45.28");
  });

  it("signs a gain where the figure is signed, and never a zero", () => {
    expect(money(177)).toBe("+$177");
    expect(money(0)).toBe("$0");
    expect(moneyPlain(472)).toBe("$472");
    expect(signedPoints(4.72)).toBe("+4.72");
    expect(signedPoints(0)).toBe("0.00");
  });

  it("changes a hyphen only where it is a sign", () => {
    expect(trueMinus("-C8050")).toBe("-C8050");
    expect(trueMinus("-$12")).toBe("−$12");
    expect(trueMinus("2026-12-31")).toBe("2026-12-31");
  });
});

describe("fixed places", () => {
  it("by what the figure is: points 2, Δ 3, Γ 4, Θ and ν 2, IV 2 and a percent", () => {
    expect(points(3)).toBe("3.00");
    expect(delta(0.2)).toBe("0.200");
    expect(gamma(0.00021)).toBe("0.0002");
    expect(theta(-1.349)).toBe("−1.35");
    expect(vega(3.384)).toBe("3.38");
    expect(iv(27.171)).toBe("27.17%");
    expect(figureOf("option_gamma", 0.00021)).toBe("0.0002");
    expect(figureOf("option_implied_volatility", 27.171)).toBe("27.17%");
    expect(figureOf("mid_price", 23.35)).toBe("23.35");
  });

  it("says a served non-zero that rounds away as a bound, never as zero", () => {
    expect(gamma(0.00004)).toBe("<0.0001");
    expect(gamma(-0.00004)).toBe(">−0.0001");
    expect(fixed(-0.001, 2)).toBe(">−0.01");
    expect(fixed(0, 2)).toBe("0.00");
    expect(fixed(-0, 2)).toBe("0.00");
  });

  it("dashes a figure that is not there, and never 0", () => {
    for (const f of [points, delta, gamma, theta, vega, iv, percent, money, spx]) {
      expect(f(null)).toBe("—");
      expect(f(undefined)).toBe("—");
      expect(f(Number.NaN)).toBe("—");
    }
  });

  it("writes SPX with no thousands separator, as a strike and a breakeven beside it are", () => {
    expect(spx(7561.7)).toBe("7561.70");
  });
});
