/** A figure copied from the page and pasted into a box (review of #418): the page writes a negative
 *  with the true minus, U+2212, so every box that reads a figure reads it — the rule editor's
 *  threshold and its total Entry, the add form's Entry, the contract form's threshold and Entry, and
 *  the holding forms' Entry and Exit — through the one reader, `readNumber`. Each case pastes the
 *  very text the page writes (`shared/numbers.ts`), never a hand-typed minus. */
import { describe, expect, it } from "vitest";

import { newDraft, setLeg, spreadsBody } from "../add";
import { contractBody, newContract, thresholdFault } from "../contract";
import { draftOf, patchOf, ruleOfEntry, totalOf } from "../edit";
import { closeBody, editBody } from "../holding";
import type { Holding } from "../shared/api";
import { points, readNumber } from "../shared/numbers";
import { QUOTES } from "../testing/ownerBook";

/** What the page shows for −2.95, as copied: the true minus. */
const COPIED = points(-2.95);

describe("the one reader", () => {
  it("reads the page's true minus and the keyboard's hyphen alike, and nothing that is not a plain decimal", () => {
    expect(COPIED).toBe("−2.95");
    expect(readNumber(COPIED)).toBe(-2.95);
    expect(readNumber(" -2.95 ")).toBe(-2.95);
    expect(readNumber("+1.5")).toBe(1.5);
    for (const t of ["", " ", "0x10", "1e-2", "Infinity", "2.95−", "−−2", "1.2.3"]) expect(readNumber(t)).toBeNull();
  });
});

describe("a figure pasted from the page into each box", () => {
  it("the rule editor's threshold", () => {
    const rule = ruleOfEntry(QUOTES.find((q) => q.id === "w-dec18")!);
    expect(patchOf(rule, { ...draftOf(rule), compare: "signed", threshold: COPIED }))
      .toMatchObject({ body: { threshold: -2.95 } });
  });

  it("the rule editor's total Entry", () => {
    expect(totalOf(COPIED)).toEqual({ entry: -2.95 });
  });

  it("the add form's Entry, a debit paid", () => {
    let d = { ...newDraft("2026-11-11"), expiry: "2026-12-18" };
    const key = d.spreads[0]!.key;
    d = setLeg(d, key, 0, { strike: "7150" });
    d = setLeg(d, key, 1, { strike: "7100" });
    d = { ...d, spreads: d.spreads.map((s) => ({ ...s, entry: COPIED })) };
    const out = spreadsBody(d);
    expect(out).not.toHaveProperty("error");
    expect((out as { body: { spreads: { entry: number }[] } }).body.spreads[0]!.entry).toBe(-2.95);
  });

  it("the contract form's threshold and Entry", () => {
    expect(thresholdFault("signed", COPIED)).toBeNull();
    const draft = { ...newContract("2026-11-11"), expiry: "2026-12-18", strike: "7150", held: true,
      compare: "signed" as const, threshold: points(-0.15), entry: points(2.95) };
    const out = contractBody(draft, "2026-11-11");
    expect(out).not.toHaveProperty("error");
    expect(JSON.stringify(out)).toContain("-0.15");
    // a pasted negative Entry is READ — and refused for its sign, which the side gives, never as "not a number"
    expect(contractBody({ ...draft, entry: COPIED }, "2026-11-11")).toMatchObject({ at: "entry", error: expect.stringMatching(/^type the Entry as what was/) });
  });

  it("the holding forms' Exit and Entry", () => {
    expect(closeBody({ exit: COPIED, closedOn: "2026-11-12" })).toEqual({ body: { exit: -2.95, closed_on: "2026-11-12" } });
    const held = {
      id: "h1", name: "1218_P7150", strike_date: "2026-12-18", contracts: 2, entry: 1.5, opened_at: "2026-11-03",
      cost_to_close: 0.85, legs: [{ side: "long", option_type: "PUT", strike: 7150 }],
    } as Holding;
    expect(editBody(held, { entry: COPIED, contracts: "2", opened: "2026-11-03", qty: ["1"] }))
      .toEqual({ body: { entry: -2.95 } });
  });
});
