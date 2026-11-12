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
    // a contract by its code
    expect(find("US.SPXW261211C8300000")).toEqual(["q-unknown"]);
    expect(find("8300")).toEqual(["q-unknown"]);
    expect(find("delta 7150")).toEqual(["w-dec18-delta"]);
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
      "Add a spread", "Edit the selected Monitor", "Close the selected holding", "Switch to Review",
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
