/** Renaming a combo, splitting a total entry, and recording a holding of a watched contract, from a
 *  rule's controls (#336) — in the desk's inspector and the phone's sheet alike. Behaviour: what is
 *  sent, what is said before and after, and where a refusal is said. That it is VISIBLE, 16px and
 *  44pt on a phone is the browser suites' (`__browser__/NextRuleWrites*.test.tsx`). */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import type { Added, Entry } from "../shared/api";
import type { SpreadsBody } from "../next/add";
import type { BookProps } from "../next/Book";
import { DeskBook } from "../next/desk/DeskBook";
import { ruleOfEntry } from "../next/edit";
import { MonitorActionsContext, MonitorControls, type MonitorActions } from "../next/MonitorEdit";
import { Next } from "../next/Next";
import { PhoneBook } from "../next/phone/PhoneBook";
import { QUOTES } from "../testing/ownerBook";
import { CONDOR, CS, serveRuleEdits, splitBook } from "../testing/ruleEdits";

afterEach(cleanup);

const quote = (id: string) => QUOTES.find((q) => q.id === id)!;
const SPREAD = quote("w-dec18");
const LONE = quote("w-lone");
const DELTA = quote("w-dec18-delta");
const HELD = quote("r-calls");

const ADDED: Added = { positions: [{ id: "h-new", name: "1231_C8000" }], monitors: [], replaced: [] };

function actions(over: Partial<MonitorActions> = {}) {
  const sent: { what: string; id?: string; body?: unknown }[] = [];
  const { monitors, holdings } = splitBook();
  const value: MonitorActions = {
    patch: vi.fn(async (id: string, body: unknown) => { sent.push({ what: "PATCH", id, body }); }),
    remove: vi.fn(async (id: string) => { sent.push({ what: "DELETE", id }); }),
    totalEntry: vi.fn(async (id: string, entry: number) => { sent.push({ what: "TOTAL", id, body: { entry } }); }),
    hold: vi.fn(async (body: SpreadsBody) => { sent.push({ what: "SPREADS", body }); return ADDED; }),
    book: { monitors, holdings, privacy: false },
    retentionDays: 7,
    // the evening of 10 November in New York: the 10th is its trading day
    now: () => new Date("2026-11-11T01:30:00Z"),
    ...over,
  };
  return { value, sent };
}

function controls(entry: Entry, over: Partial<MonitorActions> = {}) {
  const a = actions(over);
  render(
    <MonitorActionsContext.Provider value={a.value}>
      <MonitorControls rule={ruleOfEntry(entry)} served={entry} />
    </MonitorActionsContext.Provider>,
  );
  return a;
}

const type = (form: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(form).getByLabelText(label), { target: { value } });

async function openEditor(label: string) {
  fireEvent.click(screen.getByRole("button", { name: `edit ${label}` }));
  return screen.findByRole("form", { name: `editing ${label}` });
}

