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

import type { Reference } from "../shared/api";
import { Next } from "../next/Next";
import { serveEditing } from "../testing/editBook";
import { until } from "../testing/until";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.cookie = "ui_arrangement=;path=/;max-age=0";
});

const SPX: Reference = {
  id: "r1", code: "SPX", label: "SPX", source: "ibkr", name: null,
  figure: 7376.86, field: "last_price", change: 0.0031, error: null,
  delayed: null, last_known: null, delayed_by_minutes: null, fetched_at: "2026-11-10 21:04:11+08:00",
};

/** One call to `/references`, answered when the test chooses: with rows, or with a refusal. */
interface Held { answer: (rows: Reference[]) => void; refuse: (why: string) => void }

/** The owner's book from a service that writes (`serveEditing`), its `/references` held back, and
 *  keeping or dropping a Reference answered as the service answers it.
 *  @param refuse every call to `/references` refused at once, as a vendor that is down */
function serve(refuse = false) {
  const writes = serveEditing();
  const served = window.fetch;
  const held: Held[] = [];
  /** every write and every `/references` read, in the order the page made them */
  const log: string[] = [];
  const reply = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);
  window.fetch = ((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    if (method === "POST" && path === "/references") {
      log.push("POST /references");
      return reply(201, { ...SPX, id: "r2", code: "US.QQQ", label: null, figure: null });
    }
    if (method === "DELETE" && path.startsWith("/references/")) {
      log.push(`DELETE ${path}`);
      return reply(204, null);
    }
    if (path !== "/references") return served(url, init);
    log.push("GET /references");
    if (refuse) return Promise.reject(new Error("yahoo unreachable"));
    return new Promise((resolve, reject) => {
      held.push({
        answer: (rows) =>
          resolve({ ok: true, status: 200, json: () => Promise.resolve(rows) } as Response),
        refuse: (why) => reject(new Error(why)),
      });
    });
  }) as typeof fetch;
  return { writes, held, log };
}

const arrangements = ["phone", "desk"] as const;
type Arrangement = (typeof arrangements)[number];

/** The page at 10:00 New York on a Tuesday, in session: where it polls its References. */
async function open(arrangement: Arrangement, { poll = false } = {}) {
  // the poll's timer made fake only where a test drives it: the page's other waits stay real
  const toFake = poll ? ["Date", "setInterval", "clearInterval"] as const : ["Date"] as const;
  vi.useFakeTimers({ toFake: [...toFake], now: new Date("2026-11-10T15:00:00Z") });
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
    await until(() => expect(home.contains(document.activeElement)
      && document.activeElement?.matches("h2, h3, h4")).toBe(true));
    // the save's reload wants the References too: not a second call beside the silent one, but
    // one more once it has answered
    expect(held).toHaveLength(1);
    expect(strip()).toBeNull();

    // and they catch up on their own, when they land
    held[0]!.answer([SPX]);
    await waitFor(() => expect(held).toHaveLength(2));
    held[1]!.answer([SPX]);
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
    await until(() => expect(home.contains(document.activeElement)
      && document.activeElement?.matches("h2, h3, h4")).toBe(true));
    await drain();
    // the strip goes away rather than showing figures it cannot vouch for, and that is all:
    // no banner, no toast, no refusal beside the buttons
    expect(strip()).toBeNull();
    expect(document.body.textContent).not.toContain("yahoo unreachable");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe.each(arrangements)("on the %s, one Reference call in flight at a time", (arrangement) => {
  /** Presses "refresh now" as the owner would, waiting for each press to finish. */
  async function press(times: number) {
    for (let i = 0; i < times; i += 1) {
      const button = screen.getByRole("button", { name: "refresh now", hidden: true });
      await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
      fireEvent.click(button);
    }
    const button = () => screen.getByRole("button", { name: "refresh now", hidden: true });
    await waitFor(() => expect(button().hasAttribute("disabled")).toBe(false));
  }

  it("asks once more, and only once, however many presses came while one was out", async () => {
    // the button is free again as soon as the line lands, so a silent source must not turn six
    // presses into seven calls stacked against it
    const { held } = serve();
    await open(arrangement);
    await screen.findByRole("button", { name: "refresh now", hidden: true });
    await press(6);
    await drain();
    expect(held, "a call was asked beside one still out").toHaveLength(1);

    held[0]!.answer([{ ...SPX, figure: 7376.86 }]);
    await waitFor(() => expect(held).toHaveLength(2));
    // the follow-up, asked after every press, is what the strip shows once it lands
    held[1]!.answer([{ ...SPX, figure: 7549.94 }]);
    await waitFor(() => expect(strip()?.textContent).toContain("7,549.94"));
    await drain();
    expect(held, "one follow-up for all six presses").toHaveLength(2);
  });

  it("asks nothing more when nothing was wanted while it was out", async () => {
    const { held } = serve();
    await open(arrangement);
    held[0]!.answer([SPX]);
    await waitFor(() => expect(strip()?.textContent).toContain("7,376.86"));
    await drain();
    expect(held).toHaveLength(1);
  });

  it("never lets an older answer land over a newer one, a refusal included", async () => {
    const { held } = serve();
    await open(arrangement);
    await press(1);
    held[0]!.answer([{ ...SPX, figure: 7376.86 }]);
    await waitFor(() => expect(held).toHaveLength(2));
    held[1]!.answer([{ ...SPX, figure: 7549.94 }]);
    await waitFor(() => expect(strip()?.textContent).toContain("7,549.94"));
    await press(1);
    await waitFor(() => expect(held).toHaveLength(3));
    held[2]!.refuse("ibkr went away");
    // the newest answer is the refusal, and it takes the strip away rather than keeping figures
    // nobody can vouch for
    await waitFor(() => expect(strip()).toBeNull());
  });

  it("does not stack the poll's calls against a silent source either", async () => {
    const { held } = serve();
    await open(arrangement, { poll: true });
    await screen.findByRole("button", { name: "refresh now", hidden: true });
    // the 15 s poll, six times over
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
      await drain();
    }
    expect(held, "a poll asked beside a call still out").toHaveLength(1);
    held[0]!.answer([SPX]);
    await drain();
    expect(held).toHaveLength(2);
  });
});

