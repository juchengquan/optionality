/** Editing a Monitor in place (#292): every field, mute, unmute and delete, from the desk's
 *  inspector and the phone's sheet. Behaviour only — what is sent, what is said and where. That a
 *  refusal is VISIBLE above a sheet, and that the phone's boxes are 16px, is measured by the browser
 *  suite (`NextEdit.test.tsx` and `NextEdit.iphone.test.tsx` under `__browser__/`). */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { MonitorPatch } from "backend/schemas";
import type { Entry, Monitor } from "../shared/api";
import type { BookProps } from "../next/Book";
import { DeskBook } from "../next/desk/DeskBook";
import { MonitorActionsContext, MonitorControls, type MonitorActions } from "../next/MonitorEdit";
import {
  deletesOn, draftOf, draftWords, patchOf, ruleOfEntry, ruleOfMonitor, spotOf,
} from "../next/edit";
import { sentence } from "../next/needs";
import { Next } from "../next/Next";
import { serveEditing } from "../testing/editBook";
import { until } from "../testing/until";
import { PhoneBook } from "../next/phone/PhoneBook";
import { HOLDINGS, MONITORS, QUOTES } from "../testing/ownerBook";

afterEach(cleanup);

const quote = (id: string) => QUOTES.find((q) => q.id === id)!;
const monitor = (id: string) => MONITORS.find((m) => m.id === id)!;
/** a single leg's delta rule, under its spread on the watchlist */
const DELTA = quote("w-dec18-delta");
/** a combo's value rule */
const SPREAD = quote("w-dec18");

/** Actions that answer as the service would: `refuse` names a message to throw for a patch. */
function actions(over: Partial<MonitorActions> = {}) {
  const sent: { what: string; id: string; body?: unknown }[] = [];
  const value: MonitorActions = {
    patch: vi.fn(async (id: string, body: unknown) => { sent.push({ what: "PATCH", id, body }); }),
    remove: vi.fn(async (id: string) => { sent.push({ what: "DELETE", id }); }),
    retentionDays: 7,
    // the evening of 10 November in New York, already the 11th in UTC: every rule in the owner's
    // book is in the future, the expired one excepted
    now: () => new Date("2026-11-11T01:30:00Z"),
    ...over,
  };
  return { value, sent };
}

function controls(subject: { entry?: Entry; monitor?: Monitor }, over: Partial<MonitorActions> = {}) {
  const a = actions(over);
  const rule = subject.entry ? ruleOfEntry(subject.entry) : ruleOfMonitor(subject.monitor!);
  render(
    <MonitorActionsContext.Provider value={a.value}>
      <MonitorControls rule={rule} served={subject.entry ?? null} />
    </MonitorActionsContext.Provider>,
  );
  return a;
}

const choose = (form: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(form).getByLabelText(label), { target: { value } });

async function openEditor(label: string) {
  fireEvent.click(screen.getByRole("button", { name: `edit ${label}` }));
  return screen.findByRole("form", { name: `editing ${label}` });
}

