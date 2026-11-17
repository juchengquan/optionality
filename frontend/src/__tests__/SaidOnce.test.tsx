/** Each thing said once (the owner, 2026-11-17: "we can still remove some descriptive text more,
 *  currently there are still duplicate about them and their titles"; ADR 0023, amended). On the desk
 *  and the phone alike:
 *
 *  - over the whole page walk (`testing/pageWalk.tsx`), in session and out: no sentence drawn twice
 *    in one place — an inspector, a sheet, a form, the page — and no bar toward a rule's threshold,
 *    which said again what the rule's arrowed distance says (`↑1.31`, #388);
 *  - and each repeat that was removed, by name, with the fact it carried that is still said.
 *
 *  A sentence here is an element's OWN visible prose (its text nodes, not a child's), at least 24
 *  characters with a word in it: figures repeat for good reasons — a rule drawn under each holding it
 *  covers — and are not what this holds. What a reader alone hears (`.sr-only`) and a drawn short form
 *  hidden from a reader (`aria-hidden`) are one sentence said two ways, not twice.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Entry, Holding } from "../shared/api";
import { MONDAY, openPage, settle, SUNDAY, walkDesk, walkPhone, type Read } from "../testing/pageWalk";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const n of ["ui_arrangement", "ui_price_map", "ui_privacy"]) document.cookie = `${n}=;path=/;max-age=0`;
});

/** Every element's own visible prose in `root`. */
export function sentencesOf(root: Element): string[] {
  const out: string[] = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (el.closest(".sr-only, [aria-hidden='true'], svg, script, style")) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join("")
      .replace(/\s+/g, " ").trim();
    if (own.length >= 24 && /[a-z]{3,}/i.test(own)) out.push(own);
  }
  return out;
}

