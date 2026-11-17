/** The add form's one-contract choice (#331): what it posts to `POST /spreads` — a spread of one
 *  leg and the Monitor naming it — where a refusal is said, what privacy hides, what it says it will
 *  replace, and that a save in flight cannot be sent twice. What the route then DOES with the body
 *  (the linking, the replacing) is held by its door scenarios; that the form FITS, on the desk and
 *  the phone, and that a held one reaches the holdings, is the browser suite's. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SpreadsIn } from "backend/schemas";
import { AddSpread } from "../AddSpread";
import type { Monitor } from "../shared/api";
import { fieldWords } from "../needs";

/** Every request, as `METHOD path` with its parsed body. */
let asked: { what: string; body: unknown }[] = [];
/** How `POST /spreads` is answered; a promise left pending holds a save in flight. */
let answer: { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
const PAYOFF = {
  at_strikes: [{ spx: 7150, pnl: 2.4 }], slope_below: -1, slope_above: 0, breakevens: [7147.6],
  max_profit: 2.4, max_loss: null,
};
const ADDED = {
  positions: [], monitors: [{ id: "m9", code: "US.SPXW261218P7150000", field: "option_delta" }], replaced: [],
};

beforeEach(() => {
  asked = [];
  answer = { status: 201, body: ADDED };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const what = `${init?.method ?? "GET"} ${path}`;
    asked.push({ what, body: init?.body ? JSON.parse(String(init.body)) : null });
    // every route this form calls, answered explicitly; anything else is a 404 in the error shape
    const a = what === "POST /positions/payoff" ? { status: 200, body: PAYOFF }
      : what === "POST /spreads" ? await answer
        : { status: 404, body: { detail: `${what} is not served here` } };
    return { ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body) };
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 09:30 on 11 November in Singapore, which is still the evening of the 10th in New York. */
const SGT_MORNING = new Date("2026-11-11T01:30:00Z");

function open(over: { privacy?: boolean; monitors?: Monitor[] } = {}) {
  const onSaved = vi.fn();
  render(<AddSpread privacy={over.privacy ?? false} spx={null} spxReason="no batch yet" onSaved={onSaved}
                    monitors={over.monitors ?? []} holdings={[]} onCancel={() => undefined} now={SGT_MORNING} />);
  fireEvent.click(screen.getByRole("button", { name: "one contract" }));
  return { form: screen.getByRole("form", { name: "add one contract" }), onSaved };
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const posted = () => asked.filter((a) => a.what === "POST /spreads").map((a) => a.body);
const writes = () => asked.filter((a) => a.what !== "POST /positions/payoff");

/** A put at 7150 on the 18 December expiry, its delta watched at 0.15. */
function enterPut() {
  type("expiry", "2026-12-18");
  type("strike", "7150");
  type("threshold", "0.15");
}

function hold() {
  const opened = open();
  fireEvent.click(screen.getByRole("button", { name: "I hold it" }));
  enterPut();
  return opened;
}

const RULE = { option_type: "PUT", strike: 7150, field: "option_delta", threshold: 0.15, direction: "above", compare: "abs" };

describe("choosing what to add", () => {
  it("starts on a spread, and one contract is one press away, in the same form's place", () => {
    render(<AddSpread privacy={false} spx={null} spxReason={null} onSaved={vi.fn()} monitors={[]} holdings={[]}
                      onCancel={() => undefined} now={SGT_MORNING} />);
    expect(screen.getByRole("form", { name: "add a spread" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "a spread" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "one contract" }));
    expect(screen.queryByRole("form", { name: "add a spread" })).toBeNull();
    expect(screen.getByRole("form", { name: "add one contract" })).toBeTruthy();
  });

  it("keeps each draft when switching back and forth", () => {
    render(<AddSpread privacy={false} spx={null} spxReason={null} onSaved={vi.fn()} monitors={[]} holdings={[]}
                      onCancel={() => undefined} now={SGT_MORNING} />);
    type("spread 1, leg 1 strike", "7150");
    fireEvent.click(screen.getByRole("button", { name: "one contract" }));
    type("strike", "6800");
    fireEvent.click(screen.getByRole("button", { name: "a spread" }));
    expect((screen.getByLabelText("spread 1, leg 1 strike") as HTMLInputElement).value).toBe("7150");
    fireEvent.click(screen.getByRole("button", { name: "one contract" }));
    expect((screen.getByLabelText("strike") as HTMLInputElement).value).toBe("6800");
  });
});

describe("a save in flight", () => {
  it("cannot be sent twice: the button and the choice of form are both held until it answers", async () => {
    let release!: (a: { status: number; body: unknown }) => void;
    answer = new Promise((r) => { release = r; });
    const { onSaved } = open();
    enterPut();
    fireEvent.click(screen.getByRole("button", { name: "Watch it + 1 rule" }));
    await waitFor(() => expect(posted()).toHaveLength(1));
    const save = screen.getByRole("button", { name: "saving…" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    for (const name of ["a spread", "one contract"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    // a switch to the spread form and back would mount a fresh button that saves again
    fireEvent.click(screen.getByRole("button", { name: "a spread" }));
    expect(screen.getByRole("form", { name: "add one contract" })).toBeTruthy();
    fireEvent.click(save);
    expect(posted()).toHaveLength(1);
    release({ status: 201, body: ADDED });
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(posted()).toHaveLength(1);
  });

  it("is held in the spread form too", async () => {
    answer = new Promise(() => undefined);
    render(<AddSpread privacy={false} spx={null} spxReason={null} onSaved={vi.fn()} monitors={[]} holdings={[]}
                      onCancel={() => undefined} now={SGT_MORNING} />);
    type("expiry", "2026-12-18");
    type("spread 1, leg 1 strike", "7150");
    type("spread 1, leg 2 strike", "7100");
    type("spread 1 entry", "1.50");
    fireEvent.click(screen.getByRole("button", { name: /^Record/ }));
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect((screen.getByRole("button", { name: "one contract" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("a watched contract", () => {
  it("posts one spread of one leg, watched, with the one Monitor naming it", async () => {
    const { onSaved } = open();
    enterPut();
    fireEvent.click(screen.getByRole("button", { name: "Watch it + 1 rule" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(writes().map((a) => a.what)).toEqual(["POST /spreads"]);
    expect(SpreadsIn.safeParse(posted()[0]).success).toBe(true);
    expect(posted()[0]).toEqual({
      strike_date: "2026-12-18",
      spreads: [{
        name: "20261218_P7150", held: false, legs: [{ side: "short", option_type: "PUT", strike: 7150 }], monitors: [RULE],
      }],
    });
    expect(onSaved.mock.calls[0]![0]).toEqual(ADDED);
  });

  it("posts the field, type, direction and compare chosen — a call's vega, signed, below", async () => {
    const { onSaved } = open();
    enterPut();
    fireEvent.click(screen.getByRole("button", { name: "CALL" }));
    fireEvent.change(screen.getByLabelText("what it watches"), { target: { value: "option_vega" } });
    const direction = screen.getByRole("group", { name: "direction" });
    expect(within(direction).getByRole("button", { name: "≥ at or above" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(direction).getByRole("button", { name: "≤ at or below" }));
    expect(within(direction).getByRole("button", { name: "≤ at or below" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(direction).getByRole("button", { name: "≥ at or above" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.change(screen.getByLabelText("compare"), { target: { value: "signed" } });
    type("threshold", "-0.5");
    fireEvent.click(screen.getByRole("button", { name: "Watch it + 1 rule" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    const spread = (posted()[0] as { spreads: { legs: unknown[]; monitors: unknown[] }[] }).spreads[0]!;
    expect(spread.legs).toEqual([{ side: "short", option_type: "CALL", strike: 7150 }]);
    expect(spread.monitors).toEqual([
      { option_type: "CALL", strike: 7150, field: "option_vega", threshold: -0.5, direction: "below", compare: "signed" },
    ]);
  });

  it("posts a contract's value at or below, as the pair says, and says it so (#405)", async () => {
    const { onSaved } = open();
    enterPut();
    fireEvent.change(screen.getByLabelText("what it watches"), { target: { value: "mid_price" } });
    fireEvent.click(within(screen.getByRole("group", { name: "direction" })).getByRole("button", { name: "≤ at or below" }));
    type("threshold", "0.50");
    expect(screen.getByTestId("contract-draft").textContent).toMatch(/≤ 0\.50$/);
    fireEvent.click(screen.getByRole("button", { name: "Watch it + 1 rule" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect((posted()[0] as { spreads: { monitors: unknown[] }[] }).spreads[0]!.monitors).toEqual([
      { option_type: "PUT", strike: 7150, field: "mid_price", threshold: 0.5, direction: "below", compare: "abs" },
    ]);
  });

  it("switches the direction pair off with a held contract's rule, and on again with it", () => {
    hold();
    const buttons = () => within(screen.getByRole("group", { name: "direction" })).getAllByRole("button") as HTMLButtonElement[];
    expect(buttons().map((b) => b.disabled)).toEqual([false, false]);
    fireEvent.click(screen.getByRole("switch", { name: /^rule (on|off)$/ }));
    expect(buttons().map((b) => b.disabled)).toEqual([true, true]);
    fireEvent.click(screen.getByRole("switch", { name: /^rule (on|off)$/ }));
    expect(buttons().map((b) => b.disabled)).toEqual([false, false]);
  });

  it("offers each of the six fields in the box's own words, its value first and delta chosen (#405)", () => {
    open();
    const box = screen.getByLabelText("what it watches") as HTMLSelectElement;
    expect(box.value).toBe("option_delta");
    expect([...box.options].map((o) => [o.value, o.textContent])).toEqual([
      "mid_price", "option_delta", "option_implied_volatility", "option_theta", "option_vega", "option_gamma",
    ].map((f) => [f, fieldWords(f)]));
  });

  it("says the rule in words as it is typed", () => {
    open();
    enterPut();
    // drawn short (#388), which as typed IS its words: written once, for a reader too (2026-11-16)
    const draft = screen.getByTestId("contract-draft");
    expect(draft.querySelector(".nx-rule-short")!.textContent).toBe("7150 put |Δ| ≥ 0.15");
    expect(draft.textContent).toBe("7150 put |Δ| ≥ 0.15");
    expect(draft.querySelector(".sr-only")).toBeNull();
  });

  it("says a signed threshold of 0 beside the box as it is typed, and sends nothing", () => {
    const { form } = open();
    enterPut();
    fireEvent.change(screen.getByLabelText("compare"), { target: { value: "signed" } });
    type("threshold", "0");
    const box = screen.getByLabelText("threshold");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    const note = document.getElementById(box.getAttribute("aria-describedby")!)!;
    expect(note.textContent).toBe("a signed threshold is never exactly 0: use e.g. ±0.01");
    fireEvent.click(within(form).getByRole("button", { name: "Watch it + 1 rule" }));
    expect(writes()).toEqual([]);
  });

  it("offers no 'no rule': a watched contract with none would record nothing", () => {
    open();
    expect(screen.queryByRole("switch", { name: /^rule (on|off)$/ })).toBeNull();
  });
});

describe("a held contract", () => {
  it("starts Opened on the New York trading day, not the local one", () => {
    hold();
    expect((screen.getByLabelText("opened") as HTMLInputElement).value).toBe("2026-11-10");
  });

  it("posts a one-leg spread, held, with its figures and its Monitor; a long's Entry as paid", async () => {
    const { onSaved } = hold();
    fireEvent.click(screen.getByRole("button", { name: "long" }));
    type("entry", "5.20");
    type("contracts", "2");
    fireEvent.click(screen.getByRole("button", { name: "Record holding + 1 rule" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(writes().map((a) => a.what)).toEqual(["POST /spreads"]);
    expect(SpreadsIn.safeParse(posted()[0]).success).toBe(true);
    expect(posted()[0]).toEqual({
      strike_date: "2026-12-18",
      spreads: [{
        name: "20261218_P7150", held: true, legs: [{ side: "long", option_type: "PUT", strike: 7150 }],
        entry: -5.2, contracts: 2, opened_at: "2026-11-10", monitors: [RULE],
      }],
    });
  });

  it("records the holding with no rule when its Monitor is switched off", async () => {
    const { onSaved } = hold();
    const rule = screen.getByRole("switch", { name: /^rule (on|off)$/ });
    expect(rule.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(rule);
    expect(rule.getAttribute("aria-checked")).toBe("false");
    expect((screen.getByLabelText("threshold") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Record holding" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect((posted()[0] as { spreads: { held: boolean; monitors: unknown[] }[] }).spreads[0])
      .toMatchObject({ held: true, monitors: [] });
  });

  it("labels the Entry by the side: received when short, paid when long", () => {
    hold();
    expect(screen.getByText("entry received, per contract")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "long" }));
    expect(screen.getByText("entry paid, per contract")).toBeTruthy();
  });

  it("hides the contract count under privacy, with the class that masks it", () => {
    hold();
    expect(screen.getByLabelText("contracts").classList.contains("nx-private")).toBe(false);
    cleanup();
    open({ privacy: true });
    fireEvent.click(screen.getByRole("button", { name: "I hold it" }));
    expect(screen.getByLabelText("contracts").classList.contains("nx-private")).toBe(true);
  });

  it("previews the payoff of the one leg at its Entry, per contract, and says when none is given", async () => {
    hold();
    expect(await screen.findByText("no Entry given, so drawn at 0")).toBeTruthy();
    type("entry", "2.40");
    type("contracts", "3");
    await waitFor(() => expect(asked.filter((a) => a.what === "POST /positions/payoff").at(-1)?.body).toEqual({
      legs: [{ side: "short", option_type: "PUT", strike: 7150 }], entry: 2.4, contracts: 1,
    }));
    await screen.findByRole("group", { name: /payoff at expiry by SPX price/ });
    expect(screen.getByText("at a credit of 2.40")).toBeTruthy();
    // the number alone (the owner, 2026-11-17): points per contract, with no unit after it
    expect(screen.getByText("max profit").nextElementSibling!.textContent).toMatch(/^[+−]\d+\.\d\d$/);
  });

  it("names the watch rule it will replace, before saving", () => {
    const watching: Monitor = {
      id: "w1", code: "US.SPXW261218P7150000", strike_date: "2026-12-18", option_type: "PUT", strike: 7150,
      field: "option_delta", threshold: 0.15, direction: "above", compare: "abs", legs: null, enabled: true,
      scope: null, positions: [], disabled_reason: null, triggered: false, last_value: null,
      last_checked_at: null, created_at: null,
    };
    open({ monitors: [watching] });
    enterPut();
    expect(screen.queryByText(/^Replaces the watch rules/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "I hold it" }));
    expect(screen.getByText("Replaces the watch rules: 7150 put |Δ| ≥ 0.15")).toBeTruthy();
  });
});

describe("a refusal", () => {
  it("from the probe is said IN the form, and what was typed is kept", async () => {
    answer = { status: 422, body: { detail: "contract does not exist: US.SPXW261218P7150000 — check strike and expiry" } };
    const { form, onSaved } = open();
    enterPut();
    fireEvent.click(screen.getByRole("button", { name: "Watch it + 1 rule" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe("contract does not exist: US.SPXW261218P7150000 — check strike and expiry");
    expect(onSaved).not.toHaveBeenCalled();
    expect((screen.getByLabelText("strike") as HTMLInputElement).value).toBe("7150");
  });

  it("of a rule already there is said beside what it watches", async () => {
    answer = { status: 409, body: { detail: "monitor for (US.SPXW261218P7150000, option_delta) already exists" } };
    open();
    enterPut();
    fireEvent.click(screen.getByRole("button", { name: "Watch it + 1 rule" }));
    const alert = await screen.findByRole("alert");
    expect(screen.getByLabelText("what it watches").getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("of a holding's name taken is said beside the name, and one request was all it took", async () => {
    answer = { status: 409, body: { detail: "position '20261218_P7150' already exists" } };
    const { onSaved } = hold();
    fireEvent.click(screen.getByRole("button", { name: /^Record/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("position '20261218_P7150' already exists");
    expect(screen.getByLabelText("name").getAttribute("aria-describedby")).toBe(alert.id);
    expect(writes().map((a) => a.what)).toEqual(["POST /spreads"]);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("of the draft's own is said before asking the service anything", () => {
    const { form } = open();
    type("strike", "7150");
    fireEvent.click(within(form).getByRole("button", { name: "Watch it + 1 rule" }));
    expect(within(form).getByRole("alert").textContent).toBe("type the expiry");
    expect(writes()).toEqual([]);
  });

  it("of an expiry already past, against the New York trading day", () => {
    open();
    enterPut();
    type("expiry", "2026-11-09");
    fireEvent.click(screen.getByRole("button", { name: "Watch it + 1 rule" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("that expiry has passed");
    expect(screen.getByLabelText("expiry").getAttribute("aria-describedby")).toBe(alert.id);
    expect(writes()).toEqual([]);
  });

  it("of an Opened after the expiry is said beside Opened", () => {
    hold();
    type("expiry", "2026-11-13");
    type("opened", "2026-11-14");
    fireEvent.click(screen.getByRole("button", { name: /^Record/ }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Opened is after the expiry");
    expect(screen.getByLabelText("opened").getAttribute("aria-describedby")).toBe(alert.id);
    expect(writes()).toEqual([]);
  });
});

describe("switching Watch and Hold (#408)", () => {
  const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;
  const toWatch = () => fireEvent.click(screen.getByRole("button", { name: "Watch it" }));
  const toHold = () => fireEvent.click(screen.getByRole("button", { name: "I hold it" }));

  it("loses nothing typed, either way, any number of times — and posts all of it", async () => {
    const { onSaved } = open();
    type("expiry", "2026-12-18");
    fireEvent.click(screen.getByRole("button", { name: "CALL" }));
    type("strike", "7700");
    type("what it watches", "option_theta");
    fireEvent.click(within(screen.getByRole("group", { name: "direction" })).getByRole("button", { name: "≤ at or below" }));
    type("compare", "signed");
    type("threshold", "-0.5");

    toHold();
    type("opened", "2026-11-09");
    fireEvent.click(within(screen.getByRole("group", { name: "side" })).getByRole("button", { name: "long" }));
    type("entry", "4.20");
    type("contracts", "2");
    type("name", "my call");

    for (let i = 0; i < 3; i += 1) {
      toWatch();
      expect([value("expiry"), value("strike"), value("what it watches"), value("compare"), value("threshold")])
        .toEqual(["2026-12-18", "7700", "option_theta", "signed", "-0.5"]);
      expect(screen.getByRole("button", { name: "CALL" }).getAttribute("aria-pressed")).toBe("true");
      expect(within(screen.getByRole("group", { name: "direction" })).getByRole("button", { name: "≤ at or below" })
        .getAttribute("aria-pressed")).toBe("true");
      expect(screen.queryByLabelText("entry")).toBeNull();
      toHold();
      expect([value("opened"), value("entry"), value("contracts"), value("name")])
        .toEqual(["2026-11-09", "4.20", "2", "my call"]);
      expect(within(screen.getByRole("group", { name: "side" })).getByRole("button", { name: "long" })
        .getAttribute("aria-pressed")).toBe("true");
      expect(value("threshold")).toBe("-0.5");
    }

    fireEvent.click(screen.getByRole("button", { name: "Record holding + 1 rule" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    const body = posted()[0];
    expect(SpreadsIn.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      strike_date: "2026-12-18",
      spreads: [{
        name: "my call", held: true, legs: [{ side: "long", option_type: "CALL", strike: 7700 }],
        entry: -4.2, contracts: 2, opened_at: "2026-11-09",
        monitors: [{ option_type: "CALL", strike: 7700, field: "option_theta", threshold: -0.5, direction: "below", compare: "signed" }],
      }],
    });
  });
});

describe("nothing said twice (2026-11-16)", () => {
  it("writes the draft's rule ONCE, where the short form and the words are the same", () => {
    const { form } = open();
    fireEvent.click(screen.getByRole("button", { name: "Watch it" }));
    const said = screen.getByTestId("contract-draft");
    expect(said.textContent).toBe("… put |Δ| ≥ …");
    enterPut();
    expect(said.textContent).toBe("7150 put |Δ| ≥ 0.15");
    expect(form.textContent!.split("7150 put |Δ| ≥ 0.15")).toHaveLength(2);
  });

  it("says nothing under a watched contract that Watch it already says, and keeps the one footer", () => {
    const { form } = open();
    fireEvent.click(screen.getByRole("button", { name: "Watch it" }));
    expect(form.textContent).not.toContain("records no holding");
    expect(form.textContent).toContain("One save makes all of it, or none of it if anything is refused.");
  });

  it("says a held contract's rule once: no line beside its switch repeating the sentence", () => {
    const { form } = hold();
    expect(form.textContent).not.toContain("a rule on this contract");
    // the switch says what it switches, drawn and to a reader (review of #415), where "on" alone did not
    const toggle = screen.getByRole("switch", { name: "rule on" });
    expect(toggle.textContent).toBe("rule on");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.textContent).toBe("rule off");
    expect(screen.getByRole("switch", { name: "rule off" })).toBe(toggle);
    expect(screen.getByTestId("contract-draft").textContent).toBe("no rule: the holding alone");
    // said once, in the one line that says it
    expect(form.textContent!.split("no rule")).toHaveLength(2);
  });

  it("writes the side as − and +, named short and long, the word in its tooltip", () => {
    hold();
    const pair = screen.getByRole("group", { name: "side" });
    const [short, long] = within(pair).getAllByRole("button") as HTMLButtonElement[];
    expect([short!.textContent, long!.textContent]).toEqual(["\u2212", "+"]);
    expect(within(pair).getByRole("button", { name: "short" })).toBe(short);
    expect(within(pair).getByRole("button", { name: "long" })).toBe(long);
    expect([short!.title, long!.title]).toEqual(["short", "long"]);
  });

  it("says only \"type the strike\" under the payoff's own heading", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "I hold it" }));
    expect(screen.getByText("type the strike")).toBeTruthy();
  });
});
