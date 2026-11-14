/** The preferences the browser remembers, and the one cookie they all go through.
 *
 *  The old page's viewer preferences were written by hand in five places — four in its `columns.ts`
 *  beside the column definitions they had nothing to do with, and the refresh cadence inline in its
 *  `App.tsx`, which is why that one had no test at all. Each spelled out its own
 *  `document.cookie.split("; ").find(...)` and its own attribute string, and the attributes are
 *  the part that cannot be seen to be wrong: a missing `max-age` makes a session cookie, which
 *  reads back correctly all day and is gone tomorrow. One helper, asserted once.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  readArrangement, readEntryStyle, readHidden, readPriceMap, readPrivacy, readRefresh, readUp,
  writeArrangement, writeEntryStyle, writeHidden, writePriceMap, writePrivacy, writeRefresh, writeUp,
} from "../shared/prefs";

const NAMES = [
  "ui_cols_combo", "ui_refresh", "ui_up", "ui_entry", "ui_privacy", "ui_arrangement", "ui_price_map",
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
  it("remembers the hidden columns, in the cookie the old page's combo table kept them in", () => {
    writeHidden(new Set(["pnl", "legs"]));
    expect([...readHidden()].sort()).toEqual(["legs", "pnl"]);
    // the name is the point: a choice made before the swap is still the choice after it
    expect(document.cookie).toContain("ui_cols_combo=legs.pnl");
  });

  it("remembers the poll cadence", () => {
    writeRefresh(30);
    expect(readRefresh(15)).toBe(30);
  });
});

describe("every preference is written to outlive the tab", () => {
  const writes: [string, () => void][] = [
    ["the hidden columns", () => writeHidden(new Set(["legs"]))],
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
    expect([...readHidden()].sort()).toEqual(["legs", "vega"]);
  });

  it("decodes a percent-encoded value", () => {
    document.cookie = "ui_up=%72ed;path=/";
    expect(readUp()).toBe("red");
  });

  it("does not take the page down over a stray percent sign", () => {
    // decodeURIComponent throws on this, and these readers run in useState initialisers — so the
    // alternative to validating it is a blank dashboard from one character typed into devtools
    document.cookie = "ui_refresh=50%;path=/";
    expect(readRefresh(15)).toBe(15);
  });
});

/** The page's own since the redesign (ADR 0023). Each is read where nothing has been chosen, and each has
 *  a default that is the design's, not the browser's: green-up, an entry rule that fires looks like
 *  the good news it is, figures shown, and the width deciding the arrangement. */
describe("the page's own preferences", () => {
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
