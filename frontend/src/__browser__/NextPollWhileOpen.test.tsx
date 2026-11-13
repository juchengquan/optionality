/** Where the focus actually goes when the desk's Settings opens on `/opt/next` — which decides
 *  whether the page keeps polling. Carried from `PollWhileOpen.test.tsx` (#337), which asks it of
 *  today's `App` and goes with it in #301; the phone's sheets are `NextPollWhileOpen.iphone`'s.
 *
 *  jsdom leaves the focus where it was when a sheet opens, so the unit suite cannot answer this: the
 *  poll waits while the focus is inside a surface marked `data-poll="hold"` (Next.tsx), and a real
 *  focus trap moves it. Hence a real browser.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { settle } from "./nextBook";
import { holdsThePoll, serveServedBook } from "./nextCarried";

afterEach(() => { cleanup(); document.cookie = "ui_arrangement=;path=/;max-age=0"; });

describe("what opening Settings does to the poll, at a desk", () => {
  it("does not hold it just by being open", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    serveServedBook();
    render(<Next />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    await screen.findByRole("dialog", { name: "Settings" });
    await settle();
    expect(document.activeElement, "the focus never moved into the panel")
      .not.toBe(document.body);
    expect(holdsThePoll(), `focus landed on ${document.activeElement?.outerHTML.slice(0, 80)}`).toBe(false);
  });
});
