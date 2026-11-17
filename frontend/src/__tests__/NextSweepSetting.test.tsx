/** The service's sweep, set from Settings (#442, ADR 0025): distinct from this page's own "refresh
 *  every", stored by the service and in force at its next sweep. The owner's decisions: presets of
 *  5, 10, 15, 30 and 60 seconds and a way back to `.env`'s default; the header saying both cadences.
 *
 *  The service is `servePage`'s, with `PATCH /settings` answered here as the route answers it and
 *  `/health` altered to say what is in force — so what the page shows after a choice is what it READ
 *  back, never what it assumed.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../Next";
import { servePage, type PageService } from "../testing/pageService";

afterEach(() => {
  cleanup();
  for (const n of ["ui_arrangement", "ui_refresh"]) document.cookie = `${n}=;path=/;max-age=0`;
});

const PRESETS = [5, 10, 15, 30, 60];

interface SweepService extends PageService {
  /** every PATCH /settings, with its body */
  chosen: unknown[];
  /** the refusal the next PATCH gets, in the service's words, or null to take it */
  refusal: string | null;
}

/** `.env` sweeps every 15s; the page has chosen nothing until a test does. */
function serveSweep(): SweepService {
  const page = servePage();
  const state = { seconds: null as number | null };
  const svc = Object.assign(page, { chosen: [] as unknown[], refusal: null as string | null });
  page.alter.set("/health", (h) => {
    const health = h as { settings: Record<string, unknown> };
    return {
      ...health,
      settings: {
        ...health.settings,
        sweep_seconds: state.seconds ?? 15, sweep_source: state.seconds === null ? "env" : "settings",
        sweep_default_seconds: 15, sweep_presets: PRESETS,
      },
    };
  });
  const inner = window.fetch;
  window.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    if (init?.method === "PATCH" && path === "/settings") {
      const body = JSON.parse(String(init.body)) as { sweep_seconds: number | null };
      svc.chosen.push(body);
      const reply = (status: number, b: unknown) =>
        ({ ok: status < 400, status, json: () => Promise.resolve(b) }) as Response;
      if (svc.refusal !== null) return reply(422, { detail: svc.refusal });
      state.seconds = body.sweep_seconds;
      return reply(200, {
        sweep_seconds: state.seconds ?? 15, sweep_source: state.seconds === null ? "env" : "settings",
        sweep_default_seconds: 15, sweep_presets: PRESETS,
      });
    }
    return inner(url, init);
  }) as typeof fetch;
  return svc;
}

async function open(): Promise<SweepService> {
  const svc = serveSweep();
  render(<Next />);
  await waitFor(() => expect(screen.queryByText(/screen updated/)).toBeTruthy());
  return svc;
}

async function openSettings(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "settings" }));
  return screen.findByRole("dialog", { name: "Settings" });
}

const sweepBox = (settings: HTMLElement) =>
  within(settings).getByLabelText("service sweeps every") as HTMLSelectElement;

describe("the service's sweep in Settings", () => {
  it("offers the presets and the way back to .env's, which is what is in force until one is chosen", async () => {
    await open();
    const box = sweepBox(await openSettings());
    expect([...box.options].map((o) => o.textContent))
      .toEqual(["default (.env, 15s)", "5s", "10s", "15s", "30s", "60s"]);
    expect(box.value).toBe("default");
  });

  it("is a box of its own, apart from this page's refresh, whose note no longer speaks for it", async () => {
    await open();
    const settings = await openSettings();
    expect(within(settings).getByLabelText("refresh every")).not.toBe(sweepBox(settings));
    const note = within(settings).getByText(/Each poll is a live call/);
    expect(note.textContent).toMatch(/this page/i);
    expect(note.textContent, "the sweep has its own box now").not.toMatch(/sweeps every/);
  });

  it("sends a choice to the service, then reads /health back and shows what is in force", async () => {
    const svc = await open();
    const settings = await openSettings();
    const healthReads = svc.count("/health");
    fireEvent.change(sweepBox(settings), { target: { value: "5" } });
    await waitFor(() => expect(svc.chosen).toEqual([{ sweep_seconds: 5 }]));
    await waitFor(() => expect(svc.count("/health"), "/health was not read again").toBeGreaterThan(healthReads));
    await waitFor(() => expect(sweepBox(settings).value).toBe("5"));
    expect(document.body.textContent).toContain("service sweeps every 5s");
  });

  it("goes back to .env's with null", async () => {
    const svc = await open();
    const settings = await openSettings();
    fireEvent.change(sweepBox(settings), { target: { value: "30" } });
    await waitFor(() => expect(sweepBox(settings).value).toBe("30"));
    fireEvent.change(sweepBox(settings), { target: { value: "default" } });
    await waitFor(() => expect(svc.chosen).toEqual([{ sweep_seconds: 30 }, { sweep_seconds: null }]));
    await waitFor(() => expect(sweepBox(settings).value).toBe("default"));
  });

  it("says a refusal where the choice was made, and keeps showing what is in force", async () => {
    const svc = await open();
    const settings = await openSettings();
    svc.refusal = "✖ Invalid option: expected one of 5|10|15|30|60\n  → at sweep_seconds";
    fireEvent.change(sweepBox(settings), { target: { value: "10" } });
    const said = await within(settings).findByRole("alert");
    expect(said.textContent).toContain("Invalid option");
    expect(sweepBox(settings).value, "a refused choice shown as if it were in force").toBe("default");
    // and the next choice that is taken clears it
    svc.refusal = null;
    fireEvent.change(sweepBox(settings), { target: { value: "10" } });
    await waitFor(() => expect(within(settings).queryByRole("alert")).toBeNull());
  });
});

describe("the header", () => {
  it("says both cadences: this page's refresh and the service's sweep", async () => {
    document.cookie = "ui_refresh=5;path=/";
    await open();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByText(/screen updated/).textContent)
      .toMatch(/ · refreshes every 5s · service sweeps every 15s$/);
  });
});