/** The sentences said more than once in `root`. */
export function twice(root: Element): string[] {
  const seen = new Map<string, number>();
  for (const s of sentencesOf(root)) seen.set(s, (seen.get(s) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([s, n]) => `×${n} ${s}`);
}

describe("the check sees a sentence said twice (it fails on a planted fault)", () => {
  it("in one place, and not across a reader's copy or a drawn short form", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p>a leg has no figure, and no sum is taken from part of them</p>
      <div><span>a leg has no figure, and no sum is taken from part of them</span></div>`;
    expect(twice(root)).toEqual(["×2 a leg has no figure, and no sum is taken from part of them"]);
    root.innerHTML = `<span class="sr-only">|value| ≥ 5.51 — now −1.80, 3.71 away</span>
      <span aria-hidden="true">|value| ≥ 5.51 — now −1.80, 3.71 away</span>
      <p>−48.00 pts per contract</p><p>−48.00 pts per contract</p>`;
    expect(twice(root)).toEqual([]);
  });
});

/** A bar toward a rule's threshold, however drawn: the desk's meter or the phone's progress bar. */
const BARS = "[role=progressbar], [role=meter], .nxp-progress, .nxd-fill, [data-fill]";

describe("no sentence said twice in one place, nor a bar beside a rule's distance, anywhere the page draws words", () => {
  for (const [when, now] of [["in session", MONDAY], ["outside the session", SUNDAY]] as const) {
    for (const [arrangement, walk] of [["desk", walkDesk], ["phone", walkPhone]] as const) {
      it(`on the ${arrangement}, ${when}`, async () => {
        const said: string[] = [];
        const read: Read = (where, root) => {
          said.push(...twice(root).map((s) => `${where}: ${s}`));
          // no bar toward a threshold: the rule's arrowed distance says how close (the owner, 2026-11-17)
          if (root.querySelector(BARS)) said.push(`${where}: a bar toward a threshold`);
        };
        await walk(read, now);
        expect(said).toEqual([]);
      }, 60_000);
    }
  }
});

/** SPX's price, not current, with the reason the service gives (#416): every holding and row. */
const REASON = "index not computed overnight — the last close's level";
const stale = (path: string, body: unknown): unknown => {
  if (path === "/positions/values") return (body as Holding[]).map((h) => ({ ...h, spx_reason: REASON }));
  if (path === "/quotes") return (body as Entry[]).map((e) => ({ ...e, spx_reason: REASON }));
  return body;
};

/** A holding's or a watched spread's detail: the desk's inspector or the phone's sheet. */
async function detail(arrangement: "desk" | "phone", name: string): Promise<HTMLElement> {
  if (arrangement === "phone") {
    fireEvent.click(screen.getByRole("button", { name: `details of ${name}` }));
    await settle();
    return screen.getByRole("dialog");
  }
  fireEvent.click([...document.querySelectorAll<HTMLButtonElement>(".nxd-row .nxd-name")].find((b) => b.textContent === name)!);
  await settle();
  return screen.getByRole("complementary", { name: `inspector: ${name}` });
}

/** What a sighted viewer reads in `root`: its text, a reader's copies left out. */
function seen(root: Element): string {
  const copy = root.cloneNode(true) as Element;
  for (const el of copy.querySelectorAll(".sr-only")) el.remove();
  return copy.textContent ?? "";
}

const count = (text: string, part: string) => text.split(part).length - 1;

for (const arrangement of ["desk", "phone"] as const) {
  describe(`on the ${arrangement}`, () => {
    it("says SPX's reason once in a detail: on its strike strip, not again under the payoff", async () => {
      await openPage(arrangement, MONDAY, stale);
      for (const name of ["1218_C7300", "1218_P7150"]) {
        const d = await detail(arrangement, name);
        await waitFor(() => expect(d.querySelector("[aria-label='payoff at expiry'] dl")).toBeTruthy());
        expect(count(seen(d), REASON), name).toBe(1);
        expect(d.querySelector("[aria-label='strike strip']")!.textContent).toContain(REASON);
        expect(d.querySelector("[aria-label='payoff at expiry']")!.textContent).not.toContain(REASON);
        if (arrangement === "phone") { act(() => { window.history.back(); }); await settle(); }
      }
    });

    it("draws each short strike's Δ once on its strip, and still says it to a reader", async () => {
      await openPage(arrangement);
      const d = await detail(arrangement, "1218_C7300");
      const strip = d.querySelector("[aria-label='strike strip']")!;
      // over its strike on the scale, and no longer in the line under it too
      expect(count(seen(strip), "Δ 0.330")).toBe(1);
      expect(strip.querySelector(".nxs-scale")!.textContent).toContain("Δ 0.330");
      // the reader's line, which the scale is decoration to, keeps every figure
      expect(strip.querySelector("figcaption")!.textContent).toMatch(/C7300 Δ 0\.330 · 399\.50 pts · 1\.00σ away/);
      expect(seen(strip.querySelector("figcaption")!)).toMatch(/C7300 399\.50 pts · 1\.00σ away/);
    });

    it("draws no rule's name under its own card's or sheet's heading, and a leg rule's name where it differs", async () => {
      await openPage(arrangement);
      if (arrangement === "phone") {
        // the held rule named as its holding, on the holding's card
        const card = document.querySelector("[data-ref='h-calls']")!;
        expect(count(card.textContent!, "1218_C7300")).toBe(1);
        expect(card.querySelector("[data-ref='r-calls'] .nxp-rule-name")).toBeNull();
        expect(card.querySelector("[data-ref='r-calls'] .nxp-sentence")).toBeTruthy();
        // a rule over more than this holding keeps its name: it is not the card's
        expect(card.querySelector("[data-ref='r-condor'] .nxp-rule-name")!.textContent).not.toBe("1218_C7300");
        // a watched spread's leg rule keeps its own name
        const watch = document.querySelector("[data-ref='w-dec18']")!;
        expect([...watch.querySelectorAll(".nxp-rule-name")].map((n) => n.textContent)).toEqual(["261218 7150P"]);
        const sheet = await detail(arrangement, "1218_P7150");
        expect([...sheet.querySelectorAll(".nxp-rule-name")].map((n) => n.textContent)).toEqual(["261218 7150P"]);
      } else {
        // the desk's inspector never drew a rule's name in Rules: held to that
        const d = await detail(arrangement, "1218_P7150");
        expect(d.querySelector("[data-section='rules']")!.textContent).not.toContain("1218_P7150");
      }
    });

    it("edits a rule under its own line, without repeating that line \"as saved\"", async () => {
      await openPage(arrangement);
      const d = await detail(arrangement, "1218_P7150");
      fireEvent.click(within(d).getByRole("button", { name: "edit 1218_P7150 value" }));
      const form = within(d).getByRole("form", { name: "editing 1218_P7150 value" });
      expect(form.textContent).not.toMatch(/as saved/);
      // the served figure and its distance: on the rule's own line, still there above the form
      expect(count(seen(d), "|value| ≥ 6.00 — now")).toBe(0);
      expect(within(d).getAllByText("|value| ≥ 6.00 — now 2.40, 3.60 away")).toHaveLength(1);
      expect(seen(d.querySelector("[data-section='rules']")!)).toContain("↑3.60");
      expect(count(seen(form), "↑3.60")).toBe(0);
    });

    it("says a shared reason for its dashes once, naming the figures it is for", async () => {
      await openPage(arrangement);
      const d = await detail(arrangement, "1204_P6900");
      const figures = d.querySelector("[aria-label='figures']")!.parentElement!;
      const why = "a leg has no figure, and no sum is taken from part of them";
      expect(count(figures.textContent!, why)).toBe(1);
      expect(figures.querySelector("[data-figures-why]")!.textContent).toBe(`Δ Γ Θ ν: ${why}`);
      // each figure still draws its dash
      for (const k of ["option_delta", "option_gamma", "option_theta", "option_vega"]) {
        expect(figures.querySelector(`[data-figure='${k}'] dd`)!.textContent).toBe("—");
      }
    });

    it("says what a quarantine found once, under a line that already ends in its clause", async () => {
      await openPage(arrangement);
      const clause = "the provider does not know its contract";
      const where = arrangement === "phone"
        ? document.querySelector("[data-monitor='q-unknown']")!
        : await (async () => {
          fireEvent.click([...document.querySelectorAll<HTMLButtonElement>(".nxd-row .nxd-name")].find((b) => b.textContent === "261211 8000C")!);
          await settle();
          return screen.getByRole("complementary", { name: "inspector: 261211 8000C" });
        })();
      expect(count(seen(where), clause)).toBe(1);
      expect(seen(where)).not.toMatch(/Switched off by the service/);
      // what only the note says: the code the provider did not know, and why
      expect(seen(where)).toContain("US.SPXW261211C8300000: its strike or its expiry is not one it lists.");
    });

    it("titles the Add sheet once: its choices say a spread or one contract", async () => {
      await openPage(arrangement);
      fireEvent.click(screen.getByRole("button", { name: "add" }));
      const sheet = await screen.findByRole("dialog", { name: "Add" });
      expect(sheet.textContent).not.toContain("Add a spread or contract");
      const choice = within(sheet).getByRole("group", { name: "what to add" });
      expect(within(choice).getByRole("button", { name: "a spread" })).toBeTruthy();
      expect(within(choice).getByRole("button", { name: "one contract" })).toBeTruthy();
      // the payoff preview's note says no "per contract": every figure under it does
      fireEvent.click(within(sheet).getByRole("button", { name: "one contract" }));
      fireEvent.click(within(sheet).getByRole("button", { name: "I hold it" }));
      fireEvent.change(within(sheet).getByLabelText("strike"), { target: { value: "7150" } });
      expect(await within(sheet).findByText("no Entry given, so drawn at 0")).toBeTruthy();
      expect(within(sheet).queryByText(/^per contract/)).toBeNull();
    });

    it("says in Settings once what privacy keeps, and once that a refused source is no dash", async () => {
      await openPage(arrangement);
      fireEvent.click(screen.getByRole("button", { name: "settings" }));
      await settle();
      const panel = screen.getAllByRole("dialog").at(-1)!;
      const privacy = within(panel).getByLabelText("money") as HTMLSelectElement;
      expect([...privacy.options].map((o) => o.textContent)).toEqual(["shown", "hidden"]);
      expect(panel.textContent).toContain("%, Δ, DTE and figures in points per contract — cost to close, entry, the pace gap, the payoff — stay");
      expect(count(panel.textContent!, "permanent dash")).toBe(1);
      expect(panel.textContent).toContain("A vendor this build cannot reach is refused here too, with that reason.");
    });
  });
}