describe("the draft and what it sends", () => {
  it("sends only what changed, in a body the route accepts", () => {
    const rule = ruleOfEntry(DELTA);
    const draft = { ...draftOf(rule), direction: "below", threshold: "0.25" };
    const out = patchOf(rule, draft);
    expect(out).toEqual({ body: { direction: "below", threshold: 0.25 } });
    expect(MonitorPatch.safeParse((out as { body: object }).body).success).toBe(true);
  });

  it("sends nothing when nothing changed", () => {
    const rule = ruleOfEntry(DELTA);
    expect(patchOf(rule, draftOf(rule))).toEqual({ body: null });
  });

  it("says a threshold that is not a number beside the threshold, before asking anything", () => {
    const rule = ruleOfEntry(DELTA);
    expect(patchOf(rule, { ...draftOf(rule), threshold: "0.2x" }))
      .toEqual({ error: "the threshold is not a number", at: "threshold" });
    expect(patchOf(rule, { ...draftOf(rule), threshold: " " }))
      .toEqual({ error: "type a threshold", at: "threshold" });
  });

  it("takes a threshold only as a plain decimal, as the owner would write it", () => {
    const rule = ruleOfEntry(DELTA);
    const at = (t: string) => patchOf(rule, { ...draftOf(rule), threshold: t });
    // Number() reads all of these, and the first two are not what anybody meant
    for (const t of ["0x10", "1e-2", "Infinity", "1_000", "--1", "0.2.1"]) {
      expect([t, at(t)]).toEqual([t, { error: "the threshold is not a number", at: "threshold" }]);
    }
    for (const [t, n] of [["0.25", 0.25], ["-1.5", -1.5], ["+3", 3], [".5", 0.5], ["4.", 4], [" 0.3 ", 0.3]] as const) {
      expect([t, at(t)]).toEqual([t, { body: { threshold: n } }]);
    }
  });

  it("files each of the service's refusals beside the field it is about", () => {
    expect(spotOf("signed threshold cannot be 0; use e.g. ±0.01")).toBe("threshold");
    expect(spotOf("threshold must be positive when compare='abs'")).toBe("threshold");
    expect(spotOf("combos cannot watch option_implied_volatility: it is not additive across legs")).toBe("field");
    expect(spotOf("monitor for (US.SPXW261218P7150000, mid_price) already exists")).toBe("field");
    expect(spotOf("monitor not found")).toBe("form");
  });

  it("words the draft as the served sentence words the rule, so the two read alike", () => {
    const rule = ruleOfEntry(SPREAD);
    // the rule part of the served sentence is exactly the draft's when nothing has changed
    expect(sentence(SPREAD).startsWith(`${draftWords(rule, draftOf(rule))} — `)).toBe(true);
    expect(draftWords(rule, { ...draftOf(rule), compare: "signed", direction: "below", threshold: "-1" }))
      .toBe("spread value ≤ -1");
  });

  it("says the day an expired rule is deleted: the first sweep after its retention", () => {
    // the sweep removes it once its expiry is before today less the window (`expiryVerdict`)
    expect(deletesOn("2026-11-06", 7)).toBe("2026-11-14");
    expect(deletesOn("2026-12-28", 7)).toBe("2027-01-05");
  });
});

