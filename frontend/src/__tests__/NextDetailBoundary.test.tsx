/** One row the page cannot draw must not take the page with it (#337).
 *
 *  Found by the browser suites: a row with no `spx` field at all reached the payoff chart as
 *  `undefined`, its range came out NaN, `pnlAt` read past the end of its corners and threw — and
 *  with no error boundary in `/opt/next`, React unmounted the whole page. Two fixes, held here:
 *  `shared/api.ts` reads a missing `spx` as null, and each holding's or rule's detail (the desk's
 *  inspector, the phone's sheet) is drawn inside `DetailBoundary`, which says that one could not be
 *  drawn and leaves the rest up.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { servePage } from "../testing/pageService";

/** When set, the payoff chart of the watched spread `w-dec18` throws as it draws: a stand-in for
 *  any fault inside a detail, the boundary's subject. */
const fault = vi.hoisted(() => ({ on: false }));
vi.mock("../Payoff", async (orig) => {
  const real = await orig<typeof import("../Payoff")>();
  return {
    ...real,
    WatchedPayoff: (props: Parameters<typeof real.WatchedPayoff>[0]) => {
      if (fault.on && props.entry.id === "w-dec18") throw new Error("a payoff that cannot be drawn");
      return real.WatchedPayoff(props);
    },
  };
});

afterEach(() => {
  cleanup();
  fault.on = false;
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.cookie = "ui_arrangement=;path=/;max-age=0";
});

const arrangements = ["phone", "desk"] as const;
type Arrangement = (typeof arrangements)[number];

async function open(arrangement: Arrangement) {
  const svc = servePage();
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T15:00:00Z") });
  if (arrangement === "desk") document.cookie = "ui_arrangement=desk;path=/";
  render(<Next />);
  await waitFor(() => expect(document.querySelector('[data-ref="w-dec18"]')).toBeTruthy());
  return svc;
}

/** The detail of a row, by its name: the phone's sheet, or the desk's inspector. */
async function detail(arrangement: Arrangement, name: string): Promise<HTMLElement> {
  if (arrangement === "phone") {
    fireEvent.click(await screen.findByRole("button", { name: `details of ${name}` }));
    return screen.findByRole("dialog");
  }
  fireEvent.click(await screen.findByRole("button", { name }));
  return screen.findByRole("complementary", { name: `inspector: ${name}` });
}

describe.each(arrangements)("on the %s", (arrangement) => {
  it.each([["a watched spread", "1218_P7150"], ["a holding", "1218_P6400"]])(
    "draws %s that carries no spx field at all, payoff chart and all", async (_, name) => {
    const svc = servePage();
    const without = (rows: unknown) => (rows as Record<string, unknown>[]).map((r) => {
      const { spx: _spx, spx_reason: _why, ...rest } = r;
      return rest;
    });
    svc.alter.set("/quotes", without);
    svc.alter.set("/positions/values", without);
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T15:00:00Z") });
    if (arrangement === "desk") document.cookie = "ui_arrangement=desk;path=/";
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Next />);
    await waitFor(() => expect(document.querySelector('[data-ref="w-dec18"]')).toBeTruthy());

    const home = await detail(arrangement, name);
    const payoff = await within(home).findByRole("group", { name: "payoff at expiry" });
    await waitFor(() => expect(payoff.querySelector("svg")).toBeTruthy());
    expect(within(home).queryByRole("alert")).toBeNull();
  });

  it("says a detail that throws could not be drawn, and keeps the page up", async () => {
    await open(arrangement);
    fault.on = true;
    // React reports the error it caught; the boundary is what keeps it from going further
    vi.spyOn(console, "error").mockImplementation(() => {});
    const home = await detail(arrangement, "1218_P7150");
    expect(await within(home).findByText("this rule could not be drawn")).toBeTruthy();
    // the rest of the page is where it was
    expect(document.querySelector(".nx")).toBeTruthy();
    expect(document.querySelector('[data-ref="h-calls"]')).toBeTruthy();
    expect(document.querySelector('[aria-label="refresh now"]')).toBeTruthy();
  });

  it("draws the next row afresh after one that could not be drawn", async () => {
    await open(arrangement);
    fault.on = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const first = await detail(arrangement, "1218_P7150");
    await within(first).findByText("this rule could not be drawn");
    if (arrangement === "phone") {
      fireEvent.keyDown(first, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    const next = await detail(arrangement, "1218_P6400");
    await within(next).findByRole("group", { name: "payoff at expiry" });
    expect(within(next).queryByText(/could not be drawn/)).toBeNull();
  });
});
