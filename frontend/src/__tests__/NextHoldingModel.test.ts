/** Changing a holding from `/opt/next` (#294): what the edit, the close and the correction post,
 *  what each refuses before posting anything, and how a closed holding's Monitors are said. Every
 *  body is parsed with the route's own schema, so the forms cannot drift from what the routes take.
 */
import { describe, expect, it } from "vitest";

import { ClosePositionIn, PositionPatch } from "backend/schemas";
import type { Holding, Monitor } from "../shared/api";
import {
  closeBody, closeDay, correctionBody, editBody, editDraft, exitPrefill, fates, type Watching,
} from "../next/holding";

const held = {
  id: "h1", name: "1218_P7150", strike_date: "2026-12-18", contracts: 2, entry: 1.5,
  opened_at: "2026-11-03", cost_to_close: 0.85,
} as Holding;

describe("the exit a close starts with", () => {
  it("is the served Cost to close, as it is signed: a long's sale stays negative", () => {
    expect(Number(exitPrefill(0.85))).toBe(0.85);
    expect(Number(exitPrefill(-7))).toBe(-7);
    expect(Number(exitPrefill(1.225))).toBe(1.225);
    expect(Number(exitPrefill(0))).toBe(0);
  });

  it("drops the float noise a sum of mids carries, and nothing a mid can be", () => {
    expect(exitPrefill(2.35 - 1.15)).toBe("1.2");
    expect(exitPrefill(0.0125)).toBe("0.0125");
  });

  it("is blank where no Cost to close was served, which the close keeps as unknown", () => {
    expect(exitPrefill(null)).toBe("");
  });
});

describe("the day a close starts with", () => {
  it("is today's New York market day, or the expiry if that came first", () => {
    expect(closeDay("2026-12-18", "2026-11-12")).toBe("2026-11-12");
    expect(closeDay("2026-11-06", "2026-11-12")).toBe("2026-11-06");
  });
});

describe("the close", () => {
  it("posts the exit as typed, signed, with the day", () => {
    const out = closeBody({ exit: "-7.25", closedOn: "2026-11-12" });
    expect(out).toEqual({ body: { exit: -7.25, closed_on: "2026-11-12" } });
    expect(ClosePositionIn.safeParse((out as { body: unknown }).body).success).toBe(true);
  });

  it("posts a blank exit as null: unknown, kept as unknown", () => {
    expect(closeBody({ exit: "  ", closedOn: "2026-11-12" })).toEqual({ body: { exit: null, closed_on: "2026-11-12" } });
  });

  it("leaves a blank day to the service, which takes today's or the expiry", () => {
    expect(closeBody({ exit: "1", closedOn: "" })).toEqual({ body: { exit: 1 } });
  });

  it("refuses an exit that is not a number before asking the service anything", () => {
    expect(closeBody({ exit: "1.2.3", closedOn: "2026-11-12" })).toEqual({ error: "the exit is not a number: 1.2.3" });
  });
});

describe("correcting a close", () => {
  const served = { exit: 1, closed_on: "2026-11-10" };

  it("sends only what changed from the close as the service has it, a cleared Exit as null", () => {
    // another form may have corrected the other field meanwhile: one sent unchanged would revert it
    expect(correctionBody(served, { exit: "1", closedOn: "2026-11-09" })).toEqual({ body: { closed_on: "2026-11-09" } });
    expect(correctionBody(served, { exit: "0.7", closedOn: "2026-11-10" })).toEqual({ body: { exit: 0.7 } });
    const out = correctionBody(served, { exit: "", closedOn: "2026-11-09" });
    // blank is an answer, "I do not know what I paid": sent as null, never left out
    expect(out).toEqual({ body: { exit: null, closed_on: "2026-11-09" } });
    expect(PositionPatch.safeParse((out as { body: unknown }).body).success).toBe(true);
    // a blank Exit left blank is no change
    expect(correctionBody({ exit: null, closed_on: "2026-11-10" }, { exit: "", closedOn: "2026-11-09" }))
      .toEqual({ body: { closed_on: "2026-11-09" } });
  });

  it("says nothing changed rather than sending an empty correction", () => {
    expect(correctionBody(served, { exit: "1.0", closedOn: "2026-11-10" })).toEqual({ error: "nothing changed" });
  });

  it("refuses a blank day: a closed holding always has one", () => {
    expect(correctionBody(served, { exit: "1", closedOn: "" })).toEqual({ error: "type the day it was closed" });
  });
});