describe("editing a rule in place", () => {
  it("edits every field and sends the change, the threshold as a number", async () => {
    const { sent } = controls({ entry: DELTA });
    const label = "261218 7150P delta";
    const form = await openEditor(label);
    choose(form, "what it watches", "mid_price");
    choose(form, "direction", "below");
    choose(form, "compare", "signed");
    choose(form, "threshold", "-1.5");
    fireEvent.click(within(form).getByRole("button", { name: "save" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      what: "PATCH", id: DELTA.id,
      body: { field: "mid_price", direction: "below", compare: "signed", threshold: -1.5 },
    });
    // saved: the form closes, and the sentence beside the rule is the service's again
    await waitFor(() => expect(screen.queryByRole("form", { name: `editing ${label}` })).toBeNull());
  });

  it("follows the draft as it is typed, and keeps the distance the service's", async () => {
    controls({ entry: DELTA });
    const form = await openEditor("261218 7150P delta");
    const draft = within(form).getByTestId("draft");
    expect(draft.textContent).toBe("|delta| ≥ 0.2");
    choose(form, "threshold", "0.3");
    expect(draft.textContent).toBe("|delta| ≥ 0.3");
    choose(form, "compare", "signed");
    choose(form, "direction", "below");
    expect(draft.textContent).toBe("delta ≤ 0.3");
    // the figure and how far it is are the SERVED row's, said as such until it is saved
    expect(within(form).getByTestId("served").textContent).toBe(`as saved: ${sentence(DELTA)}`);
  });

  it("opens on the rule as saved, not on a draft that was cancelled", async () => {
    controls({ entry: DELTA });
    let form = await openEditor("261218 7150P delta");
    choose(form, "what it watches", "mid_price");
    choose(form, "direction", "below");
    choose(form, "compare", "signed");
    choose(form, "threshold", "9");
    fireEvent.click(within(form).getByRole("button", { name: "cancel" }));
    form = await openEditor("261218 7150P delta");
    const values = ["what it watches", "direction", "compare", "threshold"]
      .map((l) => (within(form).getByLabelText(l) as HTMLInputElement).value);
    expect(values).toEqual(["option_delta", "above", "abs", "0.2"]);
  });

  it("opens on the rule as a later poll served it, after it changed while the editor was shut", async () => {
    const a = actions();
    const ui = (e: Entry) => (
      <MonitorActionsContext.Provider value={a.value}>
        <MonitorControls rule={ruleOfEntry(e)} served={e} />
      </MonitorActionsContext.Provider>
    );
    const { rerender } = render(ui(DELTA));
    let form = await openEditor("261218 7150P delta");
    fireEvent.click(within(form).getByRole("button", { name: "cancel" }));
    // changed elsewhere — another tab, the bot's /threshold — and served by the next poll
    rerender(ui({ ...DELTA, threshold: 0.35, direction: "below" }));
    form = await openEditor("261218 7150P delta");
    expect((within(form).getByLabelText("threshold") as HTMLInputElement).value).toBe("0.35");
    expect((within(form).getByLabelText("direction") as HTMLSelectElement).value).toBe("below");
  });

  it("offers a combo no IV, which does not add up across its legs", async () => {
    controls({ entry: SPREAD });
    const form = await openEditor("1218_P7150 spread value");
    const options = [...within(form).getByLabelText<HTMLSelectElement>("what it watches").options].map((o) => o.value);
    expect(options).not.toContain("option_implied_volatility");
    expect(options).toContain("mid_price");
  });

  it("says a signed threshold of 0 beside the threshold, in the service's words, and keeps the draft", async () => {
    const refusal = "signed threshold cannot be 0; use e.g. ±0.01";
    controls({ entry: DELTA }, { patch: vi.fn(async () => { throw new Error(refusal); }) });
    const form = await openEditor("261218 7150P delta");
    choose(form, "compare", "signed");
    choose(form, "threshold", "0");
    fireEvent.click(within(form).getByRole("button", { name: "save" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe(refusal);
    const box = within(form).getByLabelText("threshold");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(box.getAttribute("aria-describedby")).toBe(alert.id);
    // beside it: the message follows the box it is about, inside the same field
    expect(box.closest(".nx-mon-field")!.contains(alert)).toBe(true);
    expect((box as HTMLInputElement).value).toBe("0");
  });

  it("says a field refusal beside what it watches", async () => {
    const refusal = "monitor for (US.SPXW261218P7150000, mid_price) already exists";
    controls({ entry: DELTA }, { patch: vi.fn(async () => { throw new Error(refusal); }) });
    const form = await openEditor("261218 7150P delta");
    choose(form, "what it watches", "mid_price");
    fireEvent.click(within(form).getByRole("button", { name: "save" }));
    const alert = await within(form).findByRole("alert");
    expect(within(form).getByLabelText("what it watches").closest(".nx-mon-field")!.contains(alert)).toBe(true);
  });

  it("asks the service nothing for a threshold that is not a number", async () => {
    const { sent } = controls({ entry: DELTA });
    const form = await openEditor("261218 7150P delta");
    choose(form, "threshold", "0x10");
    fireEvent.click(within(form).getByRole("button", { name: "save" }));
    expect(within(form).getByRole("alert").textContent).toBe("the threshold is not a number");
    expect(sent).toEqual([]);
  });

  it("cancels on Escape, handing the focus back to edit, and Escape goes no further", async () => {
    controls({ entry: DELTA });
    const form = await openEditor("261218 7150P delta");
    expect(document.activeElement).toBe(within(form).getByLabelText("threshold"));
    const outside = vi.fn((e: KeyboardEvent) => e.defaultPrevented);
    document.addEventListener("keydown", outside);
    fireEvent.keyDown(within(form).getByLabelText("threshold"), { key: "Escape" });
    document.removeEventListener("keydown", outside);
    expect(screen.queryByRole("form")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "edit 261218 7150P delta" }));
    // the inspector closes on an Escape nobody handled: this one never reaches it unhandled
    expect(outside.mock.results.filter((r) => r.value !== true)).toEqual([]);
  });
});

describe("mute, unmute and delete", () => {
  it("mutes a rule that is on", async () => {
    const { sent } = controls({ entry: DELTA });
    fireEvent.click(screen.getByRole("button", { name: "mute 261218 7150P delta" }));
    await waitFor(() => expect(sent).toEqual([{ what: "PATCH", id: DELTA.id, body: { enabled: false } }]));
  });

  it("says what unmuting a rule switched off with its holding does", async () => {
    const { sent } = controls({ monitor: { ...monitor("m-muted"), disabled_reason: "holding-closed" } });
    const unmute = screen.getByRole("button", { name: "unmute 261218 8000C delta, no longer held" });
    expect(unmute.textContent).toBe("unmute (no longer held)");
    fireEvent.click(unmute);
    await waitFor(() => expect(sent).toEqual([{ what: "PATCH", id: "m-muted", body: { enabled: true } }]));
  });

  it("unmutes a rule muted by hand", async () => {
    const { sent } = controls({ monitor: monitor("m-muted") });
    fireEvent.click(screen.getByRole("button", { name: "unmute 261218 8000C delta" }));
    await waitFor(() => expect(sent).toEqual([{ what: "PATCH", id: "m-muted", body: { enabled: true } }]));
  });

  it("asks before deleting, and deletes nothing when kept", async () => {
    const { sent } = controls({ entry: DELTA });
    fireEvent.click(screen.getByRole("button", { name: "delete 261218 7150P delta" }));
    const ask = screen.getByRole("group", { name: "delete 261218 7150P delta?" });
    expect(sent).toEqual([]);
    // the safe answer has the focus, so an Enter pressed by habit keeps the rule
    expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "keep it" }));
    fireEvent.click(within(ask).getByRole("button", { name: "keep it" }));
    expect(screen.queryByRole("group", { name: /^delete/ })).toBeNull();
    expect(sent).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "delete 261218 7150P delta" }));
    fireEvent.click(screen.getByRole("button", { name: "delete it" }));
    await waitFor(() => expect(sent).toEqual([{ what: "DELETE", id: DELTA.id }]));
  });

  it("says a refused mute beside the buttons, where it was pressed", async () => {
    controls({ entry: DELTA }, { patch: vi.fn(async () => { throw new Error("monitor not found"); }) });
    fireEvent.click(screen.getByRole("button", { name: "mute 261218 7150P delta" }));
    expect((await screen.findByRole("alert")).textContent).toBe("monitor not found");
  });
});

