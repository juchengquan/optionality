/** One way to write a date (the owner's standard of 2026-11-17, ADR 0023): YYYYMMDD wherever the
 *  page writes one — the desk and the phone alike, the saved picture and its text — with its weekday
 *  only beside a time (`Mon 20261116 20:15 ET`). Each place below by name; `WordsPage.test.tsx` holds
 *  the whole page to no other form.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { BookProps } from "../Book";
import type { Health } from "../shared/api";
import { DeskBook } from "../desk/DeskBook";
import { PhoneBook } from "../phone/PhoneBook";
import { closeWords } from "../levels";
import { needsYou } from "../needs";
import { newYorkWhen, servedWhen } from "../session";
import { contractName, fetchedWords } from "../shared/format";
import { setDisplayZone, weekdayDate, writtenDate } from "../shared/times";
import { plainView, takenWords, toMarkdown, type PlainInput } from "../snapshot/plain";
import { holding, HOLDINGS, MONITORS, QUOTES, side } from "../testing/ownerBook";

afterEach(() => {
  cleanup();
  setDisplayZone(null);
});

function props(over: Partial<BookProps> = {}): BookProps {
  return {
    quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null, holdingsAt: null,
    session: true, privacy: false, entryStyle: "opportunity", ...over,
  };
}

const headings = (root: ParentNode, selector: string) => [...root.querySelectorAll(selector)].map((h) => h.textContent);

describe("the three shapes, written in one place", () => {
  it("a date alone is YYYYMMDD; beside a time it keeps its weekday", () => {
    expect(writtenDate("2026-12-31")).toBe("20261231");
    expect(weekdayDate("2026-11-16")).toBe("Mon 20261116");
  });
});

describe("an expiry's heading", () => {
  it("is the same on the desk and the phone: 20261231 · 45 DTE", () => {
    const desk = render(<DeskBook {...props()} />);
    const deskHeads = headings(desk.container, ".nxd-expiry h3");
    cleanup();
    const phone = render(<div className="nx"><PhoneBook {...props()} /></div>);
    const phoneHeads = headings(phone.container, ".nxp-expiry-head");
    expect(deskHeads.length).toBeGreaterThan(0);
    for (const h of [...deskHeads, ...phoneHeads]) expect(h).toMatch(/^\d{8} · \d+ DTE$/);
    // the phone's headings are the desk's, one for one in the book's order
    expect(phoneHeads).toEqual(deskHeads.slice(0, phoneHeads.length));
    expect(deskHeads).toContain("20261218 · 38 DTE");
  });
});

describe("a contract's name", () => {
  it("writes the code's six digits as the whole date", () => {
    expect(contractName("US.SPXW261218P6800000", "SPXW 261218 6800.00P")).toBe("20261218 P6800");
    // anything else is left as it is, a name the owner typed included
    for (const name of ["1231_8050", "1218-6800", "SPXW 261218 6800.50P"]) expect(contractName(name)).toBe(name);
  });

  it("is drawn so on the desk and the phone", () => {
    const desk = render(<DeskBook {...props()} />);
    expect(desk.container.textContent).toContain("20261218 P7150");
    cleanup();
    const phone = render(<div className="nx"><PhoneBook {...props()} /></div>);
    expect(phone.container.textContent).toContain("20261218 P7150");
  });
});

describe("a time with its date", () => {
  it("keeps the weekday: the market's clock, the viewer's, and a close", () => {
    expect(newYorkWhen("2026-11-17 09:15:00+08:00")).toBe("Mon 20261116 20:15 ET");
    setDisplayZone("Asia/Singapore");
    expect(fetchedWords("2026-11-12 23:14:05+08:00", new Date("2026-11-16T15:00:00Z"))).toBe("Thu 20261112 23:14:05 SGT");
    // older than six days, a served time says its date, and its weekday with it
    expect(servedWhen("2026-11-06 21:04:00+08:00", new Date("2026-11-16T15:00:00Z"))).toBe("Fri 20261106 21:04 SGT");
    const closed = holding("h", {
      strike_date: "2026-12-18", legs: [side("short", "PUT", 6800)], valued_from: "close",
      valued_on: "2026-11-13", valued_timing: "close", fetched_at: "2026-11-14 05:14:59+08:00",
    });
    expect(closeWords(closed)).toBe("as of the close, Fri 20261113 16:14 ET");
    expect(closeWords({ ...closed, fetched_at: null, valued_timing: "unrecorded" })).toBe("as of 20261113, at a time not recorded");
  });
});

describe("the saved picture and Copy as text", () => {
  const HEALTH = {
    db: true, golden_cases: "x", provider: { name: "moomoo", ok: true },
    monitor: { last_sweep_at: "2026-11-16 23:00:05+08:00", last_sweep_ok: true, consecutive_failures: 0,
      alarms: { label: "active", bad: false }, fetched_at: "2026-11-16 23:00:05+08:00" },
    settings: { manage_by_dte: 21, sweep_seconds: 15, expired_retention_days: 7, display_tz: "Asia/Singapore" },
  } as Health;
  const input = (): PlainInput => ({
    quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null, holdingsAt: "23:00:05",
    holdingsServed: null, session: true, privacy: false, needs: needsYou(QUOTES, MONITORS, HEALTH, HOLDINGS),
    health: HEALTH, polledAt: "23:00:09 SGT", error: null, references: [], hidden: new Set(),
    takenAt: new Date("2026-11-16T15:00:00Z"),
  });

  it("heads each expiry and names each contract with the whole date, and says when it was taken", () => {
    const view = plainView(input());
    // an expiry's heading starts with a number; the others (the quarantined, the muted) are words
    const heads = view.sections.flatMap((s) => s.groups.map((g) => g.heading))
      .filter((h): h is string => h !== null && /^\d/.test(h));
    expect(heads.length).toBeGreaterThan(0);
    for (const h of heads) expect(h).toMatch(/^\d{8} · \d+ DTE$/);
    const text = toMarkdown(view);
    expect(text).toContain("20261218 · 38 DTE");
    expect(text).toContain("20261218 P7150");
    expect(text).not.toMatch(/(?<![\w\d])2\d[01]\d[0-3]\d(?![\d_\-])/);
    expect(takenWords(new Date("2026-11-16T15:00:00Z"), "Asia/Singapore"))
      .toBe("Mon 20261116 10:00 ET · Mon 20261116 23:00 SGT");
  });
});
