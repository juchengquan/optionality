/** The ⌘K palette's model (#299): what it can find, how text finds it, which actions it offers and
 *  when each is closed, and which key chord opens it. Pure; the dialog itself is
 *  `NextPalette.test.tsx`, and every action reached with a real keyboard is the browser suite's. */
import { describe, expect, it } from "vitest";

import { tableRows, type DeskRow } from "../next/desk/columns";
import { findables, isPaletteChord, matching, paletteActions, type Findable } from "../next/commands";
import { placeBook } from "../next/placement";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";

const book = findables(placeBook(QUOTES, HOLDINGS, MONITORS));
const refs = (fs: Findable[]) => fs.map((f) => f.ref);
const find = (q: string) => refs(matching(book, q));

describe("what it finds", () => {
  it("is every row of the table in the order drawn, then the muted and expired rules", () => {
    expect(refs(book)).toEqual([
      "h-calls", "r-calls", "h-puts", "h-ic", "r-ic",
      "w-dec04", "w-dec18", "w-dec18-delta", "w-dec31", "w-lone",
      // the folded list, as it is drawn: by expiry
      "q-unknown", "m-expired", "m-muted",
    ]);
  });

  it("says what each is, so a holding and the rule watching it read apart", () => {
    const kind = (ref: string) => book.find((f) => f.ref === ref)!.kind;
    expect(kind("h-calls")).toBe("holding");
    expect(kind("r-calls")).toBe("Monitor");
    expect(kind("w-dec18")).toBe("watched spread");
    expect(kind("w-dec18-delta")).toBe("Monitor");
    expect(kind("q-unknown")).toBe("quarantined Monitor");
    expect(kind("m-muted")).toBe("muted Monitor");
    expect(kind("m-expired")).toBe("expired Monitor");
  });

  it("finds by name, code, strike, expiry and what a rule watches", () => {
    expect(find("1218_P7150")).toEqual(["w-dec18"]);
    // a strike reaches the spread, the leg rule on it, and nothing else
    expect(find("7150")).toEqual(["w-dec18", "w-dec18-delta"]);
    // the condor's call side by a long strike, which is in no name
    expect(find("7350")).toEqual(["h-calls", "r-calls"]);
    // an expiry, as the table heads its groups and as the service writes it
    expect(find("261231")).toEqual(["h-ic", "r-ic", "w-dec31", "w-lone"]);
    expect(find("2026-12-04")).toEqual(["w-dec04"]);
    expect(find("8300")).toEqual(["q-unknown"]);
    expect(find("delta 7150")).toEqual(["w-dec18-delta"]);
  });

  it("matches the start of a whole word, never the middle of a code", () => {
    // moomoo writes a strike with three zeros after it (`…C7800000`), so a raw code in the text made
    // the muted 7800 call answer "8000", a 6700 put answer "7000" and a 7065 put answer "6500"
    const put = (strike: number, id: string) => ({
      ...QUOTES.find((q) => q.id === "w-lone")!, id, option_type: "PUT",
      code: `US.SPXW261218P${strike * 1000}`, quote: { name: `SPXW 261218 ${strike}.00P`, option_delta: -0.1 },
    });
    // the rules as the service serves them, each naming the strike its code does (the fixture's
    // switched-off rules carry a default strike of 8000 whatever their code)
    const monitors = MONITORS.map((m) => {
      const k = /[CP](\d+)000$/.exec(m.code);
      return k ? { ...m, strike: Number(k[1]) } : m;
    });
    const more = findables(placeBook([...QUOTES, put(6700, "x-6700"), put(7065, "x-7065")], HOLDINGS, monitors));
    const in_ = (q: string) => refs(matching(more, q));
    expect(in_("8000")).toEqual(["w-lone"]);
    expect(in_("7000")).toEqual([]);
    expect(in_("6500")).toEqual([]);
    expect(in_("6700")).toEqual(["x-6700"]);
    expect(in_("7065")).toEqual(["x-7065"]);
    // and no code at all: it is the wire's spelling, not the owner's
    expect(in_("US.SPXW261211C8300000")).toEqual([]);
    expect(in_("spxw")).toEqual([]);
  });

  it("finds a strike with its side, and an expiry three ways", () => {
    expect(find("p7150")).toEqual(["w-dec18", "w-dec18-delta"]);
    expect(find("c7300")).toEqual(["h-calls", "r-calls"]);
    expect(find("p7300")).toEqual([]);
    expect(find("dec 4")).toEqual(["w-dec04"]);
    expect(find("dec 04")).toEqual(["w-dec04"]);
    expect(find("Dec 18 holding")).toEqual(["h-calls", "h-puts"]);
    expect(find("2026-12-18 holding")).toEqual(["h-calls", "h-puts"]);
    expect(find("nov")).toEqual(["m-expired"]);
  });

  it("finds a word as it is being typed", () => {
    // the start of a strike already narrows to it
    expect(find("715")).toEqual(["w-dec18", "w-dec18-delta"]);
    expect(find("1218_p71")).toEqual(["w-dec18"]);
    expect(find("quar")).toEqual(["q-unknown"]);
  });

  it("takes every word typed, in any order and any case", () => {
    expect(find("HOLDING 1218")).toEqual(["h-calls", "h-puts"]);
    expect(find("1218 holding")).toEqual(["h-calls", "h-puts"]);
    expect(find("  ")).toEqual(refs(book));
    expect(find("nothing-like-this")).toEqual([]);
  });

  it("finds a muted or expired rule, which the table does not draw", () => {
    expect(find("muted")).toEqual(["m-muted"]);
    expect(find("expired")).toEqual(["m-expired"]);
    expect(find("6000")).toEqual(["m-expired"]);
  });

  it("carries no money and no count of contracts, whatever the book holds", () => {
    const said = book.map((f) => `${f.name} ${f.detail}`).join("\n");
    expect(said).not.toMatch(/\$/);
    expect(said).not.toMatch(/×/);
    expect(said).not.toMatch(/contract/i);
    // nor a figure: thresholds and P&L are the table's, not the finder's
    expect(said).not.toMatch(/\d\.\d/);
  });
});

