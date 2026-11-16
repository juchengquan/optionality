/** Renaming a combo and splitting a total entry from a rule's controls (#336), and "record as held"
 *  from a watch rule's (#408) — in the desk's inspector and the phone's sheet alike. Behaviour: what is
 *  sent, what is said before and after, and where a refusal is said. That it is VISIBLE, 16px and
 *  44pt on a phone is the browser suites' (`__browser__/NextRuleWrites*.test.tsx`). */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import type { Entry } from "../shared/api";
import { SpreadsIn } from "backend/schemas";
import type { BookProps } from "../Book";
import { DeskBook } from "../desk/DeskBook";
import { ruleOfEntry, type Rule } from "../edit";
import { MonitorActionsContext, MonitorControls, type MonitorActions } from "../MonitorEdit";
import { Next } from "../Next";
import { PhoneBook } from "../phone/PhoneBook";
import { QUOTES } from "../testing/ownerBook";
import { CONDOR, CS, serveRuleEdits, splitBook } from "../testing/ruleEdits";

afterEach(cleanup);

const quote = (id: string) => QUOTES.find((q) => q.id === id)!;
const SPREAD = quote("w-dec18");
const LONE = quote("w-lone");
const DELTA = quote("w-dec18-delta");
const HELD = quote("r-calls");

function actions(over: Partial<MonitorActions> = {}) {
  const sent: { what: string; id?: string; body?: unknown }[] = [];
  const { monitors, holdings } = splitBook();
  const value: MonitorActions = {
    patch: vi.fn(async (id: string, body: unknown) => { sent.push({ what: "PATCH", id, body }); }),
    remove: vi.fn(async (id: string) => { sent.push({ what: "DELETE", id }); }),
    totalEntry: vi.fn(async (id: string, entry: number) => { sent.push({ what: "TOTAL", id, body: { entry } }); }),
    recordAsHeld: vi.fn((rule: Rule) => { sent.push({ what: "RECORD", id: rule.id }); }),
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
    const form = await openEditor("1218_P7150 value");
    const box = within(form).getByLabelText("name") as HTMLInputElement;
    expect(box.value).toBe("1218_P7150");
    type(form, "name", "dec-put-spread");
    fireEvent.click(within(form).getByRole("button", { name: "save" }));
    await waitFor(() => expect(sent).toEqual([{ what: "PATCH", id: SPREAD.id, body: { name: "dec-put-spread" } }]));
  });

  it("has no name box for a single contract", async () => {
    controls(DELTA);
    const form = await openEditor("261218 7150P Δ");
    expect(within(form).queryByLabelText("name")).toBeNull();
  });

  it("says a name already taken beside the name, in the service's words", async () => {
    const refusal = "monitor for (1231_C7600, mid_price) already exists";
    controls(SPREAD, { patch: vi.fn(async () => { throw new Error(refusal); }) });
    const form = await openEditor("1218_P7150 value");
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
    const form = await openEditor("1218_P7150 value");
    type(form, "name", " ");
    fireEvent.click(within(form).getByRole("button", { name: "save" }));
    const alert = within(form).getByRole("alert");
    expect(alert.textContent).toBe("type a name");
    expect(within(form).getByLabelText("name").closest(".nx-mon-field")!.contains(alert)).toBe(true);
    expect(sent).toEqual([]);
  });

  it("says, for a held spread, that its holding keeps the name it was recorded with", async () => {
    controls(HELD);
    const form = await openEditor("1218_C7300 value");
    expect(form.textContent).toContain(
      "Renames this rule only: the holding 1218_C7300 keeps its name — the service never renames a holding.");
  });
});

