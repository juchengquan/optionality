/** What a holding's detail reads once — its payoff, its samples, its pace split — is read again when
 *  what it was read FOR changes: a leg's quantity corrected (#359), or the Entry, the count or
 *  Opened edited. Keyed on the holding's id alone, the payoff went on drawing the old curve after a
 *  correction, and the history and the split the old figures, until the page was reloaded. A poll's
 *  new valuation of the same holding, which changes none of them, asks nothing (`History.tsx`). */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { Next } from "../Next";
import type { Holding } from "../shared/api";
import { holdingService } from "../testing/holdingService";
import { HOLDINGS } from "../testing/ownerBook";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.cookie = "ui_arrangement=;path=/;max-age=0";
});

/** h-ic with an exit schedule, so its pace is explained and its split asked for */
const SCHEDULED = HOLDINGS.map((h) => (h.id !== "h-ic" ? h : {
  ...h, schedule: {
    on_pace: 1.5, pace_gap: 0.3, target: 1, stop: 4, target_dte: 10, manage_by_dte: 21,
    reached: null, manage_by_due: false, dte_at_open: 45,
  },
} as Holding));

const drain = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });

for (const arrangement of ["desk", "phone"] as const) {
  it(`${arrangement}: asks the payoff, the samples and the split again after a leg's quantity is corrected`, async () => {
    const s = holdingService({ holdings: SCHEDULED });
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T17:00:00Z") });
    document.cookie = `ui_arrangement=${arrangement};path=/`;
    vi.stubGlobal("fetch", s.fetch);
    render(<Next />);
    await waitFor(() => expect(document.querySelector('[data-ref="h-ic"]')).not.toBeNull());
    let d: HTMLElement;
    if (arrangement === "desk") {
      fireEvent.click(document.querySelector<HTMLElement>('.nxd-row[data-ref="h-ic"] .nxd-name')!);
      d = screen.getByRole("complementary", { name: /^inspector:/ });
    } else {
      fireEvent.click(within(document.querySelector<HTMLElement>('article[data-ref="h-ic"]')!).getAllByRole("button")[0]!);
      d = await screen.findByRole("dialog");
    }
    // the history is shut in session: opened, it reads the samples
    fireEvent.click(within(d).getByRole("button", { name: "History" }));
    await drain();
    const gets = (path: string) => s.sent.filter((x) => x.method === "GET" && x.path === path).length;
    const asked = () => [gets("/positions/h-ic/payoff"), gets("/positions/h-ic/samples"), gets("/positions/h-ic/vol")];
    expect(asked()).toEqual([1, 1, 1]);

    // a poll's new valuation of the same holding asks none of them again
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "refresh now", hidden: true })); });
    await drain();
    expect(asked()).toEqual([1, 1, 1]);

    fireEvent.click(within(d).getByRole("button", { name: "edit" }));
    const form = within(d).getByRole("form", { name: "edit 1231_IC" });
    fireEvent.change(within(form).getByLabelText("quantity, short PUT 6300"), { target: { value: "2" } });
    fireEvent.click(within(form).getByRole("button", { name: "save" }));
    await waitFor(() => expect(s.sent.some((x) => x.method === "PATCH")).toBe(true));
    await drain();
    await drain();
    expect(JSON.stringify(s.stored.get("h-ic")!.legs)).toContain('"qty":2');
    // the corrected legs, valued: each is read again, once
    expect(asked()).toEqual([2, 2, 2]);
  });
}
