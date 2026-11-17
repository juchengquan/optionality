/** Each thing said once (the owner, 2026-11-17: "we can still remove some descriptive text more,
 *  currently there are still duplicate about them and their titles"; ADR 0023, amended). On the desk
 *  and the phone alike:
 *
 *  - over the whole page walk (`testing/pageWalk.tsx`), in session and out: no sentence drawn twice
 *    in one place — an inspector, a sheet, a form, the page — and no bar toward a rule's threshold,
 *    which said again what the rule's arrowed distance says (`↑1.31`, #388);
 *  - and each repeat that was removed, by name, with the fact it carried that is still said.
 *
 *  What is compared is what a sighted viewer reads: an element's whole text with what a reader alone
 *  hears (`.sr-only`) left out — a drawn short form hidden from a reader (`aria-hidden`) included, so
 *  the rule line drawn twice is caught — each text counted at the innermost element that draws all of
 *  it, at least 16 characters with a word in it. And a PHRASE: seven words in a row said in two
 *  places of one screen. A book is read one row or card at a time, and around them: a rule drawn
 *  under each holding it covers is drawn in two cards, not twice in one.
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

/** `el`'s text as a sighted viewer reads it: a reader's copies left out. */
function visible(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const x of copy.querySelectorAll(".sr-only, svg, script, style")) x.remove();
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Words that are a figure's unit, not prose: a text of figures and units says nothing twice when
 *  two figures happen to agree — a payoff's maximum and its P&L at the axis' end. */
const UNITS = new Set(["pts", "per", "contract", "contracts", "dte", "unchanged"]);
const isProse = (text: string) =>
  text.toLowerCase().split(/[^a-z']+/).some((w) => w.length >= 3 && !UNITS.has(w));

interface Said { el: Element; text: string }

/** Every text drawn in `root`, each at the innermost element that draws all of it. */
export function sentencesOf(root: Element): Said[] {
  const out: Said[] = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (el.closest(".sr-only, svg, script, style")) continue;
    const text = visible(el);
    if (text.length < 16 || !isProse(text)) continue;
    // an element whose one child draws the same text is that child, counted once
    if ([...el.children].some((c) => visible(c) === text)) continue;
    // a row of buttons, or the labels of a form's boxes: controls are named for what they act on,
    // and a rule's "edit · mute · delete…" under each rule is one set of words per rule
    if (onlyIn(el, "button, label, legend")) continue;
    out.push({ el, text });
  }
  return out;
}

/** Whether every visible word of `el` is inside one of `selector`'s elements. */
function onlyIn(el: Element, selector: string): boolean {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let any = false;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent!.trim() || n.parentElement!.closest(".sr-only")) continue;
    any = true;
    const holder = n.parentElement!.closest(selector);
    if (!holder || !el.contains(holder) && holder !== el) return false;
  }
  return any;
}

/** Six words in a row, lower-cased and bare of punctuation, of a text. */
function phrasesOf(text: string): Set<string> {
  const words = text.toLowerCase().split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}|]+|[^\p{L}\p{N}|]+$/gu, ""))
    .filter((w) => /[a-z]/.test(w));
  const out = new Set<string>();
  for (let k = 0; k + 6 <= words.length; k++) out.add(words.slice(k, k + 6).join(" "));
  return out;
}

/** The units a place is read in: each row of the desk's book and each card of the phone's apart,
 *  and the rest of it around them. */
const UNIT = ".nxd-row, .nxp-card, .nx-book > section";
function units(root: Element): Element[] {
  // each list of the book — Holdings, Watchlist — is read apart: each has its expiries' headings
  const parts = [...root.querySelectorAll(UNIT)];
  if (parts.length === 0) return [root];
  const out: Element[] = [];
  for (const p of parts) {
    const own = p.cloneNode(true) as Element;
    for (const x of own.querySelectorAll(UNIT)) x.remove();
    out.push(own);
  }
  const rest = root.cloneNode(true) as Element;
  for (const x of rest.querySelectorAll(UNIT)) x.remove();
  return [...parts.filter((p) => p.matches(".nxd-row, .nxp-card")), ...out.filter((_, i) => !parts[i]!.matches(".nxd-row, .nxp-card")), rest];
}

