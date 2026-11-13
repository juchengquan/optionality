/** The preferences the browser remembers, and the one cookie they all go through.
 *
 *  Six viewer preferences were written by hand in five places — four in `columns.ts` beside the
 *  column definitions they have nothing to do with, and the refresh cadence inline in `App.tsx`,
 *  which is why that one had no test at all. Each spelled out its own
 *  `document.cookie.split("; ").find(...)` and its own attribute string, and the attributes are
 *  the part that cannot be seen to be wrong: a missing `max-age` makes a session cookie, which
 *  reads back correctly all day and is gone tomorrow. One helper, asserted once.
 */
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_BAND } from "../shared/columns";
import {
  readArrangement, readBand, readEntryStyle, readGrouping, readHidden, readPriceMap, readPrivacy, readRefresh,
  readSignal, readUp, writeArrangement, writeBand, writeEntryStyle, writeGrouping, writeHidden,
  writePriceMap, writePrivacy, writeRefresh, writeSignal, writeUp,
} from "../shared/prefs";

const NAMES = [
  "ui_cols_single", "ui_cols_combo", "ui_signal", "ui_band", "ui_group", "ui_refresh",
  "ui_up", "ui_entry", "ui_privacy", "ui_arrangement", "ui_price_map",
];
const clear = () => { for (const n of NAMES) document.cookie = `${n}=;path=/`; };
afterEach(clear);

/** What a writer actually SET, attributes and all. jsdom's `document.cookie` gives a reader back
 *  only the name and value, so the attributes — the half that decides whether the preference
 *  outlives the tab — are invisible to a round-trip. Shadowing the setter is the only way to see
 *  them, and it is removed again straight after. */
function written(fn: () => void): string[] {
  const out: string[] = [];
  const proto = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
  Object.defineProperty(document, "cookie", {
    configurable: true,
    set(value: string) { out.push(value); proto.set!.call(document, value); },
    get() { return proto.get!.call(document); },
  });
  try { fn(); } finally { delete (document as unknown as { cookie?: unknown }).cookie; }
  return out;
}

describe("a preference survives being set", () => {
  it("remembers which reading earns the colour", () => {
    writeSignal("pressure");
    expect(readSignal()).toBe("pressure");
  });

  it("remembers the band it has to clear", () => {
    writeBand(72);
    expect(readBand()).toBe(72);
  });

  it("remembers how the rows are divided", () => {
    writeGrouping("expiry");
    expect(readGrouping()).toBe("expiry");
  });

  it("remembers the hidden columns of each table separately", () => {
    writeHidden("single", new Set(["gamma", "vega"]));
    writeHidden("combo", new Set(["legs"]));
    expect([...readHidden("single")].sort()).toEqual(["gamma", "vega"]);
    expect([...readHidden("combo")]).toEqual(["legs"]);
  });

  it("remembers the poll cadence", () => {
    writeRefresh(30);
    expect(readRefresh(15)).toBe(30);
  });
});

describe("every preference is written to outlive the tab", () => {
  const writes: [string, () => void][] = [
    ["the signal", () => writeSignal("pressure")],
    ["the band", () => writeBand(72)],
    ["the grouping", () => writeGrouping("type")],
    ["the hidden columns", () => writeHidden("combo", new Set(["legs"]))],
    ["the cadence", () => writeRefresh(30)],
    ["which way is up", () => writeUp("red")],
    ["how a fired entry rule looks", () => writeEntryStyle("risk")],
    ["privacy", () => writePrivacy(true)],
    ["the arrangement", () => writeArrangement("phone")],
    ["the price map", () => writePriceMap(true)],
  ];

  for (const [what, write] of writes) {
    it(`${what} is persistent, path-wide and same-site`, () => {
      const [set, ...rest] = written(write);
      expect(rest).toEqual([]);
      // a year, so it is still there next week; path=/ because the dashboard is served under a
      // prefix and a cookie set on /opt/ would not be read back at /opt; lax because a
      // preference has no business travelling on a cross-site request
      expect(set).toContain("max-age=31536000");
      expect(set).toContain("path=/");
      expect(set).toContain("samesite=lax");
    });
  }
});

/** The cadence had no test of its own while it sat in `App.tsx`: it was private to that module,
 *  and the only thing exercising it was whatever an integration test happened to drive. Its
 *  fallback is the one preference whose default is not a constant — it is the service's own sweep
 *  cadence, so a viewer who has never chosen polls as often as the figures actually change. */
