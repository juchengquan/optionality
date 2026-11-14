/** The poll's cadence, the refresh setting and the manual refresh, on `/opt/next` (#337) — carried
 *  from `Refresh.test.tsx` and `Interval.test.tsx`, which hold them against today's `App` and go
 *  with it in #301.
 *
 *  Every poll and every press is a live call: `/quotes` is one full-watchlist snapshot from the
 *  Provider (ADR 0010). So the button guards against overlapping itself, and restarts the poll
 *  clock — a press one second before a tick would otherwise cost two snapshots a second apart.
 *
 *  Both arrangements: jsdom's window is 0 wide, which is the phone; the desk is forced the way the
 *  owner forces it, by the arrangement cookie. Only the clock and the poll's interval are faked,
 *  installed BEFORE render (Interval.test.tsx says why): the fetches resolve on real microtasks.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../next/Next";
import { servePage, type PageService } from "../testing/pageService";
import { until } from "../testing/until";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const n of ["ui_arrangement", "ui_refresh"]) document.cookie = `${n}=;path=/;max-age=0`;
});

const arrangements = ["phone", "desk"] as const;
type Arrangement = (typeof arrangements)[number];

/** 10:00 New York on a Tuesday: in session, where the page polls everything. */
const SESSION = new Date("2026-11-10T15:00:00Z");

async function open(arrangement: Arrangement): Promise<PageService> {
  const svc = servePage();
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: SESSION });
  if (arrangement === "desk") document.cookie = "ui_arrangement=desk;path=/";
  render(<Next />);
  await waitFor(() => expect(document.querySelector('[data-ref="w-dec18"]')).toBeTruthy());
  // the first read has landed — health with it, which sets the cadence
  await waitFor(() => expect(screen.queryByText(/screen updated/)).toBeTruthy());
  await drain();
  return svc;
}

/** Lets every answer already given reach the screen: real timers, so a fake clock does not stall it. */
const drain = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

/** The poll's clock moved on by `ms`, and whatever it asked answered. */
async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await drain();
}

// queried from the DOM, not the a11y tree: with a sheet open the page behind it is aria-hidden
const button = () => document.querySelector<HTMLButtonElement>('[aria-label="refresh now"]')!;

/** Settings: the desk's side panel, or the phone's tab. */
async function openSettings(arrangement: Arrangement): Promise<HTMLElement> {
  if (arrangement === "desk") {
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    return screen.findByRole("dialog", { name: "Settings" });
  }
  fireEvent.click(within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name: "Settings" }));
  return (await screen.findByTestId("references")).closest<HTMLElement>(".nx-settings")!;
}

function closeSettings(arrangement: Arrangement) {
  if (arrangement === "desk") fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  else fireEvent.click(within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name: "Book" }));
}

describe.each(arrangements)("on the %s, the refresh button", (arrangement) => {
  it("fetches at once, without waiting for the poll", async () => {
    const svc = await open(arrangement);
    expect(svc.count("/quotes")).toBe(1);
    fireEvent.click(button());
    // no timers advanced: the automatic poll is fifteen seconds away
    await until(() => expect(svc.count("/quotes")).toBe(2));
  });

  it("will not stack a second fetch on an unfinished one", async () => {
    const svc = await open(arrangement);
    const release = svc.hold("/quotes");
    fireEvent.click(button());
    await waitFor(() => expect(button().disabled).toBe(true));
    fireEvent.click(button());
    fireEvent.click(button());
    expect(svc.count("/quotes")).toBe(2);

    release();
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(svc.count("/quotes")).toBe(2);
  });

  it("restarts the poll clock, so a press just before a tick does not cost two fetches", async () => {
    const svc = await open(arrangement);
    expect(svc.count("/quotes")).toBe(1);
    // one second short of the 15s poll
    await tick(14_000);
    expect(svc.count("/quotes")).toBe(1);

    fireEvent.click(button());
    await until(() => expect(svc.count("/quotes")).toBe(2));
    await waitFor(() => expect(button().disabled).toBe(false));
    await drain();

    // the second that remained of the old interval must no longer be owed
    await tick(1_000);
    expect(svc.count("/quotes"), "the old interval fired on top of the manual refresh").toBe(2);
    // and the poll still works afterwards
    await tick(14_000);
    expect(svc.count("/quotes"), "the poll stopped after a manual refresh").toBe(3);
  });
});

describe.each(arrangements)("on the %s, the poll's cadence", (arrangement) => {
  it("is the service's sweep until one is chosen", async () => {
    const svc = await open(arrangement);
    await tick(14_000);
    expect(svc.count("/quotes")).toBe(1);
    await tick(1_000);
    expect(svc.count("/quotes"), "it never polled at the service's 15s").toBe(2);
  });

  it("is the one chosen in Settings, which it remembers", async () => {
    const svc = await open(arrangement);
    const settings = await openSettings(arrangement);
    fireEvent.change(within(settings).getByLabelText("refresh every"), { target: { value: "60" } });
    expect(document.cookie, "and remembers it").toContain("ui_refresh=60");
    closeSettings(arrangement);
    await drain();
    const before = svc.count("/quotes");

    await tick(20_000);
    expect(svc.count("/quotes"), "it kept polling at 15s").toBe(before);
    await tick(40_000);
    expect(svc.count("/quotes"), "it never polled at 60s").toBe(before + 1);
  });

  /** The half a mutation sweep found nothing stating on `/opt` (Interval.test.tsx): the default is
   *  the service's own cadence, so the cookie and the sweep are only told apart when they differ. */
  it("is the one remembered from an earlier visit, not the service's", async () => {
    document.cookie = "ui_refresh=60;path=/";
    const svc = await open(arrangement);
    expect(svc.count("/quotes")).toBe(1);
    // the service sweeps every 15s, so a page that ignored the cookie would have polled by now
    await tick(20_000);
    expect(svc.count("/quotes"), "it fell back to the service's 15s").toBe(1);
    await tick(40_000);
    expect(svc.count("/quotes"), "it never polled at the remembered 60s").toBe(2);
  });

  it("keeps going while Settings is merely open, so nothing on the page freezes", async () => {
    // the one place the cadence is set: "I chose 30 seconds and watched nothing happen" has no
    // other explanation once the clock itself is proven. Focused deliberately, as a focus trap
    // would put it, so the test states the case rather than relying on jsdom's focus handling.
    const svc = await open(arrangement);
    const settings = await openSettings(arrangement);
    (within(settings).getByLabelText("refresh every") as HTMLElement).focus();
    await tick(15_000);
    expect(svc.count("/quotes"), "open Settings stopped the poll").toBe(2);
  });
});

describe("on the phone, the poll", () => {
  it("keeps going while a card's detail sheet is open, which follows the live figures", async () => {
    const svc = await open("phone");
    fireEvent.click(screen.getByRole("button", { name: "details of 1218_P7150" }));
    const sheet = await screen.findByRole("dialog");
    within(sheet).getAllByRole("button")[0]!.focus();
    await tick(15_000);
    expect(svc.count("/quotes"), "an open sheet stopped the poll").toBe(2);
  });
});
