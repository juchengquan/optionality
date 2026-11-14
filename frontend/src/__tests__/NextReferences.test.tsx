/** The Reference strip, and the Settings panel that keeps one (ADR 0018) — carried from
 *  `References.test.tsx` (#337), which held them against the old page's `App` until #301 deleted
 *  both. A slow source is `NextSlowReferences.test.tsx`'s; the strip outside the session, `NextPage`'s.
 *
 *  Both arrangements: Settings is the desk's side panel and the phone's tab, and the strip sits on
 *  both. 10:00 New York on a Tuesday, in session, where the strip is polled.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SOURCES } from "backend/schemas";

import type { Reference } from "../shared/api";
import { Next } from "../Next";
import { servePage, SPX_REFERENCE as SPX, type PageService } from "../testing/pageService";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.cookie = "ui_arrangement=;path=/;max-age=0";
});

const arrangements = ["phone", "desk"] as const;
type Arrangement = (typeof arrangements)[number];

async function open(arrangement: Arrangement, references: Reference[]): Promise<PageService> {
  const svc = servePage(references);
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T15:00:00Z") });
  if (arrangement === "desk") document.cookie = "ui_arrangement=desk;path=/";
  render(<Next />);
  await waitFor(() => expect(document.querySelector('[data-ref="w-dec18"]')).toBeTruthy());
  await waitFor(() => expect(svc.count("/references")).toBe(1));
  return svc;
}

const strip = () => document.querySelector(".nx .references");
const drain = () => new Promise((r) => setTimeout(r, 50));

/** The References panel in Settings: the desk's side panel, or the phone's tab. */
async function panel(arrangement: Arrangement): Promise<HTMLElement> {
  if (arrangement === "desk") fireEvent.click(screen.getByRole("button", { name: "settings" }));
  else fireEvent.click(within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name: "Settings" }));
  return screen.findByTestId("references");
}

describe.each(arrangements)("on the %s, the strip", (arrangement) => {
  it("draws the figure the poll brought back", async () => {
    await open(arrangement, [SPX]);
    await waitFor(() => expect(strip()).toBeTruthy());
    expect(within(strip() as HTMLElement).getByText("SPX (moomoo)")).toBeTruthy();
    expect(within(strip() as HTMLElement).getByText("7,587.30")).toBeTruthy();
  });

  it("sits BELOW what needs you, which must stay the conspicuous line", async () => {
    // the needs-you line appears rather than reports, and a line that is almost always the same
    // becomes furniture — which this strip is by design, so it must not take that position. The
    // owner's book has two rules that fired, so the line has something to say.
    await open(arrangement, [SPX]);
    await waitFor(() => expect(strip()).toBeTruthy());
    const needs = screen.getByRole("status", { name: "needs you" });
    expect(needs.compareDocumentPosition(strip()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("stays away entirely while nothing is kept", async () => {
    await open(arrangement, []);
    await drain();
    expect(strip()).toBeNull();
  });

  it("goes away rather than showing figures it cannot vouch for", async () => {
    // a refusal here must neither blank the book nor leave a stale index level reading as current
    const svc = await open(arrangement, [SPX]);
    await waitFor(() => expect(strip()?.textContent).toContain("7,587.30"));
    svc.refuse.add("/references");
    fireEvent.click(document.querySelector('[aria-label="refresh now"]')!);
    await waitFor(() => expect(svc.count("/references")).toBe(2));
    await waitFor(() => expect(strip()).toBeNull());
    // and the page is not claiming a failed poll: the book's own figures arrived
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toMatch(/502|references failed/);
    expect(document.querySelector('[data-ref="w-dec18"]')).toBeTruthy();
  });
});

describe.each(arrangements)("on the %s, keeping one", (arrangement) => {
  it("posts the code, the label and the source", async () => {
    const svc = await open(arrangement, []);
    const refs = await panel(arrangement);
    fireEvent.change(within(refs).getByLabelText("code"), { target: { value: "US.SPY" } });
    fireEvent.change(within(refs).getByLabelText("call it"), { target: { value: "SPX" } });
    fireEvent.change(within(refs).getByLabelText("from"), { target: { value: "ibkr" } });
    fireEvent.click(within(refs).getByRole("button", { name: "keep it" }));
    await waitFor(() => expect(svc.writes).toHaveLength(1));
    expect(svc.writes[0]).toEqual({
      what: "POST /references", body: { code: "US.SPY", label: "SPX", source: "ibkr" },
    });
    // and it is listed once the service says it is kept
    await waitFor(() => expect(within(refs).getByText(/SPX \(ibkr\)/)).toBeTruthy());
  });

  it("sends no label where that box was left alone, and the default source", async () => {
    // the label is absent rather than null or empty — the service reads a missing one as "the
    // code is its own name". The source is never absent: it is required, and defaults to moomoo
    const svc = await open(arrangement, []);
    const refs = await panel(arrangement);
    fireEvent.change(within(refs).getByLabelText("code"), { target: { value: "US.QQQ" } });
    fireEvent.click(within(refs).getByRole("button", { name: "keep it" }));
    await waitFor(() => expect(svc.writes).toHaveLength(1));
    expect(svc.writes[0]!.body).toEqual({ code: "US.QQQ", source: "moomoo" });
  });

  it("offers exactly the vendors the backend knows about", async () => {
    // the schema's list, not the component's: a vendor added beside its client reaches this box
    // with nobody editing a form, and one removed leaves it
    await open(arrangement, []);
    const refs = await panel(arrangement);
    const select = within(refs).getByLabelText("from") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([...SOURCES]);
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([...SOURCES]);
  });

  it("states the reason a kept Reference has no figure, which the strip only hints at", async () => {
    await open(arrangement, [{
      ...SPX, code: "US..SPX", figure: null, field: null, change: null, name: null,
      error: "snapshot API failed: US stock indices are not supported",
    }]);
    const refs = await panel(arrangement);
    await waitFor(() => expect(refs.textContent).toContain("US stock indices are not supported"));
  });

  it("offers to remove one, and asks first", async () => {
    const svc = await open(arrangement, [SPX]);
    const refs = await panel(arrangement);
    fireEvent.click(await within(refs).findByRole("button", { name: "remove" }));
    // the confirmation, because nothing here is removed by a misclick
    const confirm = within(await screen.findByRole("alertdialog"));
    expect(confirm.getByText(/Delete SPX \(moomoo\)\?/)).toBeTruthy();
    expect(svc.writes).toEqual([]);
    fireEvent.click(confirm.getByRole("button", { name: /delete|remove/i }));
    await waitFor(() => expect(svc.writes).toEqual([{ what: "DELETE /references/r1", body: null }]));
    // and the list is the service's again: nothing kept
    await waitFor(() => expect(refs.textContent).toContain("nothing kept"));
  });
});