const related = (a: Element, b: Element) => a.contains(b) || b.contains(a);

/** What is said more than once in one unit of `root`: a whole text in two places, or six words in a
 *  row in two texts — never counting a text and the element around it, which is one saying. */
export function twice(root: Element): string[] {
  const found = new Set<string>();
  for (const unit of units(root)) {
    const said = sentencesOf(unit);
    const phrases = said.map((s) => phrasesOf(s.text));
    for (let a = 0; a < said.length; a++) {
      for (let b = a + 1; b < said.length; b++) {
        if (related(said[a]!.el, said[b]!.el)) continue;
        if (said[a]!.text === said[b]!.text) { found.add(`twice: ${said[a]!.text}`); continue; }
        const shared = [...phrases[a]!].find((p) => phrases[b]!.has(p));
        if (shared) found.add(`phrase "${shared}" in: ${said[a]!.text} | ${said[b]!.text}`);
      }
    }
  }
  return [...found];
}

describe("the check sees what is said twice (each fails on a planted fault)", () => {
  it("a sentence twice in one place, across markup", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p>a leg has no figure, and no sum is taken from part of them</p>
      <div><span>a leg has <b>no figure</b>, and no sum is taken from part of them</span></div>`;
    expect(twice(root)).toEqual(["twice: a leg has no figure, and no sum is taken from part of them"]);
  });

  it("the rule line again \"as saved\": a drawn short form is what a viewer reads", () => {
    const root = document.createElement("div");
    const line = `<span class="sr-only">|value| ≥ 4.51 — now −3.20, 1.31 away</span><span aria-hidden="true">|value| ≥ 4.51   −3.20  ↑1.31</span>`;
    root.innerHTML = `<li><span>${line}</span><form><p>as saved: ${line}</p></form></li>`;
    expect(twice(root)).toEqual(["twice: |value| ≥ 4.51 −3.20 ↑1.31"]);
  });

  it("a phrase said in two notes", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p>A raw code: so a code nothing can price is refused here rather than becoming a permanent dash.</p>
      <p>A vendor this build cannot reach is refused here with that reason, rather than becoming a permanent dash.</p>`;
    expect(twice(root).join("\n")).toMatch(/phrase "rather than becoming a permanent dash/);
  });

  it("not a reader's copy beside what is drawn, nor figures, nor a rule drawn in two cards", () => {
    const root = document.createElement("div");
    root.innerHTML = `<span class="sr-only">|value| ≥ 5.51 — now −1.80, 3.71 away</span>
      <span aria-hidden="true">|value| ≥ 5.51   −1.80  ↑3.71</span>
      <p>−48.00 pts per contract</p><p>−48.00 pts per contract</p>
      <article class="nxp-card"><p>|value| ≥ 8.00   6.40  ↑1.60 on the condor</p></article>
      <article class="nxp-card"><p>|value| ≥ 8.00   6.40  ↑1.60 on the condor</p></article>`;
    expect(twice(root)).toEqual([]);
  });
});

/** A bar toward a rule's threshold, however drawn: the desk's meter or the phone's progress bar. */
const BARS = "[role=progressbar], [role=meter], .nxp-progress, .nxd-fill, [data-fill]";

