/** A slow Reference source holds up nothing on `/opt/next` (#335), as it holds up nothing on `/opt`
 *  since #308 (`SlowReferences.test.tsx`, against `App`).
 *
 *  `/references` makes one bounded call per source, and a source that accepts a request and never
 *  answers it costs the whole 8 s request timeout — measured on 2026-11-10, every call, while
 *  `/quotes` took 0.02 s. `useBook` awaited it inside every save's reload, so a mute, an edit or a
 *  delete said "saving…" for those 8 s; and it had no guard, so of two calls in flight the last to
 *  ARRIVE won, stale or not. Here the References never answer until the test says so: the 8-second
 *  gateway without the wait, and a stricter one, since a save that waited would wait for ever.
 *
 *  Both arrangements: jsdom's window is 0 wide, which is the phone; the desk is forced the way the
 *  owner forces it, by the arrangement cookie.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Reference } from "../api";
import { Next } from "../next/Next";
import { serveEditing } from "../testing/editBook";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.cookie = "ui_arrangement=;path=/;max-age=0";
});

const SPX: Reference = {
  id: "r1", code: "SPX", label: "SPX", source: "ibkr", name: null,
  figure: 7376.86, field: "last_price", change: 0.0031, error: null,
  delayed: null, last_known: null, delayed_by_minutes: null,
};

/** One call to `/references`, answered when the test chooses: with rows, or with a refusal. */
interface Held { answer: (rows: Reference[]) => void; refuse: (why: string) => void }

/** The owner's book from a service that writes (`serveEditing`), its `/references` held back.
 *  @param refuse every call to `/references` refused at once, as a vendor that is down */
function serve(refuse = false) {
  const writes = serveEditing();
  const served = window.fetch;
  const held: Held[] = [];
  window.fetch = ((url: string, init?: RequestInit) => {
    if (!String(url).endsWith("/references")) return served(url, init);
    if (refuse) return Promise.reject(new Error("yahoo unreachable"));
    return new Promise((resolve, reject) => {
      held.push({
        answer: (rows) =>
          resolve({ ok: true, status: 200, json: () => Promise.resolve(rows) } as Response),
        refuse: (why) => reject(new Error(why)),
      });
    });
  }) as typeof fetch;
  return { writes, held };
}

const arrangements = ["phone", "desk"] as const;
type Arrangement = (typeof arrangements)[number];

/** The page at 10:00 New York on a Tuesday, which is LIVE: the only mode that draws the strip and
 *  polls its References. */
async function open(arrangement: Arrangement) {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T15:00:00Z") });
  if (arrangement === "desk") document.cookie = "ui_arrangement=desk;path=/";
  render(<Next />);
  await waitFor(() =>
    expect(document.querySelector(".nx")?.getAttribute("data-arrangement")).toBe(arrangement));
}

/** Where the spread 1218_P7150's rules are edited: the phone's sheet, or the desk's inspector. */
async function openSpread(arrangement: Arrangement): Promise<HTMLElement> {
  if (arrangement === "phone") {
    fireEvent.click(await screen.findByRole("button", { name: "details of 1218_P7150" }));
    return screen.findByRole("dialog");
  }
  fireEvent.click(await screen.findByRole("button", { name: "1218_P7150" }));
  return screen.findByRole("complementary", { name: /^inspector/ });
}

/** Lets every answer already given run through to the screen. */
const drain = () => new Promise((r) => setTimeout(r, 50));

const strip = () => document.querySelector(".references");