describe("while a write is in flight, and after it", () => {
  /** A write the test lets land when it chooses. */
  function pending() {
    let land = () => undefined as void;
    const write = vi.fn(() => new Promise<void>((r) => { land = r; }));
    return { write, land: () => land() };
  }

  it("takes no second action while a mute is on its way", () => {
    const p = pending();
    controls({ entry: DELTA }, { patch: p.write });
    fireEvent.click(screen.getByRole("button", { name: "mute 261218 7150P delta" }));
    for (const name of ["edit", "mute", "delete"]) {
      expect([name, screen.getByRole("button", { name: `${name} 261218 7150P delta` }).hasAttribute("disabled")])
        .toEqual([name, true]);
    }
  });

  it("cannot be kept once the delete is on its way, nor deleted twice", () => {
    const p = pending();
    controls({ entry: DELTA }, { remove: p.write });
    fireEvent.click(screen.getByRole("button", { name: "delete 261218 7150P delta" }));
    fireEvent.click(screen.getByRole("button", { name: "delete it" }));
    const ask = screen.getByRole("group", { name: "delete 261218 7150P delta?" });
    expect(within(ask).getByRole("button", { name: "keep it" }).hasAttribute("disabled")).toBe(true);
    expect(within(ask).getByRole("button", { name: "delete it" }).hasAttribute("disabled")).toBe(true);
    expect(p.write).toHaveBeenCalledOnce();
  });

  it("takes no switch back on twice while the first is on its way", () => {
    const p = pending();
    controls({ monitor: monitor("q-unknown") }, { patch: p.write });
    fireEvent.click(screen.getByRole("button", { name: "switch 261211 8000C delta back on" }));
    fireEvent.click(screen.getByRole("button", { name: "switch it on" }));
    expect(screen.getByRole("button", { name: "switch it on" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "keep it off" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "switch 261211 8000C delta back on" }).hasAttribute("disabled")).toBe(true);
  });

  it("hands the focus to its edit button when the rule is still drawn here after a mute", async () => {
    controls({ entry: DELTA });
    const mute = screen.getByRole("button", { name: "mute 261218 7150P delta" });
    mute.focus();
    fireEvent.click(mute);
    await until(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "edit 261218 7150P delta" })));
  });

  it("hands the focus to the sheet's heading when the rule it was on is gone", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T15:00:00Z") });
    onTestFinished(() => { vi.useRealTimers(); });
    const writes = serveEditing();
    render(<Next />);
    fireEvent.click(await screen.findByRole("button", { name: "details of 1218_P7150" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "delete 261218 7150P delta" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "delete it" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    await until(() => expect(document.activeElement).toBe(within(sheet).getByRole("heading", { name: "1218_P7150" })));
  });

  /** The race #350 captured under load, made to happen every time: the write lands inside an `act`
   *  that holds React's render open for `ms` while real timers run, so a focus settled on a timer
   *  is settled while `busy` is still drawn and every button is disabled. Before the fix the focus
   *  stayed on the pressed button, disabled, for the render to take away. */
  async function landHeld(p: ReturnType<typeof pending>, ms: number) {
    await act(async () => { p.land(); await new Promise((r) => setTimeout(r, ms)); });
  }

  /** The rule's controls inside a surface with a heading, on a page with one of its own. */
  function inSurface(over: Partial<MonitorActions>) {
    const a = actions(over);
    const ui = (open: boolean) => (
      <MonitorActionsContext.Provider value={a.value}>
        <main className="nx-main">
          <h2>the page</h2>
          <button type="button">elsewhere</button>
          {open ? (
            <aside>
              <h3>the inspector</h3>
              <MonitorControls rule={ruleOfEntry(DELTA)} served={DELTA} />
            </aside>
          ) : null}
        </main>
      </MonitorActionsContext.Provider>
    );
    const view = render(ui(true));
    return { close: () => view.rerender(ui(false)) };
  }

  it.each(["mute", "delete"] as const)(
    "hands the focus to the edit button after a %s whose render lands after its timer",
    async (what) => {
      const p = pending();
      controls({ entry: DELTA }, what === "mute" ? { patch: p.write } : { remove: p.write });
      const pressed = screen.getByRole("button", { name: `${what} 261218 7150P delta` });
      pressed.focus();
      fireEvent.click(pressed);
      if (what === "delete") fireEvent.click(screen.getByRole("button", { name: "delete it" }));
      await landHeld(p, 30);
      await until(() => expect(document.activeElement)
        .toBe(screen.getByRole("button", { name: "edit 261218 7150P delta" })));
    });

  it("never leaves the focus on a disabled button or the body, however long the render is held", async () => {
    const p = pending();
    inSurface({ patch: p.write });
    const mute = screen.getByRole("button", { name: "mute 261218 7150P delta" });
    mute.focus();
    fireEvent.click(mute);
    // longer than any count of timer turns a settle could wait through
    await landHeld(p, 500);
    const edit = screen.getByRole("button", { name: "edit 261218 7150P delta" });
    const heading = screen.getByRole("heading", { name: "the inspector" });
    await until(() => expect([edit, heading]).toContain(document.activeElement));
    expect((document.activeElement as HTMLButtonElement).disabled ?? false).toBe(false);
  });

  it("takes no focus back when the surface the rule was in closed while its write was out", async () => {
    const p = pending();
    const { close } = inSurface({ patch: p.write });
    const mute = screen.getByRole("button", { name: "mute 261218 7150P delta" });
    mute.focus();
    fireEvent.click(mute);
    // the owner closes the inspector and goes on elsewhere before the write lands
    close();
    const elsewhere = screen.getByRole("button", { name: "elsewhere" });
    elsewhere.focus();
    await landHeld(p, 30);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe("a rule the service switched off", () => {
  it("shows a quarantine's whole reason before switching it back on", async () => {
    const { sent } = controls({ monitor: monitor("q-unknown") });
    const label = "261211 8000C delta";
    fireEvent.click(screen.getByRole("button", { name: `switch ${label} back on` }));
    expect(sent).toEqual([]);
    const ask = screen.getByRole("group", { name: `switch ${label} back on?` });
    expect(ask.textContent).toContain("the provider does not know its contract US.SPXW261211C8300000");
    expect(ask.textContent).toMatch(/switches it off again/);
    fireEvent.click(within(ask).getByRole("button", { name: "switch it on" }));
    await waitFor(() => expect(sent).toEqual([{ what: "PATCH", id: "q-unknown", body: { enabled: true } }]));
  });

  it("survives the row coming back on while the question is still asked", () => {
    // the write lands and the page reloads BEFORE the question closes: the rule is on by then
    const a = actions();
    const q = monitor("q-unknown");
    const ui = (m: Monitor) => (
      <MonitorActionsContext.Provider value={a.value}>
        <MonitorControls rule={ruleOfMonitor(m)} served={null} />
      </MonitorActionsContext.Provider>
    );
    const { rerender } = render(ui(q));
    fireEvent.click(screen.getByRole("button", { name: "switch 261211 8000C delta back on" }));
    rerender(ui({ ...q, enabled: true, disabled_reason: null }));
    expect(screen.queryByRole("group", { name: /back on\?$/ })).toBeNull();
    expect(screen.getByRole("button", { name: "mute 261211 8000C delta" })).toBeTruthy();
  });

  it("can be edited to fix it, while off", async () => {
    const { sent } = controls({ monitor: monitor("q-unknown") });
    const form = await openEditor("261211 8000C delta");
    choose(form, "threshold", "0.15");
    fireEvent.click(within(form).getByRole("button", { name: "save" }));
    await waitFor(() => expect(sent).toEqual([{ what: "PATCH", id: "q-unknown", body: { threshold: 0.15 } }]));
  });

  it("says when an expired rule is deleted, from the service's retention, and offers no unmute", () => {
    controls({ monitor: monitor("m-expired") }, { retentionDays: 7 });
    expect(screen.getByText("expired 2026-11-06 — the service deletes it on 2026-11-14")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^unmute/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^delete/ })).toBeTruthy();
  });

  it("is expired by its date, whatever its reason: a quarantine past expiry is not switched back on", () => {
    // the sweep deletes ANY rule past its expiry and retention, on or off (`expiryVerdict`)
    controls({ monitor: { ...monitor("q-unknown"), strike_date: "2026-11-06" } });
    expect(screen.getByText("expired 2026-11-06 — the service deletes it on 2026-11-14")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /back on$/ })).toBeNull();
  });

  it("offers no unmute to a rule past its expiry that was switched off with its holding", () => {
    controls({ monitor: { ...monitor("m-muted"), disabled_reason: "holding-closed", strike_date: "2026-11-10" } });
    // the 10th is before the 11th, the sweep's day (UTC), though it is still the 10th in New York
    expect(screen.getByText("expired 2026-11-10 — the service deletes it on 2026-11-18")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^unmute/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^delete/ })).toBeTruthy();
  });

  it("is not expired on its expiry day itself, which the sweep still watches", () => {
    controls({ monitor: { ...monitor("m-muted"), strike_date: "2026-11-11" } });
    expect(screen.queryByText(/^expired/)).toBeNull();
    expect(screen.getByRole("button", { name: /^unmute/ })).toBeTruthy();
  });

  it("says the expiry alone while the service has not said its retention", () => {
    controls({ monitor: monitor("m-expired") }, { retentionDays: null });
    expect(screen.getByText("expired 2026-11-06 — the service deletes it after its retention window")).toBeTruthy();
  });
});