describe("the edit", () => {
  it("starts from the holding as recorded", () => {
    expect(editDraft(held)).toEqual({ entry: "1.5", contracts: "2", opened: "2026-11-03" });
    expect(editDraft({ ...held, entry: null, opened_at: null } as Holding))
      .toEqual({ entry: "", contracts: "2", opened: "" });
  });

  it("sends only what changed, in the shape PATCH takes", () => {
    const out = editBody(held, { entry: "1.65", contracts: "2", opened: "2026-11-04" });
    expect(out).toEqual({ body: { entry: 1.65, opened_at: "2026-11-04" } });
    expect(PositionPatch.safeParse((out as { body: unknown }).body).success).toBe(true);
    expect(editBody(held, { entry: "1.5", contracts: "3", opened: "2026-11-03" }))
      .toEqual({ body: { contracts: 3 } });
  });

  it("says when nothing changed, rather than sending what the route refuses", () => {
    expect(editBody(held, editDraft(held))).toEqual({ error: "nothing changed" });
  });

  it("refuses what PATCH cannot take: a cleared entry or day, a count that is not whole", () => {
    expect(editBody(held, { entry: "", contracts: "2", opened: "2026-11-03" }))
      .toEqual({ error: "the entry cannot be cleared here — type what was taken in" });
    expect(editBody(held, { entry: "1.5", contracts: "2", opened: "" }))
      .toEqual({ error: "Opened cannot be cleared here — type the New York trading day it was put on" });
    expect(editBody(held, { entry: "1.5", contracts: "1.5", opened: "2026-11-03" }))
      .toEqual({ error: "contracts must be a whole number, 1 or more" });
    expect(editBody(held, { entry: "x", contracts: "2", opened: "2026-11-03" }))
      .toEqual({ error: "the entry is not a number: x" });
  });
});

function monitor(id: string, over: Partial<Monitor>): Monitor {
  return {
    id, code: id, strike_date: "2026-12-18", option_type: "PUT", strike: 7150, field: "option_delta",
    threshold: 0.3, direction: "above", compare: "abs", legs: null, enabled: true, scope: null,
    positions: [], disabled_reason: null, triggered: false, last_value: null, last_checked_at: null,
    created_at: null, ...over,
  } as Monitor;
}

describe("what became of a closed holding's Monitors", () => {
  const watching: Watching[] = [
    { id: "m-off", name: "18 Dec 7150P delta" },
    { id: "m-rolled", name: "18 Dec 7150P mid" },
    { id: "m-muted", name: "spread value" },
    { id: "m-loose", name: "loose" },
  ];
  const after = [
    monitor("m-off", { enabled: false, disabled_reason: "holding-closed" }),
    monitor("m-rolled", { positions: [{ id: "h2", name: "1218_P7150_roll" }] }),
    monitor("m-muted", { enabled: false, disabled_reason: "manual" }),
    monitor("m-loose", {}),
  ];

  it("says each as the service now reports it", () => {
    expect(fates(watching, after, [{ id: "m-off", code: "x" }])).toEqual([
      { id: "m-off", name: "18 Dec 7150P delta", fate: "switched off — holding closed" },
      { id: "m-rolled", name: "18 Dec 7150P mid", fate: "handed to 1218_P7150_roll" },
      { id: "m-muted", name: "spread value", fate: "linked to nothing; it was already off (Muted by you)" },
      { id: "m-loose", name: "loose", fate: "kept on, linked to no holding" },
    ]);
  });

  it("names a rule the close switched off even when the page never knew it watched the holding", () => {
    const out = fates([], [monitor("m-x", { code: "US.X", enabled: false, disabled_reason: "holding-closed" })],
      [{ id: "m-x", code: "US.X" }]);
    expect(out).toEqual([{ id: "m-x", name: "US.X", fate: "switched off — holding closed" }]);
  });

  it("says plainly when a rule is no longer there to report on", () => {
    expect(fates([{ id: "gone", name: "gone" }], [], [])).toEqual([
      { id: "gone", name: "gone", fate: "no longer listed by the service" },
    ]);
  });
});