describe("its actions", () => {
  const rows = tableRows(placeBook(QUOTES, HOLDINGS, MONITORS));
  const row = (id: string) => rows.find((r) => (r.kind === "holding" ? r.holding.id
    : r.kind === "rule" ? r.entry.id : r.monitor.id) === id)!;
  const why = (selected: DeskRow | null) => Object.fromEntries(
    paletteActions({ mode: "live", choice: "auto", selected }).map((a) => [a.key, a.why]));

  it("offers every one, in a stable order", () => {
    expect(paletteActions({ mode: "live", choice: "auto", selected: null }).map((a) => a.label)).toEqual([
      "Add a spread", "Edit the selected Monitor", "Close the selected holding", "Save the view as an image",
      "Switch to Review",
      "Arrangement: desk", "Arrangement: phone", "Arrangement: by the screen's width",
    ]);
    expect(paletteActions({ mode: "review", choice: "desk", selected: null })
      .find((a) => a.key === "mode")!.label).toBe("Switch to Live");
  });

  it("closes the two that need a selection, and says why", () => {
    expect(why(null)).toMatchObject({
      add: null, "edit-monitor": "nothing is selected", "close-holding": "nothing is selected", mode: null,
    });
    expect(why(row("h-calls"))).toMatchObject({
      "edit-monitor": "a holding is selected: select one of its Monitors", "close-holding": null,
    });
    expect(why(row("w-dec18"))).toMatchObject({
      "edit-monitor": null, "close-holding": "a Monitor is selected, not a holding",
    });
    // a quarantined rule is a Monitor too, and its editor is in the inspector
    expect(why(row("q-unknown"))).toMatchObject({ "edit-monitor": null });
  });

  it("refuses what would carry off a form being typed into, and nothing else", () => {
    const why = (selected: DeskRow | null, hold: "edit" | "close" | "other" | null, autoIsPhone = false) =>
      Object.fromEntries(paletteActions({ mode: "live", choice: "desk", selected, hold, autoIsPhone })
        .map((a) => [a.key, a.why]));
    const HOLD = "finish or cancel the open form first";
    // the selected rule's own editor is open: editing it again is landing on it, closing is not
    expect(why(row("w-dec18"), "edit")).toMatchObject({ "edit-monitor": null, add: null, mode: null, "save-image": null });
    expect(why(row("h-calls"), "close")).toMatchObject({ "close-holding": null });
    // another form open: neither form action, and not the phone, which unmounts the desk
    expect(why(row("w-dec18"), "other")).toMatchObject({ "edit-monitor": HOLD, "arrange-phone": HOLD });
    expect(why(row("h-calls"), "edit")).toMatchObject({ "close-holding": HOLD });
    expect(why(row("h-calls"), "other")).toMatchObject({ "close-holding": HOLD, "arrange-desk": null });
    // by the screen's width is refused only where the width would make it the phone
    expect(why(null, "other", false)["arrange-auto"]).toBeNull();
    expect(why(null, "other", true)["arrange-auto"]).toBe(HOLD);
    // and with nothing held, nothing is refused for it
    expect(why(row("h-calls"), null, true)).toMatchObject({ "arrange-phone": null, "arrange-auto": null });
  });

  it("names what it acts on", () => {
    const of = (selected: DeskRow) => Object.fromEntries(
      paletteActions({ mode: "live", choice: "auto", selected }).map((a) => [a.key, a.detail]));
    expect(of(row("h-calls"))["close-holding"]).toBe("1218_C7300");
    expect(of(row("w-dec18-delta"))["edit-monitor"]).toBe("261218 7150P");
  });

  it("says which arrangement is in use", () => {
    const detail = (choice: "auto" | "desk" | "phone") => paletteActions({ mode: "live", choice, selected: null })
      .filter((a) => a.key.startsWith("arrange")).map((a) => a.detail);
    expect(detail("desk")).toEqual(["in use", "", ""]);
    expect(detail("auto")).toEqual(["", "", "in use"]);
  });
});

describe("the chord that opens it", () => {
  const key = (over: Partial<KeyboardEvent>) =>
    ({ key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

  it("is ⌘K on a Mac and Ctrl+K elsewhere", () => {
    expect(isPaletteChord(key({ metaKey: true }), true)).toBe(true);
    expect(isPaletteChord(key({ ctrlKey: true }), false)).toBe(true);
    expect(isPaletteChord(key({ key: "K", metaKey: true }), true)).toBe(true);
  });

  it("leaves the browser's and the system's own chords alone", () => {
    // Ctrl+K on a Mac is the text field's kill-to-end-of-line, and ⌘K off one is nothing of ours
    expect(isPaletteChord(key({ ctrlKey: true }), true)).toBe(false);
    expect(isPaletteChord(key({ metaKey: true }), false)).toBe(false);
    // with another modifier it is another chord
    expect(isPaletteChord(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isPaletteChord(key({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(isPaletteChord(key({ metaKey: true, ctrlKey: true }), true)).toBe(false);
    expect(isPaletteChord(key({ key: "j", metaKey: true }), true)).toBe(false);
    expect(isPaletteChord(key({}), true)).toBe(false);
  });
});
