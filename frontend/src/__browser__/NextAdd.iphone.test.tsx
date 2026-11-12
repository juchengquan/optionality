/** Adding a spread on the phone (#293), MEASURED under Playwright's iPhone profile: the Add tab
 *  opens the form as a bottom sheet, the condor the audit timed is entered as two spreads with its
 *  four Monitors and its actions COUNTED, nothing in the sheet is pushed past the screen's edge,
 *  every target is 44pt with 16px text, a refusal is said in the sheet where it can be read, and
 *  Back closes it. Runs in the suite's `iphone` instance only; the desk is `NextAdd.test.tsx`.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { Next } from "../next/Next";
import { overflowsSideways, serveAdding, settle } from "./nextBook";

afterEach(cleanup);

const ADDED = {
  positions: [{ id: "p1", name: "a" }, { id: "p2", name: "b" }],
  monitors: ["m1", "m2", "m3", "m4"].map((id) => ({ id, code: id, field: "mid_price" })),
};

/** A dialog slides in, and a box measured mid-animation is not where it will be. */
async function animationsDone(): Promise<void> {
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  await new Promise((r) => setTimeout(r, 50));
}

/** What it took, as the audit counted it: every tap on a button, every field typed into. */
function counter() {
  const n = { taps: 0, typed: 0 };
  return {
    n,
    tap: async (el: Element) => { n.taps += 1; await userEvent.click(el); },
    type: async (label: string, text: string) => { n.typed += 1; await userEvent.fill(screen.getByLabelText(label), text); },
  };
}

async function openPhone(spreads = { status: 201, body: ADDED as object }) {
  const sent = serveAdding(spreads);
  render(<Next />);
  await settle();
  return sent;
}

const addTab = () => within(screen.getByRole("navigation", { name: "views" })).getByRole("button", { name: "Add" });

async function openSheet() {
  await userEvent.click(addTab());
  const sheet = await screen.findByRole("dialog", { name: "Add a spread" });
  await animationsDone();
  return sheet;
}

/** Every control a finger has to hit inside `root`, under 44pt. */
function tooSmall(root: Element): string[] {
  return [...root.querySelectorAll<HTMLElement>("button, select, input, a")]
    .filter((el) => el.getClientRects().length > 0)
    .flatMap((el) => {
      const r = el.getBoundingClientRect();
      return r.width < 44 || r.height < 44
        ? [`${el.tagName.toLowerCase()} "${el.getAttribute("aria-label") ?? el.textContent?.trim()}" ${Math.round(r.width)}×${Math.round(r.height)}`]
        : [];
    });
}

/** Anything in the sheet reaching past the screen's right edge. */
function pastTheEdge(root: Element): string[] {
  const edge = document.documentElement.clientWidth;
  return [...root.querySelectorAll<HTMLElement>("*")]
    .filter((el) => el.getBoundingClientRect().right > edge + 0.5)
    .map((el) => `${el.tagName.toLowerCase()}.${el.className} right=${Math.round(el.getBoundingClientRect().right)}`);
}

describe("adding a condor on the phone", () => {
  it("takes 3 taps and 7 typed fields where the audit measured about 40 and 16, the expiry typed once", async () => {
    const sent = await openPhone();
    const { n, tap, type } = counter();
    await tap(addTab());
    const sheet = await screen.findByRole("dialog", { name: "Add a spread" });
    await animationsDone();
    await type("expiry", "2026-12-18");
    await type("spread 1, leg 1 strike", "7150");
    await type("spread 1, leg 2 strike", "7100");
    await type("spread 1 entry", "1.50");
    await tap(within(sheet).getByRole("button", { name: "call spread" }));
    await type("spread 2, leg 1 strike", "7700");
    await type("spread 2, leg 2 strike", "7750");
    await type("spread 2 entry", "1.25");
    await tap(within(sheet).getByRole("button", { name: "Record 2 holdings + 4 Monitors" }));
    await waitFor(() => expect(sent).toHaveLength(1));

    expect(n).toEqual({ taps: 3, typed: 7 });
    expect(n.taps).toBeLessThan(34);
    expect(n.typed).toBeLessThan(16);
    const body = sent[0] as { strike_date: string; spreads: { held: boolean; monitors: unknown[] }[] };
    expect(body.strike_date).toBe("2026-12-18");
    expect(body.spreads.map((s) => [s.held, s.monitors.length])).toEqual([[true, 2], [true, 2]]);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a spread" })).toBeNull());
  });
});

describe("the Add sheet", () => {
  it("pushes nothing sideways, with a condor's four legs and its preview in it", async () => {
    await openPhone();
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: "condor as one holding" }));
    for (const [i, k] of ["7150", "7100", "7700", "7750"].entries()) {
      await userEvent.fill(screen.getByLabelText(`spread 2, leg ${i + 1} strike`), k);
    }
    await userEvent.fill(screen.getByLabelText("spread 2 entry"), "2.75");
    await waitFor(() => expect(sheet.querySelector('[data-spread="2"] [data-curve]')).not.toBeNull());
    await settle();
    expect(overflowsSideways()).toBe(false);
    expect(pastTheEdge(sheet)).toEqual([]);
  });

  it("gives every control a 44pt target, and every box 16px text so iOS does not zoom", async () => {
    await openPhone();
    const sheet = await openSheet();
    expect(tooSmall(sheet)).toEqual([]);
    const small = [...sheet.querySelectorAll("input")]
      .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => el.getAttribute("aria-label"));
    expect(small).toEqual([]);
  });

  it("says a refusal inside the sheet, where it can be read", async () => {
    await openPhone({ status: 422, body: { detail: "contract does not exist: US.SPXW261218P7100000 — check strike and expiry" } });
    const sheet = await openSheet();
    await userEvent.fill(screen.getByLabelText("expiry"), "2026-12-18");
    await userEvent.fill(screen.getByLabelText("spread 1, leg 1 strike"), "7150");
    await userEvent.fill(screen.getByLabelText("spread 1, leg 2 strike"), "7100");
    await userEvent.fill(screen.getByLabelText("spread 1 entry"), "1.50");
    await userEvent.click(within(sheet).getByRole("button", { name: /^Record/ }));
    const alert = await within(sheet).findByRole("alert");
    expect(alert.textContent).toMatch(/^contract does not exist/);
    alert.scrollIntoView({ block: "center" });
    const r = alert.getBoundingClientRect();
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.right).toBeLessThanOrEqual(document.documentElement.clientWidth + 0.5);
    expect(alert.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))).toBe(true);
  });

  it("closes on the browser's Back without leaving the page", async () => {
    await openPhone();
    await openSheet();
    history.back();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a spread" })).toBeNull());
    expect(document.querySelector(".nx")).toBeTruthy();
  });
});