describe("no sentence said twice in one place, nor a bar beside a rule's distance, anywhere the page draws words", () => {
  for (const [when, now, shape] of [["in session", MONDAY, undefined], ["outside the session", SUNDAY, undefined],
    ["outside the session, SPX the last close's level", SUNDAY, (p: string, b: unknown) => stale(p, b)]] as const) {
    for (const [arrangement, walk] of [["desk", walkDesk], ["phone", walkPhone]] as const) {
      it(`on the ${arrangement}, ${when}`, async () => {
        const said: string[] = [];
        const read: Read = (where, root) => {
          said.push(...twice(root).map((s) => `${where}: ${s}`));
          // no bar toward a threshold: the rule's arrowed distance says how close (the owner, 2026-11-17)
          if (root.querySelector(BARS)) said.push(`${where}: a bar toward a threshold`);
        };
        await walk(read, now, shape);
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

    it("says SPX's reason once for the whole book, each strip marking its price instead", async () => {
      await openPage(arrangement, MONDAY, stale);
      const book = document.querySelector(".nx-book")!;
      // once in what is seen, and once in what a reader hears: the marks are hidden from it
      expect(count(seen(book), REASON)).toBe(1);
      const heard = book.cloneNode(true) as Element;
      for (const el of heard.querySelectorAll("[aria-hidden='true']")) el.remove();
      expect(count(heard.textContent!, REASON)).toBe(1);
      expect(within(book as HTMLElement).getByText(`* SPX: ${REASON}`)).toBeTruthy();
      const strips = [...book.querySelectorAll("figure[aria-label='strike strip']")];
      if (arrangement === "phone") {
        // every card's strip: its price and the mark, never the reason
        expect(strips.length).toBeGreaterThan(3);
        for (const f of strips) {
          expect(f.querySelector(".nxs-spx-words")!.textContent).toMatch(/^SPX (\d+\.\d{2}|—)\*$/);
          expect(f.querySelector("[data-spx-mark]")!.getAttribute("aria-hidden")).toBe("true");
        }
      } else {
        // the desk's rows draw the hollow dot alone; the note is the book's one sentence
        expect(strips).toHaveLength(0);
        expect(book.querySelectorAll(".nxs-spx[data-stale]").length).toBeGreaterThan(3);
      }
    });

    it("says an expired rule is expired once, beside the day it expired and the day it goes", async () => {
      await openPage(arrangement);
      const row = arrangement === "phone"
        ? document.querySelector("[data-monitor='m-expired']")!
        : document.querySelector(".nxd-muted [data-ref='m-expired']")!;
      expect(count(seen(row).toLowerCase(), "expired")).toBe(1);
      expect(seen(row)).toMatch(/Fri 6 Nov — the service deletes it on \w{3} \d{1,2} \w{3}/);
    });

    it("says SPX's reason under the payoff where no strip is drawn to say it (review of #423)", async () => {
      // a short leg with no strike the service placed, and no long one: the strip draws nothing
      const bare = (path: string, body: unknown): unknown => {
        const b = stale(path, body);
        if (path !== "/positions/values") return b;
        return (b as Holding[]).map((h) => h.id !== "h-calls" ? h
          : { ...h, legs: h.legs.filter((l) => l.side === "short"), short_strikes: [] });
      };
      await openPage(arrangement, MONDAY, bare);
      let d: HTMLElement;
      if (arrangement === "phone") {
        // its rule now stands apart under the same name: the holding's own card
        fireEvent.click(document.querySelector<HTMLButtonElement>("[data-ref='h-calls'] .nxp-open")!);
        await settle();
        d = screen.getByRole("dialog");
      } else d = await detail(arrangement, "1218_C7300");
      await waitFor(() => expect(d.querySelector("[aria-label='payoff at expiry'] dl")).toBeTruthy());
      expect(d.querySelector("[aria-label='strike strip']")).toBeNull();
      expect(count(seen(d), REASON)).toBe(1);
      expect(d.querySelector("[aria-label='payoff at expiry']")!.textContent).toContain(REASON);
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
      // named in full to a reader, titled "Add" on screen: its first control says the rest
      const sheet = await screen.findByRole("dialog", { name: "Add a spread or contract" });
      expect(seen(sheet)).not.toContain("Add a spread or contract");
      expect(seen(sheet.querySelector("h2, [data-slot='sheet-title']")!).trim()).toBe("Add");
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
