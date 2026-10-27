import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { App } from "../App";
import { clockTime } from "../format";

/** The one clock on this page the SERVICE does not format.
 *
 *  `fetched at ...` is rendered by the API in DISPLAY_TZ and arrives as
 *  `2026-10-21 21:47:23+08:00`. `screen updated ...` is made here, and was
 *  `new Date().toLocaleTimeString()` — no locale, so whatever the device happens to be set to.
 *  The owner's browser is Chinese and the line read `screen updated 晚上9:39:53`, beside a service
 *  string in 24-hour ISO; on an en-US machine it reads `9:39:53 PM`, wrong in the same way and
 *  harder to notice. It is also in every PNG the dashboard now saves.
 */
describe("the screen's own clock", () => {
  it("is 24-hour and digits only, whatever locale the device is in", () => {
    expect(clockTime(new Date("2026-10-21T21:39:05+08:00"))).toBe("21:39:05");
  });

  it("pads every field, so the line does not jitter as the seconds tick", () => {
    // tabular-nums does nothing for a string that changes length
    expect(clockTime(new Date("2026-10-21T09:08:07+08:00"))).toBe("09:08:07");
  });

  it("puts a plain 24-hour time on the page, next to the service's", async () => {
    const health = {
      db: true, provider: { name: "moomoo", ok: true },
      monitor: {
        last_sweep_at: "x", alarms: { label: "active", bad: false },
        fetched_at: "2026-10-21 21:47:23+08:00",
      },
      settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
    };
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(
          url.endsWith("/quotes") ? [] : url.endsWith("/monitors") ? [] : health),
      } as Response)));
    render(<App />);

    const line = await waitFor(() => screen.getByText(/screen updated/));
    expect(line.textContent, `the line read "${line.textContent}"`)
      .toMatch(/screen updated \d{2}:\d{2}:\d{2}/);
    // Nothing the device's LANGUAGE decided: no AM/PM, no CJK. Deliberately not "no non-ASCII"
    // — the line's separators are this project's own `·`, which is punctuation rather than a
    // locale artifact, and asserting against it failed on the very string being fixed.
    expect(line.textContent, "a language chose part of this line")
      .not.toMatch(/[AP]M|[\u3000-\u9fff]/);
  });
});
