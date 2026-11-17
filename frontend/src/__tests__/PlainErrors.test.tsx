/** Errors in plain words (the owner's standard of 2026-11-16, part N; ADR 0023): what failed and that
 *  it can be tried again — never the browser's "Failed to fetch" or a socket's "ECONNREFUSED" on
 *  screen as the words. What was thrown or served stays one tap away, a "details" disclosure beside
 *  them (`ErrorWords.tsx`), and a failure names its vendor.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { plainError, plainReason, rawError } from "../shared/errors";
import { saidBy } from "../testing/hyphens";
import { servePage, SPX_REFERENCE } from "../testing/pageService";
import type { Entry, Reference } from "../shared/api";
import { CHECKS, wordsOf } from "../testing/words";
import { heldOrNot } from "../testing/held";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.cookie = "ui_arrangement=;path=/;max-age=0";
});

describe("an error, in words", () => {
  it("says a request that never reached the service as that, in every browser's spelling", () => {
    for (const raw of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."]) {
      expect(plainError(new TypeError(raw))).toBe("the service did not answer; try again");
    }
    expect(plainError(new TypeError("Failed to fetch"), "tried again at the next poll"))
      .toBe("the service did not answer; tried again at the next poll");
  });

  it("says a socket's error as the provider not reached, and a status as the service's", () => {
    // named by the vendor it names (review of #420): the References exist to tell vendors apart
    expect(plainError(new Error("moomoo call failed: connect ECONNREFUSED 127.0.0.1:33333")))
      .toBe("moomoo could not be reached; try again");
    expect(plainError(new Error("connect ECONNREFUSED 127.0.0.1:33333"))).toBe("the provider could not be reached; try again");
    expect(plainError(new Error("/quotes → 502"))).toBe("the service failed (502); try again");
    expect(plainError(new Error("/positions → 404"))).toBe("the service refused it (404)");
  });

  it("says the service's own refusal as it is, with no retry promised", () => {
    expect(plainError(new Error("expiry 2026-12-18 is not listed"))).toBe("expiry 2026-12-18 is not listed");
    expect(rawError(new Error("Failed to fetch"))).toBe("Failed to fetch");
  });

  it("says a served reason plainly only where it is a socket's noise", () => {
    expect(plainReason("moomoo call failed: connect ECONNREFUSED 127.0.0.1:33333")).toBe("moomoo could not be reached");
    expect(plainReason("yahoo-finance2: getaddrinfo ENOTFOUND query1.finance.yahoo.com")).toBe("yahoo could not be reached");
    // a Reference's failure that names no vendor is named by its source
    expect(plainReason("connect ETIMEDOUT 10.0.0.1:4001", "ibkr")).toBe("ibkr could not be reached");
    expect(plainReason("needs both a bid and an ask")).toBe("needs both a bid and an ask");
    expect(plainReason(null)).toBeNull();
  });
});

describe("on the page, when the service cannot be reached", () => {
  for (const arrangement of ["desk", "phone"] as const) {
    it(`on the ${arrangement}: says what failed and that it is tried again, what was thrown one tap away`, async () => {
      servePage();
      document.cookie = `ui_arrangement=${arrangement};path=/`;
      const served = window.fetch;
      window.fetch = (async (url: string, init?: RequestInit) => {
        const path = String(url).replace(/^.*\/api/, "");
        // the poll's read and the valuation never reach the service
        if (path === "/quotes" || path === "/positions/values") throw new TypeError("Failed to fetch");
        return served(url, init);
      }) as typeof fetch;
      render(<Next />);
      const banner = await screen.findByRole("alert");
      expect(wordsOf(banner, (el) => el.textContent!))
        .toBe("the figures could not be refreshed — the service did not answer; tried again at the next poll");
      // the raw text a disclosure away, which a finger and a reader reach: a details, not a title
      const raw = banner.querySelector<HTMLDetailsElement>("details[data-raw]")!;
      expect(raw.querySelector("summary")!.textContent).toBe("details");
      expect(raw.querySelector("code")!.textContent).toBe("Failed to fetch");
      await waitFor(() => expect(document.body.textContent).toContain("could not be valued — the service did not answer; refresh to try again"));
      const note = [...document.querySelectorAll<HTMLElement>("div")].find((d) => d.firstChild?.textContent === "the holdings could not be valued — ")!;
      expect(note.querySelector("[data-raw] code")!.textContent).toBe("Failed to fetch");
      // and nothing on the page says it raw in its words
      expect(CHECKS["a raw error"]!(wordsOf(document.body, saidBy))).toEqual([]);
    });
  }
});

describe("a reason the service serves, through the page (the boundary in api.ts)", () => {
  const SOCKET = "moomoo call failed: connect ECONNREFUSED 127.0.0.1:33333";
  for (const arrangement of ["desk", "phone"] as const) {
    it(`on the ${arrangement}: a rule's fault names its vendor, and keeps what was served one tap away`, async () => {
      const svc = servePage([{ ...SPX_REFERENCE, id: "yahoo-ref", source: "yahoo", figure: null,
        error: "getaddrinfo ENOTFOUND query1.finance.yahoo.com" } as Reference]);
      document.cookie = `ui_arrangement=${arrangement};path=/`;
      svc.alter.set("/quotes", (rows) => (rows as Entry[]).map((e) => e.id === "w-dec18" ? { ...e, error: SOCKET } : e));
      render(<Next />);
      await waitFor(() => expect(document.body.textContent).toContain("moomoo could not be reached"));
      const name = "1218_P7150";
      if (arrangement === "desk") {
        const row = [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === "w-dec18")!;
        fireEvent.click(within(row).getByRole("button", { name: heldOrNot(name) }));
      } else {
        fireEvent.click(screen.getByRole("button", { name: heldOrNot(`details of ${name}`) }));
      }
      const detail = arrangement === "desk"
        ? screen.getByRole("complementary", { name: `inspector: ${name}` }) : await screen.findByRole("dialog");
      const why = detail.querySelector<HTMLElement>(".nx-why")!;
      expect(wordsOf(why, (el) => el.textContent!)).toBe("moomoo could not be reached");
      expect(why.querySelector("[data-raw] code")!.textContent).toBe(SOCKET);
      // the Reference's failure named by its own source, never "the provider"
      await waitFor(() => expect(saidBy(document.body)).toContain("yahoo could not be reached"));
      expect(CHECKS["a raw error"]!(wordsOf(document.body, saidBy))).toEqual([]);
    });
  }
});
