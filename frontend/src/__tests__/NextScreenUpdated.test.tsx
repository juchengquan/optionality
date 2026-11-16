/** When this SCREEN last fetched, which is not when the service last did — carried from
 *  `ScreenUpdated.test.tsx` (#337), which held it against the old page's `App` until #301 deleted
 *  both.
 *
 *  2026-10-20: "refresh immediately does not work". The clock was fine — what was missing was any
 *  evidence of it. The service's `fetched_at` moves on its own cadence whatever the page does, and
 *  with the market shut no figure moves at all, so a fetch that leaves no trace is
 *  indistinguishable from a button that does nothing.
 *
 *  Both arrangements; the clock faked, the fetches on real microtasks.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { servePage } from "../testing/pageService";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.cookie = "ui_arrangement=;path=/;max-age=0";
});

const arrangements = ["phone", "desk"] as const;
type Arrangement = (typeof arrangements)[number];

function at(arrangement: Arrangement, iso: string) {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });
  if (arrangement === "desk") document.cookie = "ui_arrangement=desk;path=/";
}

const line = () => document.querySelector(".nx .meta")?.textContent ?? "";
const button = () => document.querySelector<HTMLButtonElement>('[aria-label="refresh now"]')!;

describe.each(arrangements)("on the %s, what the page says about its own freshness", (arrangement) => {
  it("says when it last fetched, beside what the service says", async () => {
    servePage();
    // 10:00 New York: 15:00 on the device (TZ=UTC in this suite), and 23:00 in the service's
    // DISPLAY_TZ, which is the clock "screen updated" is said on, with its zone (part F)
    at(arrangement, "2026-11-10T15:00:00Z");
    render(<Next />);
    await waitFor(() => expect(line()).toContain("screen updated 23:00:00 SGT"));
    // and the service's own figure stays, worded distinctly: it says how fresh the FIGURES are,
    // where this says only how recently they reached the screen
    // with its zone by name, never the offset it was served with
    expect(line()).toContain("fetched at 23:14:05 SGT · 10:14:05 ET");
    expect(line()).not.toContain("+08:00");
  });

  it("moves when the refresh button is pressed, which is the whole point", async () => {
    servePage();
    at(arrangement, "2026-11-10T15:00:00Z");
    render(<Next />);
    await waitFor(() => expect(line()).toContain("screen updated 23:00:00 SGT"));
    await waitFor(() => expect(button().disabled).toBe(false));

    vi.setSystemTime(new Date("2026-11-10T15:01:07Z"));
    fireEvent.click(button());
    await waitFor(() => expect(line()).toContain("screen updated 23:01:07 SGT"));
  });

  it("says nothing of the kind before the first fetch lands", () => {
    // a time written before anything was fetched would be a claim about data that is not there
    window.fetch = (() => new Promise(() => {})) as typeof fetch;
    at(arrangement, "2026-11-10T15:00:00Z");
    render(<Next />);
    expect(line()).not.toMatch(/screen updated/);
  });

  it("does not move for a poll that failed, which brought no figures", async () => {
    // "screen updated" is a claim about the figures: a fetch that failed must not renew it, or the
    // stale figures under the error read as current
    const svc = servePage();
    at(arrangement, "2026-11-10T15:00:00Z");
    render(<Next />);
    await waitFor(() => expect(line()).toContain("screen updated 23:00:00 SGT"));
    await waitFor(() => expect(button().disabled).toBe(false));

    svc.refuse.add("/quotes");
    vi.setSystemTime(new Date("2026-11-10T15:01:07Z"));
    fireEvent.click(button());
    await screen.findByRole("alert");
    expect(line()).toContain("screen updated 23:00:00 SGT");
  });
});
