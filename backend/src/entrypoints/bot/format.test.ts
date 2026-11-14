/** How the bot writes things, asserted character for character (ADR 0009, phase 7).
 *
 *  `toContain` is not enough here, and a mutation sweep proved it: the bot's own tests passed with the
 *  column padding removed, with one space between columns instead of two, with the HTML escaping
 *  applied in the wrong order, and with a delta printed to four places. Every one of those is a table
 *  that reads wrongly on a phone, and none of them changes whether a substring appears.
 *
 *  So these are whole strings. Where a figure's precision is the point, the exact digits are the
 *  assertion.
 */
import { describe, expect, it } from "vitest";

import {
  BOT_COMMANDS, HELP_TEXT, TABLE_WIDTH, closeWords, closedLine, escapeHtml, fitCell, fmtValue, minusSign,
  pyNumber, ruleText, table, thresholdError,
} from "./format.ts";
import type { HoldingValue } from "../../holdings.ts";

describe("escapeHtml", () => {
  it("escapes what Python's html.escape does, quotes included", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
    expect(escapeHtml("a<b>c")).toBe("a&lt;b&gt;c");
    expect(escapeHtml("say \"hi\"")).toBe("say &quot;hi&quot;");
    expect(escapeHtml("it's")).toBe("it&#x27;s");
    expect(escapeHtml("plain")).toBe("plain");
  });

  it("escapes the ampersand FIRST, or every entity gets escaped twice", () => {
    // with < handled before &, "a<b" becomes "a&lt;b" and then "a&amp;lt;b"
    expect(escapeHtml("a<b")).toBe("a&lt;b");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("leaves the characters the tables are actually made of alone", () => {
    expect(escapeHtml("261030 C8100 ≥0.6 🔔 —")).toBe("261030 C8100 ≥0.6 🔔 —");
  });
});

describe("table", () => {
  it("pads every column to its widest cell and separates them with two spaces", () => {
    expect(table(["contract", "mid"], [["261030 C8100", "4.5"], ["261101 P7100", "12.25"]]))
      .toBe([
        "<pre>contract      mid",
        "261030 C8100  4.5",
        "261101 P7100  12.25</pre>",
      ].join("\n"));
  });

  it("strips the trailing space a short last cell would leave", () => {
    // a line ending in spaces inside <pre> is a ragged right edge on the phone
    expect(table(["a", "b"], [["x", "yy"], ["x", "z"]]))
      .toBe("<pre>a  b\nx  yy\nx  z</pre>");
  });

  it("measures the header too, so a wide heading widens its column", () => {
    expect(table(["contract", "f"], [["x", "y"]])).toBe("<pre>contract  f\nx         y</pre>");
  });

  it("escapes the cells, and measures the escaped text as the Python does", () => {
    // arguably wrong — &amp; is five characters of width for one of content — but it is what the
    // Python ships, and no contract code contains an escapable character, so the rows it could
    // misalign do not occur
    expect(table(["a"], [["x&y"]])).toBe("<pre>a\nx&amp;y</pre>");
  });

  it("is a <pre> block, which is what makes Telegram render it monospaced", () => {
    const out = table(["a"], [["b"]]);
    expect(out.startsWith("<pre>")).toBe(true);
    expect(out.endsWith("</pre>")).toBe(true);
  });

  it("renders a header-only table", () => {
    expect(table(["a", "b"], [])).toBe("<pre>a  b</pre>");
  });

  it("keeps the widest real row to its ratified budget", () => {
    // ~40 monospace characters a row and four columns at most (CLAUDE.md). The widest real row is a
    // watchlist line, and it is 45 — asserted exactly rather than loosely, so adding a column or
    // widening a heading shows up here instead of as a wrapped table on the phone.
    const row = table(
      ["contract", "field", "last", "thr", "state"],
      [["261030 C8100", "delta", "0.046", "≥0.6", "armed"]],
    ).replace("<pre>", "").replace("</pre>", "").split("\n")[1]!;
    expect(row).toBe("261030 C8100  delta  0.046  ≥0.6  armed");
    expect(row.length).toBe(39);
  });
});

describe("a name too long for the table (#351)", () => {
  const LONG = "1218_+P7050_+P7100_-2P7150_-C7700_+2C7750_+C7800";
  const lines = (out: string) => out.replace("<pre>", "").replace("</pre>", "").split("\n");

  it("shortens the first column in its middle, so every row stays within the table's width", () => {
    const out = table(["contract", "field", "last", "thr", "state"], [
      [LONG, "mid", "-1.0000", "≥4.0", "armed"], ["261218 C7300", "delta", "0.312", "≥0.3", "🔔"],
    ]);
    expect(Math.max(...lines(out).map((l) => l.length))).toBeLessThanOrEqual(TABLE_WIDTH);
    expect(lines(out)[1]).toMatch(/^1218_\+P7…7800  mid/);
  });

  it("keeps a bell at the end of a shortened name", () => {
    const out = table(["contract", "mid", "bid/ask"], [[`${LONG} 🔔`, "1.5", "1.45/1.55"]]);
    expect(lines(out)[1]).toMatch(/…C7800 🔔 +1\.5/);
    expect(Math.max(...lines(out).map((l) => l.length))).toBeLessThanOrEqual(TABLE_WIDTH);
  });

  it("leaves every table that already fits exactly as it was", () => {
    const rows = [["dec-calls", "mid", "-1.0000", "≥4.0", "armed"]];
    expect(lines(table(["contract", "field", "last", "thr", "state"], rows))[1]).toBe("dec-calls  mid    \u22121.0000  ≥4.0  armed");
    expect(fitCell("short", 10)).toBe("short");
  });

  it("cuts by code point, never through a surrogate pair, and counts UTF-16 units as the width", () => {
    expect(fitCell("abcdefghij🔔", 8)).toBe("abcde…🔔");
    expect(fitCell("abcdefghij", 5)).toBe("abc…j");
  });
});

describe("fmtValue", () => {
  it("gives a delta and an IV three places", () => {
    expect(fmtValue("option_delta", 0.512345)).toBe("0.512");
    expect(fmtValue("option_delta", 0.5)).toBe("0.500");
    expect(fmtValue("option_implied_volatility", 21.45678)).toBe("21.457");
  });

  it("gives everything else Python's str()", () => {
    expect(fmtValue("mid_price", 4.5)).toBe("4.5");
    expect(fmtValue("mid_price", 5)).toBe("5.0");
    expect(fmtValue("bid_price", 1)).toBe("1.0");
    expect(fmtValue("anything", "N/A")).toBe("N/A");
  });
});

describe("pyNumber", () => {
  it("keeps the point on an integral value, as Python's str does", () => {
    expect(pyNumber(0)).toBe("0.0");
    expect(pyNumber(1)).toBe("1.0");
    expect(pyNumber(100)).toBe("100.0");
    expect(pyNumber(-1)).toBe("-1.0");
    expect(pyNumber(123456789)).toBe("123456789.0");
  });

  it("writes the shortest round-trip form in between", () => {
    expect(pyNumber(0.5)).toBe("0.5");
    expect(pyNumber(26.4)).toBe("26.4");
    expect(pyNumber(0.045548793)).toBe("0.045548793");
    expect(pyNumber(1 / 3)).toBe("0.3333333333333333");
  });

  it("goes exponential exactly where Python does", () => {
    // below 1e-4, and at 1e16. JavaScript's own String waits until 1e21, so these are the two
    // boundaries that had to be implemented rather than inherited.
    expect(pyNumber(0.0001)).toBe("0.0001");
    expect(pyNumber(0.000015)).toBe("1.5e-05");
    expect(pyNumber(1e-7)).toBe("1e-07");
    expect(pyNumber(1e15)).toBe("1000000000000000.0");
    expect(pyNumber(1e16)).toBe("1e+16");
    expect(pyNumber(1e21)).toBe("1e+21");
  });

  it("pads the exponent to two digits and always signs it", () => {
    expect(pyNumber(1e-5)).toBe("1e-05");
    expect(pyNumber(1e-100)).toBe("1e-100");
  });

  it("names the values that are not numbers as Python does", () => {
    expect(pyNumber(Number.NaN)).toBe("nan");
    expect(pyNumber(Number.POSITIVE_INFINITY)).toBe("inf");
    expect(pyNumber(Number.NEGATIVE_INFINITY)).toBe("-inf");
    expect(pyNumber(-0)).toBe("-0.0");
  });
});

describe("thresholdError", () => {
  it("says what to add, rather than only that it is wrong", () => {
    expect(thresholdError("abs", -0.5)).toBe(
      "Threshold must be positive — abs monitors compare magnitudes. "
      + "Add 'signed' to compare raw values.",
    );
    expect(thresholdError("abs", 0)).toMatch(/^Threshold must be positive/);
    expect(thresholdError("signed", 0)).toBe(
      "Signed threshold cannot be 0 (zero-width hysteresis band); use e.g. ±0.01.",
    );
  });

  it("allows what should be allowed", () => {
    expect(thresholdError("abs", 0.6)).toBeNull();
    expect(thresholdError("signed", -4.05)).toBeNull();
    expect(thresholdError("signed", 0.01)).toBeNull();
  });
});

describe("one minus in every table (#388)", () => {
  it("writes a negative figure with the real minus, and leaves a name alone", () => {
    expect(minusSign("-0.85")).toBe("\u22120.85");
    expect(minusSign("-.5")).toBe("\u2212.5");
    expect(minusSign("bear-cs")).toBe("bear-cs");
    expect(minusSign("-")).toBe("-");
    expect(table(["c", "delta"], [["x", "-0.850"]])).toBe("<pre>c  delta\nx  \u22120.850</pre>");
  });
});

describe("ruleText", () => {
  const rule = (field: string, combo: boolean, threshold: number, direction: string, compare: string) =>
    ({ field, combo, threshold, direction, compare });
  it("says the rule back in the short form, so a mistyped direction is visible at once (#388)", () => {
    expect(ruleText("Watching US.X", rule("option_delta", false, 0.6, "above", "abs")))
      .toBe("Watching US.X: alarm when |Δ| ≥ 0.60");
    expect(ruleText("US.X", rule("mid_price", false, 30, "below", "abs")))
      .toBe("US.X: alarm when |mid| ≤ 30.00");
    // signed drops the bars, because the sign is the point
    expect(ruleText("bear-cs", rule("option_delta", false, -0.15, "below", "signed")))
      .toBe("bear-cs: alarm when Δ ≤ \u22120.15");
    // and a spread's signed value at or below a negative figure is its cost to close
    expect(ruleText("bear-cs", rule("mid_price", true, -4.05, "below", "signed")))
      .toBe("bear-cs: alarm when close ≥ 4.05");
  });
});

describe("the help and the menu", () => {
  it("documents every command the menu publishes, and no others", () => {
    const published = BOT_COMMANDS.map((c) => c.command);
    const documented = HELP_TEXT.split("\n")
      .map((line) => /^\/([a-z]+)/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name));
    expect([...documented].sort()).toEqual([...published].sort());
  });

  it("must never be HTML-parsed, which is why it is allowed to contain angle brackets", () => {
    // the usage lines are full of <date> and <CALL|PUT> placeholders. Those are the reason the reply
    // goes out as plain text: parsed as HTML, "/watch <date>" would arrive as "/watch" and the owner
    // would be told nothing at all. The parse_mode rule is asserted in bot.test.ts; this is why.
    expect(HELP_TEXT).toContain("<date>");
    expect(HELP_TEXT.startsWith("<pre>")).toBe(false);
  });

  it("gives every menu entry a description, which Telegram requires", () => {
    expect(BOT_COMMANDS.every((c) => c.description.length > 0)).toBe(true);
    expect(BOT_COMMANDS.every((c) => /^[a-z]+$/.test(c.command))).toBe(true);
  });
});