describe("the poll cadence", () => {
  it("falls back to the service's own sweep when nothing was chosen", () => {
    expect(readRefresh(15)).toBe(15);
  });

  it("falls back rather than throwing on a cookie that is not a number", () => {
    // cookies are user-editable, and a cadence of NaN is an interval that never fires
    document.cookie = "ui_refresh=often;path=/";
    expect(readRefresh(15)).toBe(15);
  });

  it("will not poll faster than five seconds, whatever the cookie says", () => {
    // every poll is a live Provider call (ADR 0010), so this bound is the service's protection
    document.cookie = "ui_refresh=1;path=/";
    expect(readRefresh(15)).toBe(5);
  });

  it("will not stretch beyond an hour either", () => {
    document.cookie = "ui_refresh=99999;path=/";
    expect(readRefresh(15)).toBe(3600);
  });
});

/** The value as the browser hands it back, which is not always the value as it was written. */
describe("reading a cookie somebody else wrote", () => {
  it("strips the quotes a value picks up when it has to be quoted", () => {
    // a comma forces quoting, which is why the hidden columns are separated by "." — and the
    // quotes are what the owner pastes back in when they edit the cookie by hand
    document.cookie = 'ui_cols_combo="legs.vega";path=/';
    expect([...readHidden("combo")].sort()).toEqual(["legs", "vega"]);
  });

  it("decodes a percent-encoded value", () => {
    document.cookie = "ui_group=%65xpiry;path=/";
    expect(readGrouping()).toBe("expiry");
  });

  it("does not take the page down over a stray percent sign", () => {
    // decodeURIComponent throws on this, and these readers run in useState initialisers — so the
    // alternative to validating it is a blank dashboard from one character typed into devtools
    document.cookie = "ui_band=50%;path=/";
    expect(readBand()).toBe(DEFAULT_BAND);
  });
});

describe("a preference that cannot be honoured", () => {
  it("takes the default band rather than flagging every row or none", () => {
    document.cookie = "ui_band=400;path=/";
    expect(readBand()).toBe(DEFAULT_BAND);
  });

  it("reads an unknown grouping as no grouping", () => {
    document.cookie = "ui_group=sideways;path=/";
    expect(readGrouping()).toBe("none");
  });

  it("reads an unknown signal as the distance", () => {
    document.cookie = "ui_signal=vibes;path=/";
    expect(readSignal()).toBe("distance");
  });
});

/** The redesigned page's four (ADR 0023). Each is read where nothing has been chosen, and each has
 *  a default that is the design's, not the browser's: green-up, an entry rule that fires looks like
 *  the good news it is, figures shown, and the width deciding the arrangement. */
describe("the redesigned page's preferences", () => {
  it("defaults to green-up, and remembers red-up", () => {
    expect(readUp()).toBe("green");
    writeUp("red");
    expect(readUp()).toBe("red");
  });

  it("defaults a fired entry rule to its own style, and remembers the risk style", () => {
    expect(readEntryStyle()).toBe("opportunity");
    writeEntryStyle("risk");
    expect(readEntryStyle()).toBe("risk");
  });

  it("shows the figures until privacy is switched on, and switches it off again", () => {
    expect(readPrivacy()).toBe(false);
    writePrivacy(true);
    expect(readPrivacy()).toBe(true);
    writePrivacy(false);
    expect(readPrivacy()).toBe(false);
  });

  it("keeps the desk's price map shut until it is opened, and shut again when closed", () => {
    expect(readPriceMap()).toBe(false);
    writePriceMap(true);
    expect(readPriceMap()).toBe(true);
    writePriceMap(false);
    expect(readPriceMap()).toBe(false);
    document.cookie = "ui_price_map=wide;path=/";
    expect(readPriceMap()).toBe(false);
  });

  it("lets the width decide until an arrangement is forced", () => {
    expect(readArrangement()).toBe("auto");
    writeArrangement("desk");
    expect(readArrangement()).toBe("desk");
    writeArrangement("auto");
    expect(readArrangement()).toBe("auto");
  });

  it("reads a hand-edited value it does not know as the default", () => {
    document.cookie = "ui_up=blue;path=/";
    document.cookie = "ui_entry=loud;path=/";
    document.cookie = "ui_privacy=yes;path=/";
    document.cookie = "ui_arrangement=tablet;path=/";
    expect([readUp(), readEntryStyle(), readPrivacy(), readArrangement()])
      .toEqual(["green", "opportunity", false, "auto"]);
  });
});