describe.each(arrangements)("on the %s, a Reference source that never answers", (arrangement) => {
  it("does not stop the book being drawn, and the strip appears when its figures do", async () => {
    const { held } = serve();
    await open(arrangement);
    await openSpread(arrangement);
    // the References are STILL in flight — nothing has answered them — and the book is drawn
    expect(held).toHaveLength(1);
    expect(strip()).toBeNull();

    held[0]!.answer([SPX]);
    await waitFor(() => expect(strip()?.textContent).toContain("7,376.86"));
  });

  it("does not hold up a mute: it finishes as soon as its own reads land", async () => {
    const { writes, held } = serve();
    await open(arrangement);
    const home = await openSpread(arrangement);
    // pressed as the owner presses it, which focuses it: the desk's inspector starts with the focus
    // on its own heading, where the mute finishing would leave it, and so could not tell
    const mute = within(home).getByRole("button", { name: "mute 261218 7150P delta" });
    mute.focus();
    fireEvent.click(mute);
    await waitFor(() =>
      expect(writes).toEqual([{ what: "PATCH /monitors/w-dec18-delta", body: { enabled: false } }]));
    // the save's reload has landed: the rule is off, listed with what is switched off
    await screen.findByRole("button", { name: "unmute 261218 7150P delta", hidden: true });
    // and the mute has FINISHED: it hands the focus on only once its write and its reads are done,
    // here to the heading of the surface the rule has left. Awaiting the References, it never would.
    await waitFor(() => expect(home.contains(document.activeElement)
      && document.activeElement?.matches("h2, h3, h4")).toBe(true));
    // the save's reload asked for the References too; none of them has answered
    expect(held.length).toBeGreaterThanOrEqual(2);
    expect(strip()).toBeNull();

    // and they catch up on their own, when they land
    for (const h of held) h.answer([SPX]);
    await waitFor(() => expect(strip()?.textContent).toContain("7,376.86"));
  });

  it("does not hold an edit at \"saving…\": the form closes when its own reads land", async () => {
    const { writes } = serve();
    await open(arrangement);
    const home = await openSpread(arrangement);
    fireEvent.click(within(home).getByRole("button", { name: "edit 261218 7150P delta" }));
    const form = await within(home).findByRole("form", { name: "editing 261218 7150P delta" });
    fireEvent.change(within(form).getByLabelText("threshold"), { target: { value: "0.25" } });
    fireEvent.click(within(form).getByRole("button", { name: "save" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    await waitFor(() =>
      expect(within(home).queryByRole("form", { name: "editing 261218 7150P delta" })).toBeNull());
    expect(screen.queryByText("saving…")).toBeNull();
  });
});

describe.each(arrangements)("on the %s, a Reference source that refuses", (arrangement) => {
  it("neither blocks a mute nor says the save or the page failed", async () => {
    const { writes } = serve(true);
    await open(arrangement);
    const home = await openSpread(arrangement);
    const mute = within(home).getByRole("button", { name: "mute 261218 7150P delta" });
    mute.focus();
    fireEvent.click(mute);
    await waitFor(() => expect(writes).toHaveLength(1));
    await screen.findByRole("button", { name: "unmute 261218 7150P delta", hidden: true });
    await waitFor(() => expect(home.contains(document.activeElement)
      && document.activeElement?.matches("h2, h3, h4")).toBe(true));
    await drain();
    // the strip goes away rather than showing figures it cannot vouch for, and that is all:
    // no banner, no toast, no refusal beside the buttons
    expect(strip()).toBeNull();
    expect(document.body.textContent).not.toContain("yahoo unreachable");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe.each(arrangements)("on the %s, two Reference calls in flight at once", (arrangement) => {
  /** Opens the page, then asks again by the refresh button: two calls, both held. */
  async function twoInFlight() {
    const { held } = serve();
    await open(arrangement);
    await screen.findByRole("button", { name: "refresh now", hidden: true });
    expect(held).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "refresh now", hidden: true }));
    await waitFor(() => expect(held).toHaveLength(2));
    return held;
  }

  it("shows the NEWER figures when the older call answers last", async () => {
    const held = await twoInFlight();
    held[1]!.answer([{ ...SPX, figure: 7549.94 }]);
    await waitFor(() => expect(strip()?.textContent).toContain("7,549.94"));
    held[0]!.answer([{ ...SPX, figure: 7376.86 }]);
    await drain();
    expect(strip()?.textContent, "the stale set overwrote the fresh one").toContain("7,549.94");
    expect(strip()?.textContent).not.toContain("7,376.86");
  });

  it("keeps the newer figures when the older call is REFUSED last", async () => {
    const held = await twoInFlight();
    held[1]!.answer([{ ...SPX, figure: 7549.94 }]);
    await waitFor(() => expect(strip()?.textContent).toContain("7,549.94"));
    held[0]!.refuse("ibkr went away");
    await drain();
    expect(strip()?.textContent, "a stale refusal took the fresh strip away").toContain("7,549.94");
  });

  it("still lands an older answer when nothing newer has", async () => {
    // not "only the latest ask lands": with a source slower than the poll every answer has a newer
    // ask behind it, and the strip would never be drawn at all
    const held = await twoInFlight();
    held[0]!.answer([{ ...SPX, figure: 7376.86 }]);
    await waitFor(() => expect(strip()?.textContent).toContain("7,376.86"));
    held[1]!.answer([{ ...SPX, figure: 7549.94 }]);
    await waitFor(() => expect(strip()?.textContent).toContain("7,549.94"));
  });
});