describe("splitting a total entry", () => {
  const LABEL = "1218_IC value";

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

describe("Record as held (#408)", () => {
  it("is offered on a watched spread and a watched contract, and not on a rule on something held", () => {
    controls(LONE);
    expect(screen.getByRole("button", { name: "record 261231 8000C Δ as held" }).textContent).toBe("record as held");
    cleanup();
    controls(SPREAD);
    expect(screen.getByRole("button", { name: "record 1218_P7150 value as held" })).toBeTruthy();
    cleanup();
    controls({ ...LONE, held: true });
    expect(screen.queryByRole("button", { name: /as held$/ })).toBeNull();
    cleanup();
    controls(HELD);
    expect(screen.queryByRole("button", { name: /as held$/ })).toBeNull();
  });

  it("retires #336's in-place form: the press hands the rule to the page, which opens the add form", () => {
    const { sent, value } = controls(SPREAD);
    expect(screen.queryByRole("button", { name: /^I hold/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "record 1218_P7150 value as held" }));
    expect(value.recordAsHeld).toHaveBeenCalledOnce();
    expect(sent).toEqual([{ what: "RECORD", id: SPREAD.id }]);
    expect(screen.queryByRole("form")).toBeNull();
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
    const form = await openEditor("1218_P7150 value");
    // renamed elsewhere — another tab — and served by the next poll while this editor is open
    rerender(ui({ ...SPREAD, code: "dec-put" }));
    type(form, "threshold", "3");
    fireEvent.click(within(form).getByRole("button", { name: "save" }));
    await waitFor(() => expect(a.sent).toEqual([{ what: "PATCH", id: SPREAD.id, body: { threshold: 3 } }]));
  });
});

describe("the split, guarded", () => {
  const LABEL = "1218_IC value";

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
      session: true, privacy: false, entryStyle: "opportunity", ...over,
    };
  }
  const wrap = (a: MonitorActions, ui: React.ReactNode) =>
    render(<MonitorActionsContext.Provider value={a}>{ui}</MonitorActionsContext.Provider>);

  it("does all three from the desk's inspector", async () => {
    const { value, sent } = actions();
    wrap(value, <DeskBook {...book()} />);
    fireEvent.click(screen.getByRole("button", { name: "1218_P6400" }));
    let panel = screen.getByRole("complementary", { name: /^inspector/ });
    fireEvent.click(within(panel).getByRole("button", { name: "split a total entry across 1218_IC value" }));
    fireEvent.change(within(panel).getByLabelText("total entry, per contract"), { target: { value: "6.4" } });
    fireEvent.click(within(panel).getByRole("button", { name: "save the split" }));
    await waitFor(() => expect(sent).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "1218_P7150" }));
    panel = screen.getByRole("complementary", { name: /^inspector/ });
    fireEvent.click(within(panel).getByRole("button", { name: "edit 1218_P7150 value" }));
    fireEvent.change(within(panel).getByLabelText("name"), { target: { value: "dec-put" } });
    fireEvent.click(within(panel).getByRole("button", { name: "save" }));
    await waitFor(() => expect(sent).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "261231 8000C" }));
    panel = screen.getByRole("complementary", { name: /^inspector/ });
    fireEvent.click(within(panel).getByRole("button", { name: "record 261231 8000C Δ as held" }));
    expect(sent.map((s) => s.what)).toEqual(["TOTAL", "PATCH", "RECORD"]);
  });

  it("does all three from the phone's sheet, whose Escape stays inside the form", async () => {
    const { value, sent } = actions();
    wrap(value, <div className="nx"><PhoneBook {...book()} /></div>);
    fireEvent.click(screen.getByRole("button", { name: "details of 1218_P6400" }));
    let sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "split a total entry across 1218_IC value" }));
    // Escape cancels the form and leaves the sheet open: its dismissal does not ask if it was handled
    fireEvent.keyDown(within(sheet).getByLabelText("total entry, per contract"), { key: "Escape" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "split a total entry across 1218_IC value" }));
    fireEvent.change(within(sheet).getByLabelText("total entry, per contract"), { target: { value: "6.4" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "save the split" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "details of 1218_P7150" }));
    sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "edit 1218_P7150 value" }));
    fireEvent.keyDown(within(sheet).getByLabelText("name"), { key: "Escape" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "edit 1218_P7150 value" }));
    fireEvent.change(within(sheet).getByLabelText("name"), { target: { value: "dec-put" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "save" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "details of 261231 8000C" }));
    sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "record 261231 8000C Δ as held" }));
    expect(sent.map((s) => s.what)).toEqual(["TOTAL", "PATCH", "RECORD"]);
  });
});