describe("renaming a combo from its editor", () => {
  it("has a name box for a combo, which sends the new name through PATCH", async () => {
    const { sent } = controls(SPREAD);
    const form = await openEditor("1218_P7150 spread value");
    const box = within(form).getByLabelText("name") as HTMLInputElement;
    expect(box.value).toBe("1218_P7150");
    type(form, "name", "dec-put-spread");
    fireEvent.click(within(form).getByRole("button", { name: "save" }));
    await waitFor(() => expect(sent).toEqual([{ what: "PATCH", id: SPREAD.id, body: { name: "dec-put-spread" } }]));
  });

  it("has no name box for a single contract", async () => {
    controls(DELTA);
    const form = await openEditor("261218 7150P delta");
    expect(within(form).queryByLabelText("name")).toBeNull();
  });

  it("says a name already taken beside the name, in the service's words", async () => {
    const refusal = "monitor for (1231_C7600, mid_price) already exists";
    controls(SPREAD, { patch: vi.fn(async () => { throw new Error(refusal); }) });
    const form = await openEditor("1218_P7150 spread value");
    type(form, "name", "1231_C7600");
    fireEvent.click(within(form).getByRole("button", { name: "save" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe(refusal);
    const box = within(form).getByLabelText("name");
    expect(box.closest(".nx-mon-field")!.contains(alert)).toBe(true);
    expect(box.getAttribute("aria-invalid")).toBe("true");
  });

  it("refuses a blank name beside the name, and sends nothing", async () => {
    const { sent } = controls(SPREAD);
    const form = await openEditor("1218_P7150 spread value");
    type(form, "name", " ");
    fireEvent.click(within(form).getByRole("button", { name: "save" }));
    const alert = within(form).getByRole("alert");
    expect(alert.textContent).toBe("type a name");
    expect(within(form).getByLabelText("name").closest(".nx-mon-field")!.contains(alert)).toBe(true);
    expect(sent).toEqual([]);
  });

  it("says, for a held spread, that its holding keeps the name it was recorded with", async () => {
    controls(HELD);
    const form = await openEditor("1218_C7300 spread value");
    expect(form.textContent).toContain(
      "Renames this Monitor only: the holding 1218_C7300 keeps its name — the service never renames a holding.");
  });
});

describe("splitting a total entry", () => {
  const LABEL = "1218_IC spread value";

  it("is offered on a rule over two holdings, and not on a rule over one", () => {
    controls(CONDOR);
    expect(screen.getByRole("button", { name: `split a total entry across ${LABEL}` })).toBeTruthy();
    cleanup();
    controls(HELD);
    expect(screen.queryByRole("button", { name: /^split a total entry/ })).toBeNull();
  });

  it("shows what each holding gets before saving, and sends the total to the route", async () => {
    const { sent } = controls(CONDOR);
    fireEvent.click(screen.getByRole("button", { name: `split a total entry across ${LABEL}` }));
    const form = screen.getByRole("form", { name: `split a total entry across ${LABEL}` });
    // the focus is in the box, and nothing has been worked out from nothing
    expect(document.activeElement).toBe(within(form).getByLabelText("total entry, per contract"));
    type(form, "total entry, per contract", "6.4");
    const rows = within(form).getAllByRole("row").slice(1).map((r) => r.textContent);
    expect(rows).toEqual([
      "1218_C7300" + "2.00" + "2.00 — kept: it has a rule of its own",
      "1218_P6400" + "2.00" + "4.40 — the rest",
    ]);
    fireEvent.click(within(form).getByRole("button", { name: "save the split" }));
    await waitFor(() => expect(sent).toEqual([{ what: "TOTAL", id: CONDOR.id, body: { entry: 6.4 } }]));
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    expect(screen.getByRole("status").textContent).toBe("total entry saved");
  });

  it("says before saving why the service would refuse, and says its refusal beside the box", async () => {
    const refusal = "set the other wings' credits first";
    const { monitors, holdings } = splitBook();
    controls(CONDOR, {
      book: { monitors, holdings: holdings.map((h) => h.id === "h-calls" ? { ...h, entry: null } : h), privacy: false },
      totalEntry: vi.fn(async () => { throw new Error(refusal); }),
    });
    fireEvent.click(screen.getByRole("button", { name: `split a total entry across ${LABEL}` }));
    const form = screen.getByRole("form", { name: `split a total entry across ${LABEL}` });
    type(form, "total entry, per contract", "6.4");
    expect(within(form).getByTestId("split-why").textContent).toBe(`The service will refuse this: ${refusal}.`);
    fireEvent.click(within(form).getByRole("button", { name: "save the split" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe(refusal);
    expect(within(form).getByLabelText("total entry, per contract").closest(".nx-mon-field")!.contains(alert)).toBe(true);
  });

  it("refuses a total that is not a number, and sends nothing", () => {
    const { sent } = controls(CONDOR);
    fireEvent.click(screen.getByRole("button", { name: `split a total entry across ${LABEL}` }));
    const form = screen.getByRole("form", { name: `split a total entry across ${LABEL}` });
    type(form, "total entry, per contract", "6.4x");
    fireEvent.click(within(form).getByRole("button", { name: "save the split" }));
    expect(within(form).getByRole("alert").textContent).toBe("the total entry is not a number");
    expect(sent).toEqual([]);
  });

  it("cancels on Escape, and the Escape goes no further", () => {
    controls(CONDOR);
    const open = screen.getByRole("button", { name: `split a total entry across ${LABEL}` });
    fireEvent.click(open);
    const outside = vi.fn((e: KeyboardEvent) => e.defaultPrevented);
    document.addEventListener("keydown", outside);
    fireEvent.keyDown(screen.getByLabelText("total entry, per contract"), { key: "Escape" });
    document.removeEventListener("keydown", outside);
    expect(screen.queryByRole("form")).toBeNull();
    expect(document.activeElement).toBe(open);
    expect(outside.mock.results.filter((r) => r.value !== true)).toEqual([]);
  });
});

describe("recording a holding of a watched contract", () => {
  const LABEL = "261231 8000C delta";

  it("is offered on a watched contract, and not on a spread or a held contract", () => {
    controls(LONE);
    expect(screen.getByRole("button", { name: `I hold ${LABEL}` })).toBeTruthy();
    cleanup();
    controls(SPREAD);
    expect(screen.queryByRole("button", { name: /^I hold/ })).toBeNull();
    cleanup();
    controls({ ...LONE, held: true });
    expect(screen.queryByRole("button", { name: /^I hold/ })).toBeNull();
  });

  it("posts the holding with this rule as it stands, saying first that it replaces the watch rule", async () => {
    const { sent, value } = controls(LONE);
    fireEvent.click(screen.getByRole("button", { name: `I hold ${LABEL}` }));
    const form = screen.getByRole("form", { name: `record a holding of ${LABEL}` });
    expect(within(form).getByTestId("hold-replaces").textContent)
      .toBe("Replaces the watch rule 8000 call |Δ| ≥ 0.10 with the holding's own, the same rule, linked to it: "
        + "its alarm carries over, so a ringing rule does not say it crossed again.");
    expect(within(form).getByTestId("hold-links").textContent).toBe("No other Monitor is linked to it.");
    expect((within(form).getByLabelText("name") as HTMLInputElement).value).toBe("1231_C8000");
    expect((within(form).getByLabelText("opened") as HTMLInputElement).value).toBe("2026-11-10");
    fireEvent.change(within(form).getByLabelText("side"), { target: { value: "long" } });
    type(form, "entry, per contract", "5.2");
    type(form, "contracts", "2");
    fireEvent.click(within(form).getByRole("button", { name: "Record holding" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(value.hold).toHaveBeenCalledOnce();
    expect(sent[0]).toEqual({
      what: "SPREADS",
      body: {
        strike_date: "2026-12-31",
        spreads: [{
          name: "1231_C8000", held: true, legs: [{ side: "long", option_type: "CALL", strike: 8000 }],
          entry: -5.2, contracts: 2, opened_at: "2026-11-10",
          monitors: [{ option_type: "CALL", strike: 8000, field: "option_delta", threshold: 0.1,
            direction: "above", compare: "abs" }],
        }],
      },
    });
  });

  it("says the entry the way the side signs it", () => {
    controls(LONE);
    fireEvent.click(screen.getByRole("button", { name: `I hold ${LABEL}` }));
    const form = screen.getByRole("form", { name: `record a holding of ${LABEL}` });
    expect(within(form).getByText(/received, per contract/)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("side"), { target: { value: "long" } });
    expect(within(form).getByText(/paid, per contract/)).toBeTruthy();
  });

  it("says a name already taken beside the name, and anything else by the button", async () => {
    let refusal = "position '1231_C8000' already exists";
    controls(LONE, { hold: vi.fn(async () => { throw new Error(refusal); }) });
    fireEvent.click(screen.getByRole("button", { name: `I hold ${LABEL}` }));
    const form = screen.getByRole("form", { name: `record a holding of ${LABEL}` });
    fireEvent.click(within(form).getByRole("button", { name: "Record holding" }));
    let alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe(refusal);
    expect(within(form).getByLabelText("name").closest(".nx-mon-field")!.contains(alert)).toBe(true);

    refusal = "the provider does not know US.SPXW261231C8000000";
    fireEvent.click(within(form).getByRole("button", { name: "Record holding" }));
    await waitFor(() => expect(within(form).getByRole("alert").textContent).toBe(refusal));
    alert = within(form).getByRole("alert");
    expect(within(form).getByLabelText("name").closest(".nx-mon-field")!.contains(alert)).toBe(false);
  });

  it("refuses a minus in the entry beside the entry, and sends nothing", () => {
    const { sent } = controls(LONE);
    fireEvent.click(screen.getByRole("button", { name: `I hold ${LABEL}` }));
    const form = screen.getByRole("form", { name: `record a holding of ${LABEL}` });
    type(form, "entry, per contract", "-1");
    fireEvent.click(within(form).getByRole("button", { name: "Record holding" }));
    const alert = within(form).getByRole("alert");
    expect(alert.textContent).toBe("type the Entry as what was received: the side signs it");
    expect(within(form).getByLabelText("entry, per contract").closest(".nx-mon-field")!.contains(alert)).toBe(true);
    expect(sent).toEqual([]);
  });

  it("takes no second save while the first is on its way", () => {
    let land = () => undefined as void;
    const hold = vi.fn(() => new Promise<Added>((r) => { land = () => r(ADDED); }));
    controls(LONE, { hold });
    fireEvent.click(screen.getByRole("button", { name: `I hold ${LABEL}` }));
    const form = screen.getByRole("form", { name: `record a holding of ${LABEL}` });
    // two submits in one tick — an Enter's key repeat — both before the button is drawn disabled
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    fireEvent.click(within(form).getByRole("button", { name: /^Record|^recording/ }));
    expect(hold).toHaveBeenCalledOnce();
    land();
  });

  it("hides the count under privacy, as the holding's own form does", () => {
    const { monitors, holdings } = splitBook();
    controls(LONE, { book: { monitors, holdings, privacy: true } });
    fireEvent.click(screen.getByRole("button", { name: `I hold ${LABEL}` }));
    expect(screen.getByLabelText("contracts").classList.contains("nx-private")).toBe(true);
  });
});

describe("what recording a holding does to the rest of the book (#336)", () => {
  const LABEL = "261231 8000C delta";
  /** a watched 8000/8050 call spread `cs`, which holds the contract, and a rule on another strike */
  function withSpread() {
    const { monitors, holdings } = splitBook();
    const cs = { ...monitors.find((m) => m.id === "w-dec31")!, id: "m-cs", code: "cs", strike_date: "2026-12-31",
      legs: [{ sign: -1, option_type: "CALL", strike: 8000 }, { sign: 1, option_type: "CALL", strike: 8050 }],
      positions: [], scope: null };
    return { monitors: [...monitors, cs], holdings, privacy: false };
  }

  it("names every rule it replaces and every one it links, and how, before saving", () => {
    controls(LONE, { book: withSpread() });
    fireEvent.click(screen.getByRole("button", { name: `I hold ${LABEL}` }));
    const form = screen.getByRole("form", { name: `record a holding of ${LABEL}` });
    expect(within(form).getByTestId("hold-links").textContent).toBe(
      "Also linked to it, by the service, as it links every rule no holding owns: "
      // a combo naming a contract the new holding does not hold is drawn in the Watchlist (#346);
      // /opt/next shows no rule row's Entry or P&L, so the form claims none
      + "cs spread value — drawn in the Watchlist, with a note of the contracts it shares with it.");
  });

  it("says it cannot tell which rules it takes while the holdings are not read", () => {
    controls(LONE, { book: { ...withSpread(), holdings: null } });
    fireEvent.click(screen.getByRole("button", { name: `I hold ${LABEL}` }));
    expect(screen.getByTestId("hold-links").textContent).toBe(
      "The holdings have not been read, so which other Monitors it takes is the service's to say once it is saved.");
  });

  it("prefills a name no holding on record has, closed ones included", async () => {
    controls(LONE, { holdingNames: vi.fn(async () => ["1231_C8000", "1231_C8000-2"]) });
    fireEvent.click(screen.getByRole("button", { name: `I hold ${LABEL}` }));
    await waitFor(() => expect((screen.getByLabelText("name") as HTMLInputElement).value).toBe("1231_C8000-3"));
  });

  it("keeps a name the owner typed when the names arrive after it", async () => {
    let land = (_: string[]) => undefined as void;
    controls(LONE, { holdingNames: () => new Promise((r) => { land = r; }) });
    fireEvent.click(screen.getByRole("button", { name: `I hold ${LABEL}` }));
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "mine" } });
    await act(async () => { land(["1231_C8000"]); });
    expect((screen.getByLabelText("name") as HTMLInputElement).value).toBe("mine");
  });

  it("cannot be cancelled while the save is on its way, so its refusal is not lost", async () => {
    let refuse = () => undefined as void;
    const hold = vi.fn(() => new Promise<Added>((_, no) => { refuse = () => no(new Error("monitor not found")); }));
    controls(LONE, { hold });
    fireEvent.click(screen.getByRole("button", { name: `I hold ${LABEL}` }));
    const form = screen.getByRole("form", { name: `record a holding of ${LABEL}` });
    fireEvent.click(within(form).getByRole("button", { name: "Record holding" }));
    expect(within(form).getByRole("button", { name: "cancel" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(within(form).getByLabelText("name"), { key: "Escape" });
    expect(screen.queryByRole("form")).not.toBeNull();
    await act(async () => { refuse(); });
    expect(within(form).getByRole("alert").textContent).toBe("monitor not found");
  });

  it("hands the focus back to the rule's edit button when it is still drawn after the save", async () => {
    controls(LONE);
    fireEvent.click(screen.getByRole("button", { name: `I hold ${LABEL}` }));
    fireEvent.click(screen.getByRole("button", { name: "Record holding" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: `edit ${LABEL}` })));
  });
});

describe("a draft against the rule as it was opened", () => {
  it("sends only what was changed, though a poll brought a new name in meanwhile", async () => {
    const a = actions();
    const ui = (e: Entry) => (
      <MonitorActionsContext.Provider value={a.value}>
        <MonitorControls rule={ruleOfEntry(e)} served={e} />
      </MonitorActionsContext.Provider>
    );
    const { rerender } = render(ui(SPREAD));
    const form = await openEditor("1218_P7150 spread value");
    // renamed elsewhere — another tab — and served by the next poll while this editor is open
    rerender(ui({ ...SPREAD, code: "dec-put" }));
    type(form, "threshold", "3");
    fireEvent.click(within(form).getByRole("button", { name: "save" }));
    await waitFor(() => expect(a.sent).toEqual([{ what: "PATCH", id: SPREAD.id, body: { threshold: 3 } }]));
  });
});

describe("the split, guarded", () => {
  const LABEL = "1218_IC spread value";

  it("sends once for two submits in one tick, and cannot be cancelled while it is on its way", () => {
    const totalEntry = vi.fn(() => new Promise<void>(() => undefined));
    controls(CONDOR, { totalEntry });
    fireEvent.click(screen.getByRole("button", { name: `split a total entry across ${LABEL}` }));
    const form = screen.getByRole("form", { name: `split a total entry across ${LABEL}` });
    type(form, "total entry, per contract", "6.4");
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(totalEntry).toHaveBeenCalledOnce();
    expect(within(form).getByRole("button", { name: "cancel" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(within(form).getByLabelText("total entry, per contract"), { key: "Escape" });
    expect(screen.queryByRole("form")).not.toBeNull();
  });

  it("says when the holdings are held in different numbers", () => {
    const { monitors, holdings } = splitBook();
    controls(CONDOR, { book: { monitors, holdings: holdings.map((h) => h.id === "h-puts" ? { ...h, contracts: 2 } : h),
      privacy: true } });
    fireEvent.click(screen.getByRole("button", { name: `split a total entry across ${LABEL}` }));
    expect(screen.getByTestId("split-counts").textContent).toBe("These holdings are held in different numbers: "
      + "the total is per contract, and the service adds their Entries as they are, whatever the count.");
  });
});

describe("from both arrangements", () => {
  function book(over: Partial<BookProps> = {}): BookProps {
    const { quotes, monitors, holdings } = splitBook();
    return {
      quotes, monitors, holdings, holdingsError: null, holdingsAt: null,
      mode: "live", session: over.mode !== "review", privacy: false, entryStyle: "opportunity", ...over,
    };
  }
  const wrap = (a: MonitorActions, ui: React.ReactNode) =>
    render(<MonitorActionsContext.Provider value={a}>{ui}</MonitorActionsContext.Provider>);

  it("does all three from the desk's inspector", async () => {
    const { value, sent } = actions();
    wrap(value, <DeskBook {...book()} />);
    fireEvent.click(screen.getByRole("button", { name: "1218_P6400" }));
    let panel = screen.getByRole("complementary", { name: /^inspector/ });
    fireEvent.click(within(panel).getByRole("button", { name: "split a total entry across 1218_IC spread value" }));
    fireEvent.change(within(panel).getByLabelText("total entry, per contract"), { target: { value: "6.4" } });
    fireEvent.click(within(panel).getByRole("button", { name: "save the split" }));
    await waitFor(() => expect(sent).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "1218_P7150" }));
    panel = screen.getByRole("complementary", { name: /^inspector/ });
    fireEvent.click(within(panel).getByRole("button", { name: "edit 1218_P7150 spread value" }));
    fireEvent.change(within(panel).getByLabelText("name"), { target: { value: "dec-put" } });
    fireEvent.click(within(panel).getByRole("button", { name: "save" }));
    await waitFor(() => expect(sent).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "261231 8000C" }));
    panel = screen.getByRole("complementary", { name: /^inspector/ });
    fireEvent.click(within(panel).getByRole("button", { name: "I hold 261231 8000C delta" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Record holding" }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent.map((s) => s.what)).toEqual(["TOTAL", "PATCH", "SPREADS"]);
  });

  it("does all three from the phone's sheet, whose Escape stays inside the form", async () => {
    const { value, sent } = actions();
    wrap(value, <div className="nx"><PhoneBook {...book()} /></div>);
    fireEvent.click(screen.getByRole("button", { name: "details of 1218_P6400" }));
    let sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "split a total entry across 1218_IC spread value" }));
    // Escape cancels the form and leaves the sheet open: its dismissal does not ask if it was handled
    fireEvent.keyDown(within(sheet).getByLabelText("total entry, per contract"), { key: "Escape" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "split a total entry across 1218_IC spread value" }));
    fireEvent.change(within(sheet).getByLabelText("total entry, per contract"), { target: { value: "6.4" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "save the split" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "details of 1218_P7150" }));
    sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "edit 1218_P7150 spread value" }));
    fireEvent.keyDown(within(sheet).getByLabelText("name"), { key: "Escape" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "edit 1218_P7150 spread value" }));
    fireEvent.change(within(sheet).getByLabelText("name"), { target: { value: "dec-put" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "save" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "details of 261231 8000C" }));
    sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "I hold 261231 8000C delta" }));
    fireEvent.keyDown(within(sheet).getByLabelText("entry, per contract"), { key: "Escape" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(within(sheet).queryByRole("form")).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "I hold 261231 8000C delta" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Record holding" }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent.map((s) => s.what)).toEqual(["TOTAL", "PATCH", "SPREADS"]);
  });
});

describe("through the page, against a service that writes", () => {
  it("records the holding, the watch rule replaced by the holding's own, and says so", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T15:00:00Z") });
    onTestFinished(() => { vi.useRealTimers(); });
    const writes = serveRuleEdits();
    render(<Next />);
    fireEvent.click(await screen.findByRole("button", { name: "details of 261231 8000C" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "I hold 261231 8000C delta" }));
    fireEvent.change(within(sheet).getByLabelText("entry, per contract"), { target: { value: "0.8" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Record holding" }));
    await waitFor(() => expect(writes.map((w) => w.what)).toEqual(["POST /spreads"]));
    expect(await screen.findByText("recorded 1231_C8000, replacing 1 watch rule")).toBeTruthy();
    // the holding is in the book, read again
    await screen.findByRole("button", { name: "details of 1231_C8000" });
  });

  it("says in its toast what the service linked to the holding, read back after the save", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T15:00:00Z") });
    onTestFinished(() => { vi.useRealTimers(); });
    serveRuleEdits({}, [CS]);
    render(<Next />);
    fireEvent.click(await screen.findByRole("button", { name: "details of 261231 8000C" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "I hold 261231 8000C delta" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Record holding" }));
    expect(await screen.findByText("recorded 1231_C8000, replacing 1 watch rule; also linked to it: cs spread value"))
      .toBeTruthy();
  });

  it("splits a total entry and the holding's Entry is the service's afterwards", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T15:00:00Z") });
    onTestFinished(() => { vi.useRealTimers(); });
    const writes = serveRuleEdits();
    render(<Next />);
    fireEvent.click(await screen.findByRole("button", { name: "details of 1218_P6400" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "split a total entry across 1218_IC spread value" }));
    fireEvent.change(within(sheet).getByLabelText("total entry, per contract"), { target: { value: "6.4" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "save the split" }));
    await waitFor(() => expect(writes).toEqual([{ what: "POST /monitors/r-condor/total-entry", body: { entry: 6.4 } }]));
    // the sheet's facts are the service's own after the reload
    await waitFor(() => expect(within(sheet).getByText("entry").nextSibling?.textContent).toBe("4.40"));
  });

  it("renames a combo, and the service's new name is the one drawn", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T15:00:00Z") });
    onTestFinished(() => { vi.useRealTimers(); });
    const writes = serveRuleEdits();
    render(<Next />);
    fireEvent.click(await screen.findByRole("button", { name: "details of 1218_P7150" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "edit 1218_P7150 spread value" }));
    fireEvent.change(within(sheet).getByLabelText("name"), { target: { value: "dec-put" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "save" }));
    await waitFor(() => expect(writes).toEqual([{ what: "PATCH /monitors/w-dec18", body: { name: "dec-put" } }]));
    await within(sheet).findByRole("button", { name: "edit dec-put spread value" });
  });
});
