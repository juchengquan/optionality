/** Where the focus actually goes when a phone's sheet opens on `/opt/next` — which decides whether
 *  the page keeps polling. Carried from `PollWhileOpen.test.tsx` (#337), which asks it of today's
 *  `App` and goes with it in #301. Runs in the suite's `iphone` instance.
 *
 *  The detail sheet follows the live figures, so a focus trap that landed inside something marked
 *  `data-poll="hold"` would freeze exactly what it is open to show. The Add sheet is the other way
 *  round: its form holds the poll once a box is being filled in (`NextPollGuard`), and a sheet that
 *  put the focus there on opening would stop the poll before a finger touched it.
 *
 *  Opened by a real tap (`userEvent` from the browser context, through Playwright), not a
 *  synthetic click: under the iPhone profile a synthetic click opened the detail sheet with the
 *  focus left on the body, which holds nothing and so would pass whatever the sheet did.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { beingOperated } from "../next/poll";
import { serveBook, settle } from "./nextBook";

async function show() {
  serveBook();
  render(<Next />);
  await settle();
  // the cards are LIVE's: the browser's clock is the real one, and outside the session it says REVIEW
  await userEvent.click(tab("Live"));
  await settle();
}
const tab = (name: string) =>
  within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name });

afterEach(cleanup);

describe("what opening a sheet does to the poll, on a phone", () => {
  it("does not hold it with a card's detail sheet open", async () => {
    await show();
    await userEvent.click(screen.getByRole("button", { name: "details of 1204_6900P" }));
    const sheet = await screen.findByRole("dialog");
    await settle();
    // the trap did move it: into the sheet, where a finger opened it
    expect(sheet.contains(document.activeElement), "the focus never moved into the sheet").toBe(true);
    expect(beingOperated(document.activeElement), `focus landed on ${document.activeElement?.outerHTML.slice(0, 80)}`).toBe(false);
  });

  it("does not hold it with the Add sheet merely open", async () => {
    await show();
    await userEvent.click(tab("Add"));
    const sheet = await screen.findByRole("dialog", { name: "Add a spread" });
    await settle();
    expect(sheet.contains(document.activeElement), "the focus never moved into the sheet").toBe(true);
    expect(beingOperated(document.activeElement), `focus landed on ${document.activeElement?.outerHTML.slice(0, 80)}`).toBe(false);
  });
});
