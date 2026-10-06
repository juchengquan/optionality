import { cleanup, render, screen, within } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";

/** Adding a combo, operated the way a person operates it.
 *
 *  The jsdom tests for this form assert what reaches the server, and they set a strike with
 *  `fireEvent.change` — a synthetic event that sets the DOM value directly. That is not typing. A
 *  real keystroke goes through the browser's own input handling and then through Base UI's number
 *  field, which decides for itself when a value is committed. These tests use real clicks and real
 *  keystrokes so that difference is visible.
 *
 *  They also MEASURE the form. Every control in both add-forms was 86px wide at every viewport
 *  width and the strike box was 22px, because an `inheritance`-era `fieldset { display: inline-block }`
 *  in app.css outranked the FieldSet's own `flex` — Tailwind v4 utilities live in a cascade layer and
 *  an unlayered rule beats a layered one. The form worked: it submitted the right payload, which is
 *  why every functional test passed while the thing could not be typed into. ADR 0008 settled that
 *  the tables are measured rather than eyeballed; the add-forms never were. They are now.
 */

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
};

let posted: { url: string; body: Record<string, unknown> }[] = [];

async function open(which: "add combo" | "add monitor") {
  posted = [];
  window.fetch = ((url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET") {
      posted.push({ url: String(url), body: JSON.parse(init!.body as string) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    const u = String(url);
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(u.endsWith("/quotes") || u.endsWith("/monitors") ? [] : health),
    });
  }) as unknown as typeof fetch;
  render(<App />);
  await new Promise((r) => setTimeout(r, 200));
  await userEvent.click(screen.getByText(which));
  const dialog = await screen.findByRole("dialog");
  // the sheet slides in over 200ms and is narrower than its final width until it lands
  await new Promise((r) => setTimeout(r, 500));
  return dialog;
}
const openCombo = () => open("add combo");

/** Base UI commits a number through `Intl.NumberFormat`, so a typed 8050 reads back "8,050".
 *  These assertions are about the number the box holds, not how it is punctuated, so the group
 *  separator is removed using the one this runtime actually uses rather than assuming a comma. */
const GROUP = new Intl.NumberFormat().formatToParts(11111)
  .find((p) => p.type === "group")?.value ?? "";
const held = (el: HTMLInputElement) => (GROUP ? el.value.split(GROUP).join("") : el.value);

const strikeBox = (form: HTMLElement, n: number) =>
  within(form).getByLabelText(`leg ${n}`, { exact: true }) as HTMLInputElement;

/** `cleanup()` here, rather than the `document.body.innerHTML = ""` the rest of this suite
 *  uses: this form closes its Sheet on submit, and wiping the body mid-exit-animation takes
 *  away the portal node React is itself about to remove. `removeChild` then throws — after
 *  the test has already passed — and the run fails with no failing assertion to point at. */
afterEach(async () => { cleanup(); await page.viewport(1280, 900); });

