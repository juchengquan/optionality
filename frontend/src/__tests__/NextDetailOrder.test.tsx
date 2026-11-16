/** The desk's inspector and the phone's sheet draw a holding, and a rule, in ONE order (the owner's
 *  standard of 2026-11-16, part J; ADR 0023): both from `sections.ts`' lists, through
 *  `DetailSections.tsx`. Each section is marked `data-section`; this reads the marks on both
 *  surfaces, for every holding and every watched row of the owner's book, and holds them to the list
 *  and to each other — so a section moved on one surface alone fails here.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { BookProps } from "../Book";
import { DeskBook } from "../desk/DeskBook";
import { PhoneBook } from "../phone/PhoneBook";
import { HOLDING_SECTIONS, RULE_SECTIONS, SECTION_HEADINGS } from "../sections";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";

afterEach(cleanup);

const writes = { edited: () => {}, closed: () => {}, deleted: () => {} };
const props = (): BookProps => ({
  quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null, holdingsAt: null,
  session: true, privacy: false, entryStyle: "opportunity", writes,
});

const sections = (root: Element) => [...root.querySelectorAll<HTMLElement>("[data-section]")].map((s) => s.dataset.section!);

function onDesk(ref: string, name: string): string[] {
  render(<DeskBook {...props()} />);
  const row = [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === ref)!;
  fireEvent.click(within(row).getByRole("button", { name }));
  const drawn = sections(screen.getByRole("complementary", { name: `inspector: ${name}` }));
  cleanup();
  return drawn;
}

async function onPhone(ref: string, name: string): Promise<string[]> {
  render(<div className="nx"><PhoneBook {...props()} /></div>);
  const card = [...document.querySelectorAll<HTMLElement>("article[data-ref]")].find((c) => c.dataset.ref === ref)!;
  fireEvent.click(within(card).getByRole("button", { name: `details of ${name}` }));
  const drawn = sections(await screen.findByRole("dialog"));
  act(() => { window.history.back(); });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  cleanup();
  return drawn;
}

/** Whether `drawn` keeps the list's order, leaving out only what had nothing to draw. */
const inListOrder = (drawn: string[], list: readonly string[]) =>
  drawn.every((s, i) => list.includes(s) && (i === 0 || list.indexOf(s) > list.indexOf(drawn[i - 1]!)));

describe("one section order, on the desk and the phone (part J)", () => {
  it("is the list the owner chose, for a holding and for a rule", () => {
    expect(HOLDING_SECTIONS).toEqual(["level", "legs", "strip", "payoff", "figures", "schedule", "pace", "rules", "actions", "history"]);
    expect(RULE_SECTIONS).toEqual(["level", "legs", "strip", "payoff", "figures", "rules", "history"]);
    expect(SECTION_HEADINGS).toEqual({ schedule: "Exit schedule", rules: "Rules" });
  });

  for (const h of HOLDINGS) {
    it(`draws the holding ${h.name} in the same order on both, every section of it`, async () => {
      const desk = onDesk(h.id, h.name);
      const phone = await onPhone(h.id, h.name);
      expect(desk).toEqual(phone);
      expect(inListOrder(desk, HOLDING_SECTIONS), desk.join(" ")).toBe(true);
      // a holding with a schedule and a short leg draws every one of them
      if (h.schedule && h.legs.some((l) => l.side === "short")) expect(desk).toEqual([...HOLDING_SECTIONS]);
    });
  }

  for (const [ref, name] of [["w-dec04", "1204_P6900"], ["w-dec18", "1218_P7150"], ["w-dec31", "1231_C7600"]] as const) {
    it(`draws the watched spread ${name} in the same order on both, with a "watches" line on both`, async () => {
      const desk = onDesk(ref, name);
      const phone = await onPhone(ref, name);
      expect(desk).toEqual(phone);
      expect(desk).toEqual([...RULE_SECTIONS]);
    });
  }

  it("draws a single contract's rule in the same order on both, leaving out what a contract has none of", async () => {
    const name = nameOf("w-lone");
    const desk = onDesk("w-lone", name);
    const phone = await onPhone("w-lone", name);
    expect(desk).toEqual(phone);
    expect(inListOrder(desk, RULE_SECTIONS)).toBe(true);
    // no legs, no strip and no payoff for one contract: its figures and its rules still
    expect(desk).toEqual(["level", "figures", "rules", "history"]);
  });

  it("says what a rule watches first in its figures, on both", async () => {
    render(<DeskBook {...props()} />);
    const row = [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === "w-dec18")!;
    fireEvent.click(within(row).getByRole("button", { name: "1218_P7150" }));
    const desk = screen.getByRole("complementary", { name: "inspector: 1218_P7150" }).querySelector("[data-section='figures'] dt")!;
    expect(desk.textContent).toBe("watches");
    cleanup();
    render(<div className="nx"><PhoneBook {...props()} /></div>);
    fireEvent.click(screen.getByRole("button", { name: "details of 1218_P7150" }));
    const phone = (await screen.findByRole("dialog")).querySelector("[data-section='figures'] dt")!;
    expect(phone.textContent).toBe("watches");
  });
});

/** The name a row is drawn under, read from the desk's own table. */
function nameOf(ref: string): string {
  render(<DeskBook {...props()} />);
  const row = [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === ref)!;
  const name = row.querySelector<HTMLButtonElement>(".nxd-name")!.textContent!;
  cleanup();
  return name;
}
