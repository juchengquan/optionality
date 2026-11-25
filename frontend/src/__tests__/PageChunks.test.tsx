/** Each page its own code, loaded when the path names it (#483): the book does not load the account
 *  page's module and the account page does not load the book's, nothing is drawn while a page's code
 *  arrives, and a page whose code cannot be fetched — a deploy replaced it mid-visit — says the
 *  page's own failure words (`PageBoundary`) rather than leaving a blank screen.
 *
 *  Both pages are stand-ins here, so what is held is `Page`'s loading and nothing either page draws.
 *  Which FILES the built pages request is held against the build itself, served by the real Caddy
 *  config (`tools/first-load.test.mjs`). */
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Page } from "../Page";
import { PageBoundary } from "../PageBoundary";

const loaded = vi.hoisted(() => {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  return { book: false, account: false, gate, open };
});

// the book's module: held at the gate until a test opens it, as a slow link holds its chunk
vi.mock("../Next", async () => {
  loaded.book = true;
  await loaded.gate;
  return { Next: () => <p>the book</p> };
});

// the account page's module: a chunk that is no longer there, as after a deploy mid-visit
vi.mock("../account/Account", () => {
  loaded.account = true;
  throw new TypeError("Failed to fetch dynamically imported module: /opt/assets/Account-gone.js");
});

describe("each page loaded on its own (#483)", () => {
  it("draws nothing while the book's code arrives, then the book, and never loads the account's", async () => {
    const { container } = render(<PageBoundary><Page path="/opt/" base="/opt/" /></PageBoundary>);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(loaded.book).toBe(true);
    // no spinner and no words: on a fast link they would only flash
    expect(container.innerHTML).toBe("");
    await act(async () => { loaded.open(); });
    expect(await screen.findByText("the book")).toBeTruthy();
    expect(loaded.account, "the book loaded the account page's code").toBe(false);
  });

  it("says the page's failure words, with a reload, when a page's code cannot be fetched", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<PageBoundary><Page path="/opt/account" base="/opt/" /></PageBoundary>);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The page hit an error — reload to continue.");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(loaded.account).toBe(true);
    error.mockRestore();
  });
});