describe("the leg rows", () => {
  it("starts with two and grows when asked", async () => {
    const form = await openCombo();
    expect(within(form).queryByLabelText("leg 1 sign")).toBeTruthy();
    expect(within(form).queryByLabelText("leg 2 sign")).toBeTruthy();
    expect(within(form).queryByLabelText("leg 3 sign")).toBeNull();

    await userEvent.click(within(form).getByText("add leg"));
    expect(within(form).queryByLabelText("leg 3 sign")).toBeTruthy();
  });

  it("keeps a strike that was typed into an earlier row when a row is added", async () => {
    // the row the value belongs to is identified by its index, and a new row appends
    const form = await openCombo();
    const first = strikeBox(form, 1);
    await userEvent.click(first);
    await userEvent.fill(first, "8050");
    expect(held(first)).toBe("8050");

    await userEvent.click(within(form).getByText("add leg"));
    expect(held(strikeBox(form, 1))).toBe("8050");
  });

  it("takes a typed strike on every row, including one just added", async () => {
    const form = await openCombo();
    await userEvent.click(within(form).getByText("add leg"));
    await userEvent.click(within(form).getByText("add leg"));

    for (const n of [1, 2, 3, 4]) await userEvent.fill(strikeBox(form, n), String(8000 + n));
    for (const n of [1, 2, 3, 4]) expect(held(strikeBox(form, n))).toBe(String(8000 + n));
  });

  it("submits every leg that was typed, with its own strike", async () => {
    // the whole point of the form: four legs, four strikes, the signs the owner chose
    const form = await openCombo();
    await userEvent.fill(within(form).getByLabelText("name"), "1016_IC");
    await userEvent.fill(within(form).getByLabelText("expiry"), "2026-10-16");
    await userEvent.click(within(form).getByText("add leg"));
    await userEvent.click(within(form).getByText("add leg"));

    const legs: [number, string, string, string][] = [
      [1, "-", "CALL", "8050"], [2, "+", "CALL", "8075"],
      [3, "-", "PUT", "7100"], [4, "+", "PUT", "7075"],
    ];
    for (const [n, sign, type, strike] of legs) {
      await userEvent.selectOptions(within(form).getByLabelText(`leg ${n} sign`), sign);
      await userEvent.selectOptions(within(form).getByLabelText(`leg ${n} type`), type);
      await userEvent.fill(strikeBox(form, n), strike);
    }
    await userEvent.fill(within(form).getByLabelText("threshold"), "3.21");
    await userEvent.click(within(form).getByRole("button", { name: "watch combo" }));

    await new Promise((r) => setTimeout(r, 200));
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body.legs).toEqual([
      { sign: -1, option_type: "CALL", strike: 8050 },
      { sign: 1, option_type: "CALL", strike: 8075 },
      { sign: -1, option_type: "PUT", strike: 7100 },
      { sign: 1, option_type: "PUT", strike: 7075 },
    ]);
  });
});

/** the widest the sheet ever gets is `sm:max-w-sm`, 384px, so both sizes are narrow and
 *  the desk case is not a free pass — it caught nothing the phone case did not */
const WIDTHS: [string, number, number][] = [["phone", 390, 844], ["desk", 1280, 900]];

describe("the form fills the sheet", () => {
  for (const [name, w, h] of WIDTHS) {
    it(`the fieldset is as wide as the space it is given — ${name}`, async () => {
      await page.viewport(w, h);
      const form = await openCombo();

      const fieldset = form.querySelector("fieldset")!;
      const parent = fieldset.parentElement!;
      const cs = getComputedStyle(parent);
      const available = parent.getBoundingClientRect().width
        - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);

      // an inline-block fieldset shrink-wrapped to 86px here, whatever the viewport
      expect(fieldset.getBoundingClientRect().width).toBeCloseTo(available, 0);
      expect(available).toBeGreaterThan(200);
    });

    it(`every box you type into spans it — ${name}`, async () => {
      await page.viewport(w, h);
      const form = await openCombo();
      const fieldset = form.querySelector("fieldset")!;
      const available = fieldset.getBoundingClientRect().width;

      // the vertical Fields are `*:w-full`, so each of these should span the fieldset. `entry` is
      // here because it is new and because it is the one number on this form that is money.
      for (const label of ["name", "expiry", "entry", "threshold"]) {
        const box = within(form).getByLabelText(label, { exact: true }) as HTMLInputElement;
        expect(box.getBoundingClientRect().width, label).toBeCloseTo(available, 0);
      }
    });

    it(`does not push the page sideways — ${name}`, async () => {
      await page.viewport(w, h);
      await openCombo();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(w);
    });
  }
});