describe("through the page, against a service that writes", () => {
  const NOW = () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T15:00:00Z") });
    onTestFinished(() => { vi.useRealTimers(); });
  };
  const value = (root: HTMLElement, label: string) => (within(root).getByLabelText(label) as HTMLInputElement).value;
  const addSheet = () => screen.findByRole("dialog", { name: "Add a spread or contract" });

  it("records a watched spread from the phone's sheet: the add form over it, prefilled, its watch rules replaced", async () => {
    NOW();
    const writes = serveRuleEdits();
    render(<Next />);
    fireEvent.click(await screen.findByRole("button", { name: "details of 1218_P7150" }));
    const detail = await screen.findByRole("dialog");
    fireEvent.click(within(detail).getByRole("button", { name: "record 1218_P7150 value as held" }));
    const sheet = await addSheet();
    // over the detail, which stays beneath it
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(2);
    const form = within(sheet).getByRole("form", { name: "add a spread" });
    expect(within(form).getByRole("button", { name: "I hold it" }).getAttribute("aria-pressed")).toBe("true");
    expect([value(form, "expiry"), value(form, "opened"), value(form, "spread 1 name")])
      .toEqual(["2026-12-18", "2026-11-10", "1218_P7150"]);
    expect([value(form, "spread 1, leg 1 strike"), value(form, "spread 1, leg 2 strike")]).toEqual(["7150", "7100"]);
    expect(within(form).getByRole("button", { name: "spread 1, leg 1 side: short — flip" })).toBeTruthy();
    expect(within(form).getByRole("button", { name: "spread 1, leg 2 side: long — flip" })).toBeTruthy();
    expect([value(form, "spread 1, leg 1 quantity"), value(form, "spread 1, leg 2 quantity")]).toEqual(["1", "1"]);
    // the watch rules it will replace, named before the save
    expect(within(form).getByText("Replaces the watch rules: 1218_P7150 |value| ≥ 6.00, 7150 put |Δ| ≥ 0.20")).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("spread 1 entry"), { target: { value: "2.40" } });
    fireEvent.change(within(form).getByLabelText("spread 1 contracts"), { target: { value: "3" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record holding + 2 rules" }));
    await waitFor(() => expect(writes.map((w) => w.what)).toEqual(["POST /spreads"]));
    expect(SpreadsIn.safeParse(writes[0]!.body).success).toBe(true);
    expect(writes[0]!.body).toEqual({
      strike_date: "2026-12-18",
      spreads: [{
        name: "1218_P7150", held: true, entry: 2.4, contracts: 3, opened_at: "2026-11-10",
        legs: [{ side: "short", option_type: "PUT", strike: 7150 }, { side: "long", option_type: "PUT", strike: 7100 }],
        monitors: [{ threshold: -4.8, direction: "below", compare: "signed" }, { option_type: "PUT", strike: 7150, threshold: 0.3 }],
      }],
    });
    expect(await screen.findByText("added 1 holding and 2 rules, replacing 2 watch rules")).toBeTruthy();
    // both sheets gone — the watch rule the detail showed is gone with it — and the holding in the book
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a spread or contract" })).toBeNull());
    await waitFor(() => expect(detail.isConnected).toBe(false));
    await screen.findByRole("button", { name: "details of 1218_P7150" });
    expect(screen.queryByRole("button", { name: /record 1218_P7150 value as held/ })).toBeNull();
  });

  it("closes only the add form on Back or Cancel, the detail it was opened from still there", async () => {
    NOW();
    serveRuleEdits();
    render(<Next />);
    fireEvent.click(await screen.findByRole("button", { name: "details of 1218_P7150" }));
    const detail = await screen.findByRole("dialog");
    fireEvent.click(within(detail).getByRole("button", { name: "record 1218_P7150 value as held" }));
    await addSheet();
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a spread or contract" })).toBeNull());
    expect(screen.getByRole("dialog")).toBe(detail);
    fireEvent.click(within(detail).getByRole("button", { name: "record 1218_P7150 value as held" }));
    fireEvent.click(within(await addSheet()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a spread or contract" })).toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole("dialog")).toBe(detail);
    // and the next Back closes the detail, as it did before
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("records a watched contract from the phone's sheet, carrying its rule, named apart from the holdings on record", async () => {
    NOW();
    const writes = serveRuleEdits();
    render(<Next />);
    fireEvent.click(await screen.findByRole("button", { name: "details of 261231 8000C" }));
    const detail = await screen.findByRole("dialog");
    fireEvent.click(within(detail).getByRole("button", { name: "record 261231 8000C Δ as held" }));
    const form = within(await addSheet()).getByRole("form", { name: "add one contract" });
    expect(within(form).getByRole("button", { name: "I hold it" }).getAttribute("aria-pressed")).toBe("true");
    expect([value(form, "expiry"), value(form, "strike"), value(form, "what it watches"), value(form, "compare"),
      value(form, "threshold"), value(form, "name"), value(form, "opened")])
      .toEqual(["2026-12-31", "8000", "option_delta", "abs", "0.1", "1231_C8000", "2026-11-10"]);
    expect(within(form).getByRole("button", { name: "CALL" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(within(form).getByRole("group", { name: "side" })).getByRole("button", { name: "short" })
      .getAttribute("aria-pressed")).toBe("true");
    expect(within(form).getByText("Replaces the watch rules: 8000 call |Δ| ≥ 0.10")).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("entry"), { target: { value: "0.8" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record holding + 1 rule" }));
    await waitFor(() => expect(writes.map((w) => w.what)).toEqual(["POST /spreads"]));
    expect(writes[0]!.body).toEqual({
      strike_date: "2026-12-31",
      spreads: [{
        name: "1231_C8000", held: true, legs: [{ side: "short", option_type: "CALL", strike: 8000 }],
        entry: 0.8, contracts: 1, opened_at: "2026-11-10",
        monitors: [{ option_type: "CALL", strike: 8000, field: "option_delta", threshold: 0.1, direction: "above", compare: "abs" }],
      }],
    });
    expect(await screen.findByText("added 1 holding and 1 rule, replacing 1 watch rule")).toBeTruthy();
    await screen.findByRole("button", { name: "details of 1231_C8000" });
  });

  it("records a watched ratio from the desk's inspector: its signs and quantities kept, the Entry focused", async () => {
    NOW();
    document.cookie = "ui_arrangement=desk;path=/";
    onTestFinished(() => { document.cookie = "ui_arrangement=;path=/;max-age=0"; });
    const RATIO = {
      ...CS, id: "m-ratio", code: "1231_+C7700_-2C7750",
      legs: [{ sign: 1, option_type: "CALL", strike: 7700 }, { sign: -1, option_type: "CALL", strike: 7750, qty: 2 }],
    } as Entry;
    const writes = serveRuleEdits({}, [RATIO]);
    render(<Next />);
    fireEvent.click(await screen.findByRole("button", { name: "1231_+C7700_-2C7750" }));
    const panel = screen.getByRole("complementary", { name: /^inspector/ });
    fireEvent.click(within(panel).getByRole("button", { name: "record 1231_+C7700_-2C7750 value as held" }));
    const add = await screen.findByRole("dialog", { name: "Add a spread or contract" });
    const form = within(add).getByRole("form", { name: "add a spread" });
    await waitFor(() => expect(document.activeElement).toBe(within(form).getByLabelText("spread 1 entry")));
    expect(within(form).getByRole("button", { name: "spread 1, leg 1 side: long — flip" })).toBeTruthy();
    expect(within(form).getByRole("button", { name: "spread 1, leg 2 side: short — flip" })).toBeTruthy();
    expect([value(form, "spread 1, leg 1 quantity"), value(form, "spread 1, leg 2 quantity")]).toEqual(["1", "2"]);
    expect(value(form, "spread 1 name")).toBe("1231_+C7700_-2C7750");
    fireEvent.change(within(form).getByLabelText("spread 1 entry"), { target: { value: "0.50" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record holding + 2 rules" }));
    await waitFor(() => expect(writes.map((w) => w.what)).toEqual(["POST /spreads"]));
    expect(writes[0]!.body).toEqual({
      strike_date: "2026-12-31",
      spreads: [{
        name: "1231_+C7700_-2C7750", held: true, entry: 0.5, contracts: 1, opened_at: "2026-11-10",
        legs: [{ side: "long", option_type: "CALL", strike: 7700 }, { side: "short", option_type: "CALL", strike: 7750, qty: 2 }],
        monitors: [{ threshold: -1, direction: "below", compare: "signed" }, { option_type: "CALL", strike: 7750, threshold: 0.3 }],
      }],
    });
    expect(await screen.findByText("added 1 holding and 2 rules, replacing 1 watch rule")).toBeTruthy();
  });

  it("starts a watched debit's stop on at ≤ and empty, and says so in words before sending anything (owner, #408)", async () => {
    NOW();
    document.cookie = "ui_arrangement=desk;path=/";
    onTestFinished(() => { document.cookie = "ui_arrangement=;path=/;max-age=0"; });
    const writes = serveRuleEdits();
    render(<Next />);
    fireEvent.click(await screen.findByRole("button", { name: "1218_P7150" }));
    const panel = screen.getByRole("complementary", { name: /^inspector/ });
    fireEvent.click(within(panel).getByRole("button", { name: "record 1218_P7150 value as held" }));
    const form = within(await screen.findByRole("dialog", { name: "Add a spread or contract" }))
      .getByRole("form", { name: "add a spread" });
    // bought, as the owner says by typing a debit: the stop is a fall in its value
    fireEvent.change(within(form).getByLabelText("spread 1 entry"), { target: { value: "-2.40" } });
    expect(within(form).getByRole("switch", { name: "spread 1 value rule" }).getAttribute("aria-checked")).toBe("true");
    expect(within(within(form).getByRole("group", { name: "spread 1 value direction" })).getByRole("button", { name: "≤ at or below" })
      .getAttribute("aria-pressed")).toBe("true");
    expect(value(form, "spread 1 value threshold")).toBe("");
    expect(within(form).getByText(/^Replaces the watch rules: 1218_P7150 \|value\| ≥ 6\.00/)).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: /^Record holding/ }));
    expect(within(form).getByRole("alert").textContent).toBe("spread 1: type the value its rule watches for");
    expect(writes).toEqual([]);
  });

  it("names the rules a held spread takes over besides, before the save, and reads them back after (#408)", async () => {
    NOW();
    // a Θ rule on the watched spread: on nothing the save makes, so the new holding takes it over
    const THETA = { ...SPREAD, id: "w-theta", field: "option_theta", threshold: 0.5 } as Entry;
    const writes = serveRuleEdits({}, [THETA]);
    render(<Next />);
    // two cards share the name: the value rule's is the one before the Θ's
    fireEvent.click((await screen.findAllByRole("button", { name: "details of 1218_P7150" }))[0]!);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "record 1218_P7150 value as held" }));
    const form = within(await addSheet()).getByRole("form", { name: "add a spread" });
    expect(within(form).getByText("Replaces the watch rules: 1218_P7150 |value| ≥ 6.00, 7150 put |Δ| ≥ 0.20")).toBeTruthy();
    expect(within(form).getByText(
      "Also links to this holding: 1218_P7150 |Θ| ≥ 0.50 — kept as they are; edit or delete them after.")).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("spread 1 entry"), { target: { value: "2.40" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record holding + 2 rules" }));
    await waitFor(() => expect(writes.map((w) => w.what)).toEqual(["POST /spreads"]));
    expect(await screen.findByText(
      "added 1 holding and 2 rules, replacing 2 watch rules; also linked to it: 1218_P7150 |Θ| ≥ 0.50")).toBeTruthy();
  });

  it("names a watched spread holding the contract as taken over by a held contract, and reads it back", async () => {
    NOW();
    serveRuleEdits({}, [CS]);
    render(<Next />);
    fireEvent.click(await screen.findByRole("button", { name: "details of 261231 8000C" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "record 261231 8000C Δ as held" }));
    const form = within(await addSheet()).getByRole("form", { name: "add one contract" });
    expect(within(form).getByText(/^Also links to this holding: cs \|value\| ≥ /)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("entry"), { target: { value: "0.8" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record holding + 1 rule" }));
    expect(await screen.findByText(/^added 1 holding and 1 rule, replacing 1 watch rule; also linked to it: cs \|value\| ≥ /))
      .toBeTruthy();
  });

  it("opens a watched spread from its row's own legs where /monitors has not been read", async () => {
    NOW();
    const writes = serveRuleEdits({}, [], { monitorsFail: true });
    render(<Next />);
    fireEvent.click(await screen.findByRole("button", { name: "details of 1218_P7150" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "record 1218_P7150 value as held" }));
    const form = within(await addSheet()).getByRole("form", { name: "add a spread" });
    expect([value(form, "spread 1, leg 1 strike"), value(form, "spread 1, leg 2 strike"), value(form, "spread 1 name")])
      .toEqual(["7150", "7100", "1218_P7150"]);
    expect(within(form).getByRole("button", { name: "spread 1, leg 1 side: short — flip" })).toBeTruthy();
    expect(writes).toEqual([]);
  });

  it("names a watched contract's holding apart from a closed one of the same name", async () => {
    NOW();
    const writes = serveRuleEdits({}, [], { names: ["1231_C8000"] });
    render(<Next />);
    fireEvent.click(await screen.findByRole("button", { name: "details of 261231 8000C" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "record 261231 8000C Δ as held" }));
    const form = within(await addSheet()).getByRole("form", { name: "add one contract" });
    expect(value(form, "name")).toBe("1231_C8000-2");
    fireEvent.change(within(form).getByLabelText("entry"), { target: { value: "0.8" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record holding + 1 rule" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect((writes[0]!.body as { spreads: { name: string }[] }).spreads[0]!.name).toBe("1231_C8000-2");
  });

  it("says before saving that a watched spread's name is a holding's already, and what renaming does", async () => {
    NOW();
    serveRuleEdits({}, [], { names: ["1218_P7150"] });
    render(<Next />);
    fireEvent.click(await screen.findByRole("button", { name: "details of 1218_P7150" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "record 1218_P7150 value as held" }));
    const form = within(await addSheet()).getByRole("form", { name: "add a spread" });
    expect(within(form).getByRole("status", { name: "spread 1's name" }).textContent).toBe(
      "A holding named 1218_P7150 is already on record, closed ones included, so saving under this name is refused. "
      + "Rename it in the name box: the watch rule 1218_P7150 is then kept, linked to the new holding, rather than replaced.");
    fireEvent.change(within(form).getByLabelText("spread 1 name"), { target: { value: "dec-put" } });
    expect(within(form).queryByRole("status", { name: "spread 1's name" })).toBeNull();
    // renamed, the value rule is no longer replaced: it is taken over, as it is
    expect(within(form).getByText("Replaces the watch rules: 7150 put |Δ| ≥ 0.20")).toBeTruthy();
    expect(within(form).getByText(
      "Also links to this holding: 1218_P7150 |value| ≥ 6.00 — kept as they are; edit or delete them after.")).toBeTruthy();
  });

  it("hands the focus back to the desk's Record as held when the panel it opened is cancelled", async () => {
    NOW();
    document.cookie = "ui_arrangement=desk;path=/";
    onTestFinished(() => { document.cookie = "ui_arrangement=;path=/;max-age=0"; });
    serveRuleEdits();
    render(<Next />);
    fireEvent.click(await screen.findByRole("button", { name: "1218_P7150" }));
    const record = within(screen.getByRole("complementary", { name: /^inspector/ }))
      .getByRole("button", { name: "record 1218_P7150 value as held" });
    fireEvent.click(record);
    const add = await screen.findByRole("dialog", { name: "Add a spread or contract" });
    fireEvent.click(within(add).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a spread or contract" })).toBeNull());
    expect(document.activeElement).toBe(record);
    // and by Escape
    fireEvent.click(record);
    const again = await screen.findByRole("dialog", { name: "Add a spread or contract" });
    fireEvent.keyDown(within(again).getByLabelText("spread 1 entry"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a spread or contract" })).toBeNull());
    expect(document.activeElement).toBe(record);
  });

  it("splits a total entry and the holding's Entry is the service's afterwards", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T15:00:00Z") });
    onTestFinished(() => { vi.useRealTimers(); });
    const writes = serveRuleEdits();
    render(<Next />);
    fireEvent.click(await screen.findByRole("button", { name: "details of 1218_P6400" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "split a total entry across 1218_IC value" }));
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
    fireEvent.click(within(sheet).getByRole("button", { name: "edit 1218_P7150 value" }));
    fireEvent.change(within(sheet).getByLabelText("name"), { target: { value: "dec-put" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "save" }));
    await waitFor(() => expect(writes).toEqual([{ what: "PATCH /monitors/w-dec18", body: { name: "dec-put" } }]));
    await within(sheet).findByRole("button", { name: "edit dec-put value" });
  });
});
