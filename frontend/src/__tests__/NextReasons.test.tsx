/** Why a rule is off, in ONE set of words (the owner's standard of 2026-11-16, part I; ADR 0023):
 *  the desk's muted fold and quarantined rows, the phone's switched-off cards, the needs-you line and
 *  the saved picture all say it from `shared/groups.ts`, so no surface can word a reason its own way.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { BookProps } from "../Book";
import { DeskBook } from "../desk/DeskBook";
import { PhoneBook } from "../phone/PhoneBook";
import { needsYou } from "../needs";
import { plainView } from "../snapshot/plain";
import { headingOf, reasonLabel, reasonWhy, REASONS } from "../shared/groups";
import { HOLDINGS, monitor, QUOTES } from "../testing/ownerBook";

afterEach(cleanup);

/** One rule off for every reason the page knows. */
const OFF = REASONS.map((r, i) => monitor(`off-${i}`, {
  code: `US.SPXW261218C${8000 + i * 10}000`, strike: 8000 + i * 10, enabled: false, disabled_reason: r.reason,
  // an expired one by its date, so the editor's own words for it are its expiry's
  strike_date: r.reason === "expired" ? "2026-11-06" : "2026-12-18",
}));

const props = (): BookProps => ({
  quotes: QUOTES, monitors: OFF, holdings: HOLDINGS, holdingsError: null, holdingsAt: null,
  session: true, privacy: false, entryStyle: "opportunity",
});

describe("one set of words for why a rule is off (part I)", () => {
  it("has a label and a clause for every reason, the quarantines' clauses being the faults' words", () => {
    for (const r of REASONS) {
      expect(reasonLabel(r.reason)).toBe(r.label);
      expect(reasonWhy(r.reason)).toBe(r.why);
      expect(r.label).toBe(r.label.toLowerCase());
    }
  });

  it("says each the same on the desk's fold and quarantined rows, the phone's cards, the line and the picture", () => {
    render(<DeskBook {...props()} />);
    const desk = document.body.textContent!;
    cleanup();
    render(<div className="nx"><PhoneBook {...props()} /></div>);
    const phone = screen.getByRole("region", { name: "Switched off" }).textContent!;
    cleanup();
    const needs = needsYou([], OFF, null, null).map((n) => n.text).join(" · ");
    const picture = plainView({
      quotes: [], monitors: OFF, holdings: [], holdingsError: null, holdingsAt: null, session: true, privacy: false,
      needs: [], health: null, polledAt: null, error: null, references: [], hidden: new Set(), takenAt: new Date(),
    });
    const headings = picture.sections.flatMap((s) => s.groups.map((g) => g.heading));
    for (const r of REASONS) {
      if (r.quarantine) {
        // a fault: said by its clause, the same on every surface
        expect(desk, r.reason!).toContain(r.why);
        expect(phone, r.reason!).toContain(r.why);
        expect(needs, r.reason!).toContain(r.why);
      } else {
        // a choice or the calendar: by its label, and in the picture as a heading of it
        expect(desk, String(r.reason)).toContain(r.label);
        expect(phone, String(r.reason)).toContain(r.label);
        expect(headings, String(r.reason)).toContain(headingOf(r.label));
      }
    }
    // the old words are gone from every surface
    for (const said of [desk, phone, needs, headings.join(" ")]) {
      expect(said).not.toMatch(/muted by hand|its holding closed/);
    }
  });
});