describe("a four-digit strike fits in the box that takes it", () => {
  for (const [name, w, h] of WIDTHS) {
    it(`every leg's strike is readable once typed — ${name}`, async () => {
      await page.viewport(w, h);
      const form = await openCombo();
      await userEvent.click(within(form).getByText("add leg"));
      await userEvent.click(within(form).getByText("add leg"));

      for (const n of [1, 2, 3, 4]) {
        const box = strikeBox(form, n);
        await userEvent.fill(box, "8050");
        const width = box.getBoundingClientRect().width;
        // 22px before the fix: four digits could not be typed, let alone read
        expect(width, `leg ${n} strike box`).toBeGreaterThanOrEqual(60);
        // the text itself is not clipped — the direct form of the owner's complaint
        expect(box.scrollWidth, `leg ${n} strike text`).toBeLessThanOrEqual(box.clientWidth + 1);
      }
    });

    it(`keeps "leg 1" on one line — ${name}`, async () => {
      await page.viewport(w, h);
      const form = await openCombo();
      const row = strikeBox(form, 1).closest("[data-slot=field]")!;
      const label = row.querySelector("[data-slot=field-label]")! as HTMLElement;

      // The horizontal variant gives the label `flex-auto` — grow AND SHRINK — which is
      // right for label + one control and wrong for a row of four: it squeezed "leg 1"
      // below the 31px its own text needs and the label wrapped to "leg"/"1", at both
      // widths. A width assertion does not see this; the label is narrower than the
      // strike box either way. The number of lines is the thing that changed.
      const lines = label.getBoundingClientRect().height / parseFloat(getComputedStyle(label).lineHeight);
      expect(Math.round(lines), `"${label.textContent}" wrapped`).toBe(1);
      expect(row.getBoundingClientRect().height).toBeLessThan(36);
    });
  }
});

describe("a placeholder you can read", () => {
  for (const [name, w, h] of WIDTHS) {
    it(`every placeholder fits the box it is in — ${name}`, async () => {
      await page.viewport(w, h);
      const form = await openCombo();
      // "strike (blank = skip)" wanted 138px in a box with 100px of text room on a phone, so
      // it showed as "strike (blank..." — a hint is worth nothing where it is cut off. The
      // sheet's description carries the rule now and the box just says "strike".
      const ctx = document.createElement("canvas").getContext("2d")!;
      const boxes = [...form.querySelectorAll("input[placeholder]")] as HTMLInputElement[];
      expect(boxes.length).toBeGreaterThan(0);

      for (const box of boxes) {
        const cs = getComputedStyle(box);
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const room = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        expect(ctx.measureText(box.placeholder).width, `"${box.placeholder}" in ${box.id}`)
          .toBeLessThanOrEqual(room);
      }
    });
  }
});

describe("the monitor form, which shared the bug", () => {
  for (const [name, w, h] of WIDTHS) {
    it(`its boxes are full width too — ${name}`, async () => {
      await page.viewport(w, h);
      const form = await open("add monitor");
      const fieldset = form.querySelector("fieldset")!;
      const available = fieldset.getBoundingClientRect().width;
      expect(available).toBeGreaterThan(200);

      for (const label of ["expiry", "strike", "threshold"]) {
        const box = within(form).getByLabelText(label) as HTMLInputElement;
        // vertical Fields are `*:w-full`, so each box should span the fieldset
        expect(box.getBoundingClientRect().width, label).toBeCloseTo(available, 0);
      }
    });

    it(`its entry row shares one line with the side, usably — ${name}`, async () => {
      await page.viewport(w, h);
      const form = await open("add monitor");
      const box = within(form).getByLabelText("entry", { exact: true }) as HTMLInputElement;
      const row = box.closest("[data-slot=field]")!;
      const label = row.querySelector("[data-slot=field-label]")! as HTMLElement;

      // horizontal, like a combo's leg, so it is subject to the same two faults: a label the
      // variant squeezes below its own text, and a number box the rest of the row crowds out
      const lines = label.getBoundingClientRect().height
        / parseFloat(getComputedStyle(label).lineHeight);
      expect(Math.round(lines), `"${label.textContent}" wrapped`).toBe(1);
      expect(row.getBoundingClientRect().height).toBeLessThan(36);

      await userEvent.fill(box, "5.00");
      expect(box.getBoundingClientRect().width).toBeGreaterThanOrEqual(60);
      expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
    });
  }
});
