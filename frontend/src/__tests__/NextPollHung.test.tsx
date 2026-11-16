/** One read that never settles — a socket dead without a reset — must not stop the poll for good.
 *  The poll skips a tick while its last read is out (`skipWhileOut`, `NextPollStack`), so without a
 *  bound it skipped every tick after a hung one, for ever, and the page drew its last figures as
 *  current. Bounded: a read out longer than `givenUpAfter` is given up on and the next tick asks
 *  again; a refresh gives it up at once. And a late answer still lands only if no newer one has. */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { givenUpAfter } from "../poll";
import { servePage } from "../testing/pageService";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.cookie = "ui_arrangement=;path=/;max-age=0";
});

const drain = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(15_000); }); await drain(); };

async function hangOneQuotes() {
  const svc = servePage();
  // 10:00 New York on a Tuesday: in session
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: new Date("2026-11-10T15:00:00Z") });
  render(<Next />);
  await waitFor(() => expect(screen.queryByText(/screen updated/)).toBeTruthy());
  await drain();
  // exactly ONE /quotes hangs for ever; every later one answers
  const inner = window.fetch;
  let hung = false;
  window.fetch = ((url: string, init?: RequestInit) => {
    if (!hung && String(url).endsWith("/api/quotes")) { hung = true; svc.gets.push("/quotes"); return new Promise(() => {}); }
    return inner(url, init);
  }) as typeof fetch;
  return svc;
}

it("gives a read that never settles up after a minute, and polls on", async () => {
  expect(givenUpAfter(15)).toBe(60_000);
  expect(givenUpAfter(60)).toBe(120_000);
  const svc = await hangOneQuotes();
  const q0 = svc.count("/quotes");
  // the hung one, then skipped while it is under a minute old (ticks at 15, 30, 45 s)
  for (let i = 0; i < 4; i++) await tick();
  expect(svc.count("/quotes") - q0).toBe(1);
  // given up on at 75 s: asked again, and from then on every tick asks
  await tick();
  expect(svc.count("/quotes") - q0).toBe(2);
  for (let i = 0; i < 5; i++) await tick();
  expect(svc.count("/quotes") - q0).toBe(7);
});

it("is restarted by a refresh, whatever the poll was waiting on", async () => {
  const svc = await hangOneQuotes();
  const q0 = svc.count("/quotes");
  await tick();
  expect(svc.count("/quotes") - q0).toBe(1);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "refresh now" })); });
  await drain();
  expect(svc.count("/quotes") - q0).toBe(2);
  // the next tick asks, rather than waiting on the hung one
  await tick();
  expect(svc.count("/quotes") - q0).toBe(3);
});