describe("closedLine — which close /holdings is valued from, out of session (#380)", () => {
  const row = (observed_on: string, observed_at: string | null) => ({ observed_on, observed_at });
  /** only `close` and `unpriced` are read, so a value is those and nothing else */
  const valued = (close: ReturnType<typeof row> | null) => ({ close, unpriced: null }) as unknown as HoldingValue;
  const FRI = row("2026-11-13", "2026-11-13 21:14:59.000000"); // 16:14 New York, EST

  it("names the close on New York's clock", () => {
    expect(closeWords(FRI)).toBe("as of the close, Fri 13 Nov 16:14");
    // September is "Sep" in both languages, which a locale's "Sept" would not be
    expect(closeWords(row("2026-09-30", "2026-09-30 20:14:00.000000"))).toBe("as of the close, Wed 30 Sep 16:14");
  });

  it("never passes a reading off as a close", () => {
    expect(closeWords(row("2026-11-13", "2026-11-14 01:30:00.000000"))).toBe("as of Fri 13 Nov 20:30, after the close");
    expect(closeWords(row("2026-11-13", "2026-11-13 10:00:00.000000"))).toBe("as of Fri 13 Nov 05:00, before the open");
    expect(closeWords(row("2026-11-13", null))).toBe("as of Fri 13 Nov, at a time not recorded");
  });

  it("says the latest close, and how many holdings were valued otherwise", () => {
    expect(closedLine([valued(FRI), valued(FRI)])).toBe("market closed — as of the close, Fri 13 Nov 16:14");
    // a row rewritten at 16:10 and another at 16:14 are one close: the later is named
    expect(closedLine([valued(row("2026-11-13", "2026-11-13 21:10:00.000000")), valued(FRI)]))
      .toBe("market closed — as of the close, Fri 13 Nov 16:14");
    // a close is named before a later reading after it
    expect(closedLine([valued(FRI), valued(row("2026-11-13", "2026-11-14 01:30:00.000000")), valued(null)]))
      .toBe("market closed — as of the close, Fri 13 Nov 16:14; 1 as of another reading; 1 with no close, valued live");
    expect(closedLine([valued(null)])).toBe("market closed — no close recorded yet; valued live");
  });

  it("names a weekend reading by its time, never as a close (#387)", () => {
    const sat = row("2026-11-14", "2026-11-14 16:00:00.000000"); // Saturday 11:00 New York
    expect(closeWords(sat)).toBe("as of Sat 14 Nov 11:00");
    // and it is no close to name before a weekday's, though it is in the hours and later
    expect(closedLine([valued(FRI), valued(sat)]))
      .toBe("market closed — as of the close, Fri 13 Nov 16:14; 1 as of another reading");
  });

  it("says a holding with no close was not valued where the Provider could not be asked (#387)", () => {
    const failed = { close: null, unpriced: "OpenD down" } as unknown as HoldingValue;
    expect(closedLine([valued(FRI), failed]))
      .toBe("market closed — as of the close, Fri 13 Nov 16:14; 1 with no close, and the Provider could not be asked");
    expect(closedLine([failed, failed]))
      .toBe("market closed — no close recorded yet, and the Provider could not be asked");
  });
});
