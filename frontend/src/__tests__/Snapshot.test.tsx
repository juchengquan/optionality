import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SnapshotView } from "../SnapshotView";
import { deliver, snapshotName } from "../snapshot";
import { COMBO_COLUMNS, SINGLE_COLUMNS } from "../columns";
import type { Entry, Health } from "../api";

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

function view(hidden?: { single?: Set<string>; combo?: Set<string> }) {
  return render(
    <SnapshotView
      singles={[single]} combos={[combo]} health={health}
      fetchedAt="2026-10-21 21:47:23+08:00" polledAt="21:30:07"
      grouping="none" reading="distance" band={80}
      hiddenSingle={hidden?.single ?? new Set()} hiddenCombo={hidden?.combo ?? new Set()}
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
