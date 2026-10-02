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
  BOT_COMMANDS, HELP_TEXT, escapeHtml, fmtValue, hasFormat, pyNumber, ruleText, shortCode, table,
  thresholdError,
} from "./format.ts";

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

describe("shortCode", () => {
  it("drops the SPXW and the trailing 000, which every contract has", () => {
    expect(shortCode("US.SPXW260918C8100000")).toBe("260918 C8100");
    expect(shortCode("US.SPXW261218P6425000")).toBe("261218 P6425");
  });

  it("passes anything else through, including a combo's own name", () => {
    expect(shortCode("US.WEIRD123")).toBe("US.WEIRD123");
    expect(shortCode("sep-condor")).toBe("sep-condor");
  });
});

describe("fmtValue", () => {
  it("gives a delta and an IV three places", () => {
    expect(fmtValue("option_delta", 0.512345)).toBe("0.512");
    expect(fmtValue("option_delta", 0.5)).toBe("0.500");
    expect(fmtValue("option_implied_volatility", 21.45678)).toBe("21.457");
    expect(hasFormat("option_delta")).toBe(true);
    expect(hasFormat("option_implied_volatility")).toBe(true);
  });

  it("gives everything else Python's str()", () => {
    expect(hasFormat("mid_price")).toBe(false);
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
    expect(thresholdError(-0.5, "abs")).toBe(
      "Threshold must be positive — abs monitors compare magnitudes. "
      + "Add 'signed' to compare raw values.",
    );
    expect(thresholdError(0, "abs")).toMatch(/^Threshold must be positive/);
    expect(thresholdError(0, "signed")).toBe(
      "Signed threshold cannot be 0 (zero-width hysteresis band); use e.g. ±0.01.",
    );
  });

  it("allows what should be allowed", () => {
    expect(thresholdError(0.6, "abs")).toBeNull();
    expect(thresholdError(-4.05, "signed")).toBeNull();
    expect(thresholdError(0.01, "signed")).toBeNull();
  });
});

describe("ruleText", () => {
  it("says the rule back in full, so a mistyped direction is visible at once", () => {
    expect(ruleText("Watching US.X", "option_delta", 0.6, "above", "abs"))
      .toBe("Watching US.X: alarm when abs(option_delta) ≥ 0.6");
    expect(ruleText("US.X", "mid_price", 30, "below", "abs"))
      .toBe("US.X: alarm when abs(mid_price) ≤ 30");
    // signed drops the abs(), because the sign is the point
    expect(ruleText("bear-cs", "mid_price", -4.05, "below", "signed"))
      .toBe("bear-cs: alarm when mid_price ≤ -4.05");
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
