/** When this SCREEN last fetched, which is not when the service last did — on `/opt/next` (#337),
 *  carried from `ScreenUpdated.test.tsx`, which holds it against today's `App` and goes with it in
 *  #301.
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

import { Next } from "../next/Next";
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
    // 10:00 New York, which the device (TZ=UTC in this suite) reads as 15:00:00
    at(arrangement, "2026-11-10T15:00:00Z");
    render(<Next />);
    await waitFor(() => expect(line()).toContain("screen updated 15:00:00"));
    // and the service's own figure stays, worded distinctly: it says how fresh the FIGURES are,
    // where this says only how recently they reached the screen
    expect(line()).toContain("fetched at 2026-11-10 23:14:05+08:00");
  });

  it("moves when the refresh button is pressed, which is the whole point", async () => {
    servePage();
    at(arrangement, "2026-11-10T15:00:00Z");
    render(<Next />);
    await waitFor(() => expect(line()).toContain("screen updated 15:00:00"));
    await waitFor(() => expect(button().disabled).toBe(false));

    vi.setSystemTime(new Date("2026-11-10T15:01:07Z"));
    fireEvent.click(button());
    await waitFor(() => expect(line()).toContain("screen updated 15:01:07"));
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
    await waitFor(() => expect(line()).toContain("screen updated 15:00:00"));
    await waitFor(() => expect(button().disabled).toBe(false));

    svc.refuse.add("/quotes");
    vi.setSystemTime(new Date("2026-11-10T15:01:07Z"));
    fireEvent.click(button());
    await screen.findByRole("alert");
    expect(line()).toContain("screen updated 15:00:00");
  });
});
