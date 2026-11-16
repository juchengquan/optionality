/** Errors in plain words (the owner's standard of 2026-11-16, part N; ADR 0023): what failed and that
 *  it can be tried again — never the browser's "Failed to fetch" or a socket's "ECONNREFUSED" on
 *  screen. The raw text stays in a title, for when something is wrong for longer than a retry.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Next } from "../Next";
import { plainError, plainReason, rawError } from "../shared/errors";
import { saidBy } from "../testing/hyphens";
import { servePage } from "../testing/pageService";
import { CHECKS } from "../testing/words";

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
    expect(plainError(new Error("moomoo call failed: connect ECONNREFUSED 127.0.0.1:33333")))
      .toBe("the provider could not be reached; try again");
    expect(plainError(new Error("/quotes → 502"))).toBe("the service failed (502); try again");
    expect(plainError(new Error("/positions → 404"))).toBe("the service refused it (404)");
  });

  it("says the service's own refusal as it is, with no retry promised", () => {
    expect(plainError(new Error("expiry 2026-12-18 is not listed"))).toBe("expiry 2026-12-18 is not listed");
    expect(rawError(new Error("Failed to fetch"))).toBe("Failed to fetch");
  });

  it("says a served reason plainly only where it is a socket's noise", () => {
    expect(plainReason("moomoo call failed: connect ECONNREFUSED 127.0.0.1:33333")).toBe("the provider could not be reached");
    expect(plainReason("needs both a bid and an ask")).toBe("needs both a bid and an ask");
    expect(plainReason(null)).toBeNull();
  });
});

describe("on the page, when the service cannot be reached", () => {
  for (const arrangement of ["desk", "phone"] as const) {
    it(`on the ${arrangement}: says what failed and that it is tried again, the raw text in the title`, async () => {
      const svc = servePage();
      document.cookie = `ui_arrangement=${arrangement};path=/`;
      const served = window.fetch;
      window.fetch = (async (url: string, init?: RequestInit) => {
        const path = String(url).replace(/^.*\/api/, "");
        // the poll's read and the valuation never reach the service; a row's reason is a socket's
        if (path === "/quotes" || path === "/positions/values") throw new TypeError("Failed to fetch");
        return served(url, init);
      }) as typeof fetch;
      svc.alter.set("/monitors", (rows) => rows);
      render(<Next />);
      const banner = await screen.findByRole("alert");
      expect(banner.textContent).toBe("the figures could not be refreshed — the service did not answer; tried again at the next poll");
      expect(banner.getAttribute("title")).toBe("Failed to fetch");
      await waitFor(() => expect(document.body.textContent).toContain("could not be valued — the service did not answer; refresh to try again"));
      // and nothing on the page says it raw: the title is the one place it is kept
      const said = saidBy(document.body).replace("Failed to fetch", "");
      expect(CHECKS["a raw error"]!(said)).toEqual([]);
    });
  }
});
