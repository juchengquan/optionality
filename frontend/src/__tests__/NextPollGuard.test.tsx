/** The poll waits while a form is held open (#337) — carried from `PollGuard.test.tsx`, which held
 *  it against the old page's `App` until #301 deleted both.
 *
 *  A poll redraws the book, so it must not land while something is being operated. What holds it is
 *  a surface that says so itself, `data-poll="hold"`, and the focus inside it; a list of such things
 *  rots, as the old page's did when its column picker stopped being a `<details>`. So these open the REAL
 *  controls and count the polls, rather than reading the selector: retiring the next one fails here
 *  instead of going quiet. That an open sheet on its own does NOT hold it is `NextRefresh`'s.
 *
 *  The poll's interval and the clock are faked, before render; the fetches resolve on real
 *  microtasks.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { servePage, SPX_REFERENCE, type PageService } from "../testing/pageService";
import { until } from "../testing/until";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.cookie = "ui_arrangement=;path=/;max-age=0";
});

const arrangements = ["phone", "desk"] as const;
type Arrangement = (typeof arrangements)[number];

async function open(arrangement: Arrangement): Promise<PageService> {
  const svc = servePage([SPX_REFERENCE]);
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: new Date("2026-11-10T15:00:00Z") });
  if (arrangement === "desk") document.cookie = "ui_arrangement=desk;path=/";
  render(<Next />);
  await waitFor(() => expect(document.querySelector('[data-ref="w-dec18"]')).toBeTruthy());
  await waitFor(() => expect(screen.queryByText(/screen updated/)).toBeTruthy());
  await drain();
  return svc;
}

const drain = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

/** Half a second of the faked clock, for Base UI: a popup's opening (and the focus it moves into
 *  it) waits on an interval, which the fake clock owns. Far short of a poll's 15s. */
const opened = () => act(async () => { await vi.advanceTimersByTimeAsync(500); });

/** Two of the service's 15s polls go by: how many reached `/quotes`. */
async function twoPolls(svc: PageService): Promise<number> {
  const before = svc.count("/quotes");
  for (let i = 0; i < 2; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await drain();
  }
  return svc.count("/quotes") - before;
}

/** Where the spread 1218_P7150's rules are: the phone's sheet, or the desk's inspector. */
async function openSpread(arrangement: Arrangement): Promise<HTMLElement> {
  if (arrangement === "phone") {
    fireEvent.click(await screen.findByRole("button", { name: "details of 1218_P7150" }));
    return screen.findByRole("dialog");
  }
  fireEvent.click(await screen.findByRole("button", { name: "1218_P7150" }));
  return screen.findByRole("complementary", { name: /^inspector/ });
}

describe.each(arrangements)("on the %s, the poll", (arrangement) => {
  it("goes on while nothing is being operated", async () => {
    const svc = await open(arrangement);
    expect(await twoPolls(svc)).toBe(2);
  });

  it("waits while a rule's edit form is open, and goes on once it is cancelled", async () => {
    const svc = await open(arrangement);
    const home = await openSpread(arrangement);
    fireEvent.click(within(home).getByRole("button", { name: "edit 261218 7150P delta" }));
    const form = await within(home).findByRole("form", { name: "editing 261218 7150P delta" });
    // the form puts the focus in its threshold, where the owner types
    await until(() => expect(form.contains(document.activeElement)).toBe(true));
    expect(await twoPolls(svc), "a poll landed on an open edit").toBe(0);

    fireEvent.click(within(form).getByRole("button", { name: "cancel" }));
    await waitFor(() => expect(within(home).queryByRole("form")).toBeNull());
    expect(await twoPolls(svc), "the poll never came back").toBe(2);
  });

  it("waits while a Reference's removal is being confirmed", async () => {
    const svc = await open(arrangement);
    if (arrangement === "desk") fireEvent.click(screen.getByRole("button", { name: "settings" }));
    else fireEvent.click(within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name: "Settings" }));
    const refs = await screen.findByTestId("references");
    // pressed as a finger or a mouse presses it, which is what moves the focus into what it opens
    await userEvent.click(await within(refs).findByRole("button", { name: "remove" }));
    const confirm = await screen.findByRole("alertdialog");
    await opened();
    // focus lands a tick after the dialog mounts, so this waits rather than races
    await until(() => expect(confirm.contains(document.activeElement)).toBe(true));
    expect(await twoPolls(svc), "a poll landed under the confirmation").toBe(0);
  });

  it("waits while the add form is being filled in", async () => {
    const svc = await open(arrangement);
    if (arrangement === "desk") fireEvent.click(screen.getByRole("button", { name: "add" }));
    else fireEvent.click(within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name: "Add" }));
    const form = await screen.findByRole("form", { name: "add a spread" });
    // the desk's panel focuses its first box; the phone's sheet waits for a finger, so it is put there
    if (arrangement === "phone") within(form).getByLabelText("expiry").focus();
    await until(() => expect(form.contains(document.activeElement)).toBe(true));
    expect(await twoPolls(svc), "a poll landed on a half-filled form").toBe(0);
  });
});

describe("on the desk, the poll", () => {
  it("waits while the book's column picker is open", async () => {
    // the list of columns it offers comes from the measured fit, which a poll moves underneath it
    const svc = await open("desk");
    await userEvent.click(screen.getByRole("button", { name: "book columns" }));
    const picker = await screen.findByRole("group", { name: "book columns" });
    await opened();
    await until(() => expect(picker.closest('[data-poll="hold"]')?.contains(document.activeElement)).toBe(true));
    expect(await twoPolls(svc), "a poll landed under the open picker").toBe(0);
  });
});
