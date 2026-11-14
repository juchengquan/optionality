/** Where the focus actually goes when the desk's Settings or its column picker opens on `/opt/next`
 *  — which decides whether the page keeps polling. Carried from `PollWhileOpen.test.tsx` (#337), which asks it of
 *  today's `App` and goes with it in #301; the phone's sheets are `NextPollWhileOpen.iphone`'s.
 *
 *  jsdom leaves the focus where it was when a sheet opens, so the unit suite cannot answer this: the
 *  poll waits while the focus is inside a surface marked `data-poll="hold"` (Next.tsx), and a real
 *  focus trap moves it. Hence a real browser.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../Next";
import { beingOperated } from "../poll";
import { serveBook, settle } from "./nextBook";

afterEach(() => { cleanup(); document.cookie = "ui_arrangement=;path=/;max-age=0"; });

describe("what opening Settings does to the poll, at a desk", () => {
  it("does not hold it just by being open", async () => {
    document.cookie = "ui_arrangement=desk;path=/";
    serveBook();
    render(<Next />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    await screen.findByRole("dialog", { name: "Settings" });
    await settle();
    expect(document.activeElement, "the focus never moved into the panel")
      .not.toBe(document.body);
    expect(beingOperated(document.activeElement), `focus landed on ${document.activeElement?.outerHTML.slice(0, 80)}`).toBe(false);
  });
});

describe("what opening the book's column picker does to the poll, at a desk", () => {
  it("holds it: the columns it offers come from the measured fit, which a poll moves", async () => {
    // the one surface opened on the desk that does hold it, measured where a real focus trap runs;
    // `NextPollGuard` counts the polls, in jsdom
    document.cookie = "ui_arrangement=desk;path=/";
    serveBook();
    render(<Next />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "book columns" }));
    await screen.findByRole("group", { name: "book columns" });
    await settle();
    expect(beingOperated(document.activeElement), `focus landed on ${document.activeElement?.outerHTML.slice(0, 80)}`)
      .toBe(true);
  });
});
