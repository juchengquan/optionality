import { describe, expect, it } from "vitest";

import { type Entry } from "../api";
import { groupRows, rowKind, readGrouping } from "../columns";

const row = (over: Partial<Entry> & { id: string }) => ({
  code: over.id, strike_date: "2026-11-30", option_type: "CALL", dte: 42, field: "option_delta",
  ...over,
} as unknown as Entry);

describe("what kind a row is", () => {
  it("reads a single leg's own type", () => {
    expect(rowKind(row({ id: "a", option_type: "PUT" }))).toBe("PUT");
  });

  it("reads a spread from its legs, not from the CMB it is stored as", () => {
    expect(rowKind(row({
      id: "s", option_type: "CMB",
      legs: [{ sign: -1, option_type: "PUT", strike: 6950 }, { sign: 1, option_type: "PUT", strike: 6900 }],
    } as Partial<Entry> & { id: string }))).toBe("PUT");
  });

  it("calls a condor mixed, because it is both and neither", () => {
    expect(rowKind(row({
      id: "ic", option_type: "CMB",
      legs: [
        { sign: -1, option_type: "CALL", strike: 8050 }, { sign: 1, option_type: "CALL", strike: 8075 },
        { sign: -1, option_type: "PUT", strike: 7100 }, { sign: 1, option_type: "PUT", strike: 7075 },
      ],
    } as Partial<Entry> & { id: string }))).toBe("MIXED");
  });
});

describe("grouping the rows", () => {
  const rows = [
    row({ id: "c8100", option_type: "CALL" }),
    row({ id: "p6950", option_type: "PUT" }),
    row({ id: "c8150", option_type: "CALL" }),
    row({ id: "dec_p", option_type: "PUT", strike_date: "2026-12-04", dte: 46 }),
  ];

  it("gives one unlabelled group when grouping is off", () => {
    const groups = groupRows(rows, "none");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBeNull();
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(["c8100", "p6950", "c8150", "dec_p"]);
  });

  it("puts calls above puts, the way the wings are drawn", () => {
    const groups = groupRows(rows, "type");
    expect(groups.map((g) => g.label)).toEqual(["calls", "puts"]);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(["c8100", "c8150"]);
  });

  it("keeps each group's rows in the order the table already had them", () => {
    // the owner asked for the existing sequence to be kept; grouping PARTITIONS, it does not sort
    const groups = groupRows([...rows].reverse(), "type");
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(["c8150", "c8100"]);
    expect(groups[1]!.rows.map((r) => r.id)).toEqual(["dec_p", "p6950"]);
  });

  it("groups by expiry, nearest first, and says how long each has", () => {
    const groups = groupRows(rows, "expiry");
    expect(groups.map((g) => g.label)).toEqual(["261130 · 42 dte", "261204 · 46 dte"]);
    expect(groups[1]!.rows.map((r) => r.id)).toEqual(["dec_p"]);
  });

  it("draws no divider for a group that is the whole table", () => {
    // one expiry, one group: a heading over every row says nothing, and the gap costs a row of
    // vertical space on a phone for no information at all
    const groups = groupRows(rows.slice(0, 3), "expiry");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label, "so the table draws exactly as it did before").toBeNull();
  });

  it("falls back to off for a cookie nobody wrote, which is user-editable", () => {
    document.cookie = "ui_group=sideways;path=/";
    expect(readGrouping()).toBe("none");
  });
});
