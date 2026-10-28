import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SnapshotView } from "../SnapshotView";
import { deliver, snapshotName } from "../snapshot";
import { COMBO_COLUMNS, SINGLE_COLUMNS } from "../columns";
import type { Entry, Health, Holding } from "../api";

/** Saving the page as an image, to paste into a chat.
 *
 *  The point of the feature is the thing the live page cannot give you: EVERY ticked column.
 *  `useTableFit` drops columns against the viewport (ADR 0008), so on a phone the table on screen
 *  is a subset and a screenshot of it is a subset too. This renders a second tree at a width of
 *  its own, which is why SnapshotView takes its columns rather than measuring anything.
 */
const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21, display_tz: "Asia/Singapore" },
} as unknown as Health;

const combo = {
  id: "c1", code: "1130_8100", field: "mid_price", threshold: 2.49, direction: "above",
  compare: "abs", triggered: false, strike_date: "2026-11-30", option_type: "CMB",
  dte: 41, fill: 61, scope: null, positions: [], cost_to_close: null, entry: null, pnl: null,
  schedule: null, quote: null, combo_value: -3.05, combo_greeks: {},
  legs: [{ sign: -1, option_type: "CALL", strike: 8100 }, { sign: 1, option_type: "CALL", strike: 8150 }],
} as unknown as Entry;

const single = {
  ...combo, id: "m1", code: "US.SPXW261130C8100000", option_type: "CALL", legs: null,
  quote: { name: "SPXW 261130 8100.00C", mid_price: 4.6, option_delta: 0.11 },
} as unknown as Entry;

const holding = {
  id: "p1", name: "1204_BS_6950", entry: 2.72, cost_to_close: 1.02, pnl: 1.7, dte: 37,
  opened_at: "2026-10-15", schedule: null,
  legs: [{ side: "short", option_type: "PUT", strike: 6950 }, { side: "long", option_type: "PUT", strike: 6900 }],
} as unknown as Holding;

function view(
  hidden?: { single?: Set<string>; combo?: Set<string> },
  held?: { rows?: Holding[] | null; error?: string | null },
) {
  return render(
    <SnapshotView
      singles={[single]} combos={[combo]} health={health}
      fetchedAt="2026-10-21 21:47:23+08:00" polledAt="21:30:07"
      grouping="none" reading="distance" band={80}
      hiddenSingle={hidden?.single ?? new Set()} hiddenCombo={hidden?.combo ?? new Set()}
      holdings={held?.rows === undefined ? [holding] : held.rows}
      holdingsError={held?.error ?? null}
    />,
  );
}

