/** Does a reload wipe a half-typed box? On `/opt/next` (#337) — carried from `Wipe.test.tsx`, which
 *  asks it of today's `App` and goes with it in #301.
 *
 *  The poll waits while a form is held open (`NextPollGuard`), but the manual refresh consults no
 *  guard by design — a press is not something done to you — and a save elsewhere reloads the page
 *  too. So a reload CAN land mid-edit, with the service answering a different figure than the one
 *  the form opened on, and what was typed must survive it.
 *
 *  Both arrangements: the rule's edit form in the desk's inspector and in the phone's sheet, and the
 *  add form in the desk's panel and the phone's sheet.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Entry, Monitor } from "../shared/api";
import { Next } from "../next/Next";
import { servePage, type PageService } from "../testing/pageService";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.cookie = "ui_arrangement=;path=/;max-age=0";
});

const arrangements = ["phone", "desk"] as const;
type Arrangement = (typeof arrangements)[number];

async function open(arrangement: Arrangement): Promise<PageService> {
  const svc = servePage();
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T15:00:00Z") });
  if (arrangement === "desk") document.cookie = "ui_arrangement=desk;path=/";
  render(<Next />);
  await waitFor(() => expect(document.querySelector('[data-ref="w-dec18"]')).toBeTruthy());
  return svc;
}

// queried from the DOM, not the a11y tree: with a sheet open the page behind it is aria-hidden,
// which is itself why the manual refresh is no way out of a held poll
const refresh = () => fireEvent.click(document.querySelector('[aria-label="refresh now"]')!);

/** Another tab saves the short leg's delta rule at 0.5: every later read of it says so. */
function savedElsewhere(svc: PageService) {
  const moved = <T extends Entry | Monitor>(rows: T[]) =>
    rows.map((r) => (r.id === "w-dec18-delta" ? { ...r, threshold: 0.5 } : r));
  svc.alter.set("/quotes", (rows) => moved(rows as Entry[]));
  svc.alter.set("/monitors", (rows) => moved(rows as Monitor[]));
}

describe.each(arrangements)("on the %s, a reload landing mid-edit", (arrangement) => {
  it("keeps what is typed into a rule's threshold, though the service answers another", async () => {
    const svc = await open(arrangement);
    if (arrangement === "phone") fireEvent.click(await screen.findByRole("button", { name: "details of 1218_P7150" }));
    else fireEvent.click(await screen.findByRole("button", { name: "1218_P7150" }));
    const home = arrangement === "phone" ? await screen.findByRole("dialog")
      : await screen.findByRole("complementary", { name: /^inspector/ });
    fireEvent.click(within(home).getByRole("button", { name: "edit 261218 7150P delta" }));
    const form = await within(home).findByRole("form", { name: "editing 261218 7150P delta" });
    const box = within(form).getByLabelText("threshold") as HTMLInputElement;
    expect(box.value).toBe("0.2");
    fireEvent.change(box, { target: { value: "0.9" } });

    savedElsewhere(svc);
    refresh();
    // the reload has landed: the form says what the service now holds
    await waitFor(() => expect(within(form).getByTestId("served").textContent).toContain("0.5"));

    const now = within(home).getByRole("form", { name: "editing 261218 7150P delta" });
    expect((within(now).getByLabelText("threshold") as HTMLInputElement).value, "the typed value survived")
      .toBe("0.9");
  });

  it("keeps what is typed into the add form", async () => {
    const svc = await open(arrangement);
    if (arrangement === "desk") fireEvent.click(screen.getByRole("button", { name: "add" }));
    else fireEvent.click(within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name: "Add" }));
    const form = await screen.findByRole("form", { name: "add a spread" });
    fireEvent.change(within(form).getByLabelText("expiry"), { target: { value: "2026-12-18" } });

    savedElsewhere(svc);
    vi.setSystemTime(new Date("2026-11-10T15:01:07Z"));
    const before = svc.count("/monitors");
    refresh();
    await waitFor(() => expect(svc.count("/monitors")).toBe(before + 1));
    await new Promise((r) => setTimeout(r, 50));

    const now = screen.getByRole("form", { name: "add a spread", hidden: true });
    expect((within(now).getByLabelText("expiry") as HTMLInputElement).value, "the typed expiry survived")
      .toBe("2026-12-18");
  });
});