describe.each(arrangements)("on the %s, keeping a Reference while they are slow", (arrangement) => {
  async function openSettings() {
    fireEvent.click(await screen.findByRole("button", { name: /^settings$/i }));
    return screen.findByTestId("references");
  }

  it("reads them again by a call that starts AFTER the write, and says so until it lands", async () => {
    const { held, log } = serve();
    await open(arrangement);
    const refs = await openSettings();
    // the page's first read is still out when the owner keeps one
    expect(held).toHaveLength(1);
    fireEvent.change(within(refs).getByLabelText("code"), { target: { value: "US.QQQ" } });
    fireEvent.click(within(refs).getByRole("button", { name: "keep it" }));
    await waitFor(() => expect(log).toContain("POST /references"));
    // pending, said where it was asked, and not to be asked twice meanwhile
    await within(refs).findByText("refreshing references…");
    expect(within(refs).getByRole("button", { name: "keep it" }).hasAttribute("disabled")).toBe(true);
    // the boxes clear as soon as the service said yes, as they always have
    await waitFor(() => expect((within(refs).getByLabelText("code") as HTMLInputElement).value).toBe(""));

    // the read from before the write answers, without the new one: still pending
    held[0]!.answer([SPX]);
    await waitFor(() => expect(held).toHaveLength(2));
    expect(log.lastIndexOf("GET /references"), "the follow-up started before the write")
      .toBeGreaterThan(log.indexOf("POST /references"));
    await drain();
    expect(within(refs).getByText("refreshing references…")).toBeTruthy();
    expect(within(refs).getByRole("button", { name: "remove" }).hasAttribute("disabled")).toBe(true);

    // the read from after it lands, and the list is the service's again
    held[1]!.answer([SPX, { ...SPX, id: "r2", code: "US.QQQ", label: null, figure: 512.3 }]);
    await waitFor(() => expect(within(refs).queryByText("refreshing references…")).toBeNull());
    expect(within(refs).getAllByRole("button", { name: "remove" })).toHaveLength(2);
    expect(within(refs).getByRole("button", { name: "keep it" }).hasAttribute("disabled")).toBe(false);
    for (const b of within(refs).getAllByRole("button", { name: "remove" })) {
      expect(b.hasAttribute("disabled")).toBe(false);
    }
  });

  it("says nothing is pending when nothing was asked", async () => {
    const { held } = serve();
    await open(arrangement);
    const refs = await openSettings();
    held[0]!.answer([SPX]);
    await within(refs).findByRole("button", { name: "remove" });
    expect(within(refs).queryByText("refreshing references…")).toBeNull();
  });
});