describe("the snapshot tree", () => {
  it("carries every column, which is the only reason it exists", () => {
    view();

    const headers = [...document.querySelectorAll("th")].map((h) => h.textContent);
    for (const c of [...SINGLE_COLUMNS, ...COMBO_COLUMNS]) {
      expect(headers, `"${c.label}" is missing from the image`).toContain(c.label);
    }
  });

  it("still leaves out what you unticked, per table — ticked, not all", () => {
    // The picker is a statement about what you want to see, and an image that ignored it would
    // be a different page rather than a copy of yours. Asserted per table BECAUSE the two have
    // columns of the same name: hiding gamma on combos while the single table keeps it is only
    // observable table by table, and it is exactly what a swapped pair of sets would break.
    view({ single: new Set(["gamma"]), combo: new Set(["theta"]) });

    const headersOf = (which: 0 | 1) =>
      [...document.querySelectorAll("table")[which]!.querySelectorAll("th")]
        .map((h) => h.textContent);
    expect(headersOf(0), "single-leg still shows gamma").not.toContain("gamma");
    expect(headersOf(0), "and keeps theta, which was ticked there").toContain("theta");
    expect(headersOf(1), "combos still show theta").not.toContain("theta");
    expect(headersOf(1), "and keep gamma, which was ticked there").toContain("gamma");
  });

  it("stamps the freshness line, so the image says when it was true", () => {
    // a screenshot with no timestamp is worthless a week later, and this is the only thing in
    // the picture that dates it
    view();

    expect(screen.getByText(/fetched at 2026-10-21 21:47:23/)).toBeTruthy();
    expect(screen.getByText(/screen updated 21:30:07/)).toBeTruthy();
  });

  it("names the SESSION time, for a reader who does not know this timezone", () => {
    // the owner reads the dashboard in Singapore and trades a US session; a picture sent to
    // someone else carries no zone at all unless this line says one
    view();

    expect(screen.getByText(/09:47:23 EDT/), "the image does not say where in the day it is")
      .toBeTruthy();
  });

  it("draws no buttons — nothing in a picture can be pressed", () => {
    view();

    expect(document.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("the holdings in the picture", () => {
  /** What you HOLD is the half of the page a rule cannot state: the entry, the cost to close and
   *  the P&L. The image carried them only while the panel happened to be OPEN, because it cloned
   *  that panel's live node — so the same button produced two different pictures depending on a
   *  disclosure triangle, and the one you get when you have not touched anything was the one
   *  missing the money. */
  it("carries the figures whether or not the panel is open", () => {
    view();

    expect(screen.getByText("1204_BS_6950")).toBeTruthy();
    expect(screen.getByText(/-P6950 \+P6900/)).toBeTruthy();
    const figures = [...document.querySelectorAll(".snapshot dd")].map((d) => d.textContent);
    expect(figures, "the entry is not in the image").toContain("2.72");
    expect(figures, "the cost to close is not in the image").toContain("1.02");
    expect(figures, "the P&L is not in the image").toContain("1.70");
  });

  it("says so when the figures could not be read, rather than looking like nothing is held", () => {
    // the one failure that must not be silent: an omitted section and an empty one look identical
    // in a picture, and "nothing held" is a claim about the account
    view(undefined, { rows: null, error: "/positions/values → 502" });

    expect(screen.getByText(/502/)).toBeTruthy();
    expect(screen.queryByText("1204_BS_6950")).toBeNull();
  });

  it("says nothing is held when nothing is, which is not the same as a failure", () => {
    view(undefined, { rows: [] });

    expect(screen.getByText(/Nothing held/)).toBeTruthy();
  });

  it("leaves the section out entirely while the figures have not arrived", () => {
    // mid-fetch is not a state worth photographing: no heading at all beats a heading over
    // "loading…", which in a still image reads as a holding that failed to render
    view(undefined, { rows: null });

    expect(screen.queryByText(/holdings/i)).toBeNull();
  });

  it("still draws no buttons, with the holdings in", () => {
    // the clone it replaces had to strip forms and unwrap buttons by hand, because it was a copy
    // of a panel built for editing. A rendered section has none to strip.
    view();

    expect(document.querySelectorAll("button")).toHaveLength(0);
    expect(document.querySelectorAll("form")).toHaveLength(0);
    expect(document.querySelectorAll("input")).toHaveLength(0);
  });
});

describe("the file name", () => {
  it("is dated and sortable", () => {
    expect(snapshotName(new Date("2026-10-21T13:30:00+08:00"))).toBe("optionality-20261021-1330.png");
  });
});

describe("delivering it", () => {
  const blob = new Blob(["x"], { type: "image/png" });

  it("uses the share sheet when the device has one", async () => {
    const share = vi.fn((_data: { files: File[] }) => Promise.resolve());
    const how = await deliver(blob, "a.png", {
      canShare: () => true, share, download: () => { throw new Error("should not download"); },
    });

    expect(how).toBe("shared");
    const file = (share.mock.calls[0]![0] as unknown as { files: File[] }).files[0]!;
    expect(file.name).toBe("a.png");
    expect(file.type).toBe("image/png");
  });

  it("falls back to a download where it does not, rather than doing nothing", async () => {
    // the whole lesson of the record button: a press that produces neither a result nor a word
    // is indistinguishable from a broken one
    const download = vi.fn();
    const how = await deliver(blob, "a.png", {
      canShare: () => false, share: () => { throw new Error("should not share"); }, download,
    });

    expect(how).toBe("downloaded");
    expect(download).toHaveBeenCalledWith(blob, "a.png");
  });

  it("falls back when the device CLAIMS it can share and then refuses", async () => {
    // Safari answers canShare(files) true and can still throw NotAllowedError, and a cancelled
    // share sheet throws AbortError — one is a failure to deliver, the other is you changing
    // your mind, and only the first should leave a file behind
    const download = vi.fn();
    const how = await deliver(blob, "a.png", {
      canShare: () => true,
      share: () => Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" })),
      download,
    });

    expect(how).toBe("downloaded");
    expect(download).toHaveBeenCalled();
  });

  it("says nothing was delivered when you cancel the sheet yourself", async () => {
    const download = vi.fn();
    const how = await deliver(blob, "a.png", {
      canShare: () => true,
      share: () => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" })),
      download,
    });

    expect(how).toBe("cancelled");
    expect(download, "a cancelled share must not leave a file behind").not.toHaveBeenCalled();
  });
});