describe("from both arrangements", () => {
  function book(over: Partial<BookProps> = {}): BookProps {
    return {
      quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null, holdingsAt: null,
      mode: "live", session: over.mode !== "review", privacy: false, entryStyle: "opportunity", ...over,
    };
  }
  const wrap = (a: MonitorActions, ui: React.ReactNode) =>
    render(<MonitorActionsContext.Provider value={a}>{ui}</MonitorActionsContext.Provider>);

  it("edits a rule from the desk's inspector, its own and the leg's under it", async () => {
    const { value, sent } = actions();
    wrap(value, <DeskBook {...book()} />);
    fireEvent.click(screen.getByRole("button", { name: "1218_P7150" }));
    const inspector = screen.getByRole("complementary", { name: /^inspector/ });
    expect(within(inspector).getByRole("button", { name: "edit 1218_P7150 spread value" })).toBeTruthy();
    fireEvent.click(within(inspector).getByRole("button", { name: "mute 261218 7150P delta" }));
    await waitFor(() => expect(sent).toEqual([{ what: "PATCH", id: DELTA.id, body: { enabled: false } }]));
  });

  it("switches a quarantined rule back on from the desk's inspector, and unmutes from the muted list", async () => {
    const { value, sent } = actions();
    wrap(value, <DeskBook {...book()} />);
    fireEvent.click(screen.getByRole("button", { name: "261211 8000C" }));
    const inspector = screen.getByRole("complementary", { name: /^inspector/ });
    fireEvent.click(within(inspector).getByRole("button", { name: /^switch .* back on$/ }));
    fireEvent.click(within(inspector).getByRole("button", { name: "switch it on" }));
    fireEvent.click(screen.getByRole("button", { name: "unmute 261218 8000C delta" }));
    await waitFor(() => expect(sent.map((s) => [s.id, s.body])).toEqual([
      ["q-unknown", { enabled: true }], ["m-muted", { enabled: true }],
    ]));
  });

  it("edits from the phone's sheet, and from the switched-off list", async () => {
    const { value, sent } = actions();
    wrap(value, <div className="nx"><PhoneBook {...book()} /></div>);
    fireEvent.click(screen.getByRole("button", { name: "details of 1218_P7150" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "mute 1218_P7150 spread value" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "mute 261218 7150P delta" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((s) => s.id)).toEqual([SPREAD.id, DELTA.id]);
  });

  it("hides no control from a holding's rules on the phone, and shows no money under privacy", async () => {
    const { value } = actions();
    wrap(value, <div className="nx"><PhoneBook {...book({ privacy: true })} /></div>);
    fireEvent.click(screen.getByRole("button", { name: "details of 1218_C7300" }));
    const sheet = await screen.findByRole("dialog");
    const edit = within(sheet).getAllByRole("button", { name: /^edit / })[0]!;
    fireEvent.click(edit);
    const form = await within(sheet).findByRole("form");
    expect(form.textContent).not.toMatch(/\$\d|×\d/);
  });

  it("keeps the phone's sheet open when Escape cancels an edit or a question inside it", async () => {
    // the sheet's own dismissal does not ask whether the key was handled: Escape must stop here
    const { value } = actions();
    wrap(value, <div className="nx"><PhoneBook {...book()} /></div>);
    fireEvent.click(screen.getByRole("button", { name: "details of 1218_P7150" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "edit 261218 7150P delta" }));
    fireEvent.keyDown(within(sheet).getByLabelText("threshold"), { key: "Escape" });
    expect(within(sheet).queryByRole("form")).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "delete 261218 7150P delta" }));
    fireEvent.keyDown(within(sheet).getByRole("button", { name: "keep it" }), { key: "Escape" });
    expect(within(sheet).queryByRole("group", { name: /^delete/ })).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    // and an Escape nobody handled still closes it
    fireEvent.keyDown(within(sheet).getByRole("button", { name: "edit 261218 7150P delta" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("draws no control where no actions were given, as a book drawn on its own is", () => {
    render(<DeskBook {...book()} />);
    fireEvent.click(screen.getByRole("button", { name: "1218_P7150" }));
    expect(screen.queryByRole("button", { name: /^edit / })).toBeNull();
  });
});

describe("the page after a save", () => {
  it("keeps the saved book when a poll asked before the save answers after it", async () => {
    // a slow poll — OpenD's 10 s limit against a 5 s cadence — still in flight when the owner
    // mutes a rule: the save's reload lands first, and the older answer must not put the rule back
    // the owner's book on a day before its expiries, as the rest of this file's clock is
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T15:00:00Z") });
    onTestFinished(() => { vi.useRealTimers(); });
    const writes = serveEditing();
    const served = window.fetch;
    let hold = false;
    const held: (() => void)[] = [];
    window.fetch = ((url: string, init?: RequestInit) => {
      const answer = served(url, init);
      if (!hold || !String(url).endsWith("/quotes")) return answer;
      return new Promise((r) => held.push(() => r(answer)));
    }) as typeof fetch;
    render(<Next />);
    // jsdom's window is the phone's width: the rule is reached through its spread's sheet
    fireEvent.click(await screen.findByRole("button", { name: "details of 1218_P7150" }));
    const sheet = await screen.findByRole("dialog");

    hold = true;
    fireEvent.click(screen.getByRole("button", { name: "refresh now", hidden: true }));
    hold = false;
    fireEvent.click(within(sheet).getByRole("button", { name: "mute 261218 7150P delta" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    // the save's reload has landed: the rule is off, listed with what is switched off
    await screen.findByRole("button", { name: "unmute 261218 7150P delta", hidden: true });

    // the poll from before the save answers last, with the book as it was
    expect(held).toHaveLength(1);
    held[0]!();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("button", { name: "mute 261218 7150P delta", hidden: true })).toBeNull();
    expect(screen.getByRole("button", { name: "unmute 261218 7150P delta", hidden: true })).toBeTruthy();
  });
});
