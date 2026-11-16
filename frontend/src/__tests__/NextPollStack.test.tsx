/** A Provider slower than the poll is asked once at a time (ADR 0010: polling is not free). Each
 *  read the poll makes — the line (`/quotes` with the rules and health) and the holdings' valuation
 *  — is skipped by a tick while the one it asked last is still out (`skipWhileOut`), so four ticks
 *  against a held `/quotes` are one call, never four stacked against OpenD's request limit; the
 *  first tick after it answers asks again. */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { servePage } from "../testing/pageService";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.cookie = "ui_arrangement=;path=/;max-age=0";
});

const drain = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

it("asks the line and the valuation once at a time while the Provider is slower than the poll", async () => {
  const svc = servePage();
  // 10:00 New York on a Tuesday: in session, so every poll asks for the valuation too
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: new Date("2026-11-10T15:00:00Z") });
  render(<Next />);
  await waitFor(() => expect(screen.queryByText(/screen updated/)).toBeTruthy());
  await drain();
  const quotes = svc.count("/quotes");
  const values = svc.count("/positions/values");
  const quotesBack = svc.hold("/quotes");
  const valuesBack = svc.hold("/positions/values");

  for (let i = 0; i < 4; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await drain();
  }
  // the first tick's, still out: the three after it asked nothing beside it
  expect(svc.count("/quotes") - quotes).toBe(1);
  expect(svc.count("/positions/values") - values).toBe(1);

  // answered, the ticks it covered ask nothing more: the next tick asks again
  quotesBack();
  valuesBack();
  await drain();
  expect(svc.count("/quotes") - quotes).toBe(1);
  expect(svc.count("/positions/values") - values).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  await drain();
  expect(svc.count("/quotes") - quotes).toBe(2);
  expect(svc.count("/positions/values") - values).toBe(2);
});
