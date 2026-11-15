/** The add form (#293): what it posts, where a refusal is said, what privacy hides, and the preview
 *  it asks for as the legs change. That it FITS, and how many actions a condor takes, is measured
 *  by the browser suite (`NextAdd.test.tsx` and `NextAdd.iphone.test.tsx` under `__browser__/`). */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SpreadsIn } from "backend/schemas";
import { AddSpread } from "../AddSpread";
import { Next } from "../Next";
import type { Monitor } from "../shared/api";
import { fieldWords } from "../needs";
import { draftPayoff } from "../__browser__/nextBook";

/** Every request, as `METHOD path` with its parsed body. */
let asked: { what: string; body: unknown }[] = [];
let answer: { status: number; body: unknown } = { status: 201, body: { positions: [], monitors: [] } };

/** The form's two routes, each answered on purpose: the draft's payoff worked out from what was
 *  sent, as the service would, and `POST /spreads` as `answer` says. Anything else is a 404 that
 *  names the call, never an answer a wrong call could pass on. */
beforeEach(() => {
  asked = [];
  answer = { status: 201, body: { positions: [{ id: "p1", name: "x" }], monitors: [] } };
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const what = `${init?.method ?? "GET"} ${path}`;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    asked.push({ what, body });
    const reply = (status: number, json: unknown) =>
      Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(json) });
    if (what === "POST /positions/payoff") return reply(200, draftPayoff(body));
    if (what === "POST /spreads") return reply(answer.status, answer.body);
    return reply(404, { detail: `${what} is not served here` });
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
                    monitors={over.monitors ?? []} onCancel={() => undefined} now={SGT_MORNING} />);
  return { form: screen.getByRole("form", { name: "add a spread" }), onSaved };
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** The condor the audit timed, as two spreads held. */
function enterCondor() {
  type("expiry", "2026-12-18");
  type("spread 1, leg 1 strike", "7150");
  type("spread 1, leg 2 strike", "7100");
  type("spread 1 entry", "1.50");
  fireEvent.click(screen.getByRole("button", { name: "call spread" }));
  type("spread 2, leg 1 strike", "7700");
  type("spread 2, leg 2 strike", "7750");
  type("spread 2 entry", "1.25");
}

const posted = () => asked.filter((a) => a.what === "POST /spreads");

describe("the add form", () => {
  it("starts Opened on the New York trading day, not the local one", () => {
    open();
    expect((screen.getByLabelText("opened") as HTMLInputElement).value).toBe("2026-11-10");
  });

  it("saves a condor as two holdings and four Monitors in one request the route accepts", async () => {
    const { onSaved } = open();
    enterCondor();
    const save = screen.getByRole("button", { name: "Record 2 holdings + 4 Monitors" });
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(posted()).toHaveLength(1);
    const body = posted()[0]!.body as { strike_date: string; spreads: { monitors: unknown[]; opened_at: string }[] };
    expect(SpreadsIn.safeParse(body).success).toBe(true);
    expect(body.strike_date).toBe("2026-12-18");
    expect(body.spreads.map((s) => [s.monitors.length, s.opened_at])).toEqual([[2, "2026-11-10"], [2, "2026-11-10"]]);
  });

  it("creates no Monitor that was switched off", async () => {
    const { onSaved } = open();
    enterCondor();
    fireEvent.click(screen.getByRole("switch", { name: "spread 2 delta Monitor" }));
    expect(screen.getByRole("switch", { name: "spread 2 delta Monitor" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Record 2 holdings + 3 Monitors" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    const body = posted()[0]!.body as { spreads: { monitors: unknown[] }[] };
    expect(body.spreads[1]!.monitors).toEqual([{ threshold: -2.5, direction: "below", compare: "signed" }]);
  });

  it("says a refusal from the service IN the form, and keeps what was typed", async () => {
    answer = { status: 409, body: { detail: "position '1218_P7150_P7100' already exists" } };
    const { form, onSaved } = open();
    enterCondor();
    fireEvent.click(screen.getByRole("button", { name: /^Record/ }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe("position '1218_P7150_P7100' already exists");
    expect(onSaved).not.toHaveBeenCalled();
    expect((screen.getByLabelText("spread 1, leg 1 strike") as HTMLInputElement).value).toBe("7150");
  });

  it("says what is missing before asking the service anything", () => {
    const { form } = open();
    type("spread 1, leg 1 strike", "7150");
    fireEvent.click(screen.getByRole("button", { name: /^Record/ }));
    expect(within(form).getByRole("alert").textContent).toBe("type the expiry");
    expect(posted()).toEqual([]);
  });

  it("watches a spread at the thresholds typed, with no holding's figures", async () => {
    const { onSaved } = open();
    fireEvent.click(screen.getByRole("button", { name: "Watch it" }));
    expect(screen.queryByLabelText("opened")).toBeNull();
    expect(screen.queryByLabelText("spread 1 entry")).toBeNull();
    type("expiry", "2026-12-18");
    type("spread 1, leg 1 strike", "7150");
    type("spread 1, leg 2 strike", "7100");
    type("spread 1 value threshold", "1.8");
    type("spread 1 delta threshold", "0.15");
    fireEvent.click(screen.getByRole("button", { name: "Watch it + 2 Monitors" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect((posted()[0]!.body as { spreads: unknown[] }).spreads[0]).toEqual({
      name: "1218_P7150_P7100", held: false,
      legs: [
        { side: "short", option_type: "PUT", strike: 7150 },
        { side: "long", option_type: "PUT", strike: 7100 },
      ],
      monitors: [{ threshold: 1.8 }, { option_type: "PUT", strike: 7150, threshold: 0.15 }],
    });
  });

  it("hides the contract count under privacy, with the class that masks it", () => {
    open({ privacy: true });
    // the class is what draws the digits as dots (add.css); the browser suite measures that it does
    expect(screen.getByLabelText("spread 1 contracts").classList.contains("nx-private")).toBe(true);
    cleanup();
    open({ privacy: false });
    expect(screen.getByLabelText("spread 1 contracts").classList.contains("nx-private")).toBe(false);
  });

  it("words a held credit's stop as its cost to close, and a watched spread's as its value", () => {
    open();
    const line = () => screen.getByRole("switch", { name: "spread 1 value Monitor" }).parentElement!.textContent;
    expect(line()).toMatch(/^on\s*cost to close ≥/);
    fireEvent.click(screen.getByRole("button", { name: "Watch it" }));
    expect(line()).toMatch(/^on\s*\|/);
    expect(line()).toContain(`|${fieldWords("mid_price")}|`);
  });

  it("starts a debit spread's stop switched off, and says why", () => {
    open();
    type("spread 1, leg 1 strike", "7150");
    type("spread 1, leg 2 strike", "7100");
    type("spread 1 entry", "-1.50");
    expect(screen.getByRole("switch", { name: "spread 1 value Monitor" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("a debit spread's stop is a fall in its value: at or below")).toBeTruthy();
  });

  it("warns, and keeps it on, when a credit's stop can never fire — from the payoff served", async () => {
    open();
    type("spread 1, leg 1 strike", "7150");
    type("spread 1, leg 2 strike", "7100");
    type("spread 1 entry", "30");
    expect(screen.getByRole("switch", { name: "spread 1 value Monitor" }).getAttribute("aria-checked")).toBe("true");
    expect((await screen.findByRole("status", { name: "spread 1's stop" })).textContent)
      .toBe("the stop at 60.00 can never fire: this spread costs at most 50.00 to close");
    // a leg changed: the curve on screen is no longer this draft's, so neither is its warning
    type("spread 1, leg 2 strike", "7000");
    expect(screen.queryByRole("status", { name: "spread 1's stop" })).toBeNull();
    // and the new legs' payoff, once served, says the stop can fire after all
    await waitFor(() => expect(drafts().at(-1)?.legs[1]?.strike).toBe(7000));
    await screen.findByRole("group", { name: /payoff at expiry by SPX price/ });
    expect(screen.queryByRole("status", { name: "spread 1's stop" })).toBeNull();
  });

  it("names the watch rules a held spread will replace, before saving and after", async () => {
    const watching: Monitor = {
      id: "w1", code: "US.SPXW261218P7150000", strike_date: "2026-12-18", option_type: "PUT", strike: 7150,
      field: "option_delta", threshold: 0.15, direction: "above", compare: "abs", legs: null, enabled: true,
      scope: null, positions: [], disabled_reason: null, triggered: false, last_value: null,
      last_checked_at: null, created_at: null,
    };
    answer = { status: 201, body: { positions: [{ id: "p1", name: "x" }], monitors: [], replaced: [{ id: "w1", code: watching.code, field: "option_delta" }] } };
    const { onSaved } = open({ monitors: [watching] });
    type("expiry", "2026-12-18");
    type("spread 1, leg 1 strike", "7150");
    type("spread 1, leg 2 strike", "7100");
    type("spread 1 entry", "1.50");
    expect(screen.getByText("Replaces the watch rules: 7150 put |Δ| ≥ 0.15")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Record/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(onSaved.mock.calls[0]![0].replaced).toHaveLength(1);
  });
});

describe("a watch rule saved under #293's name (#351)", () => {
  it("is still the one a held 1×1 spread replaces: the form derives that name exactly", async () => {
    const watching: Monitor = {
      id: "w1", code: "1218_P7150_P7100", strike_date: "2026-12-18", option_type: "CMB", strike: 0,
      field: "mid_price", threshold: 1.8, direction: "above", compare: "abs", enabled: true,
      legs: [{ sign: -1, option_type: "PUT", strike: 7150 }, { sign: 1, option_type: "PUT", strike: 7100 }],
      scope: null, positions: [], disabled_reason: null, triggered: false, last_value: null,
      last_checked_at: null, created_at: null,
    };
    const { onSaved } = open({ monitors: [watching] });
    type("expiry", "2026-12-18");
    type("spread 1, leg 1 strike", "7150");
    type("spread 1, leg 2 strike", "7100");
    type("spread 1 entry", "1.50");
    expect(screen.getByText(/^Replaces the watch rules: 1218_P7150_P7100 \|value\| ≥ 1\.80/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Record/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect((posted()[0]!.body as { spreads: { name: string }[] }).spreads[0]!.name).toBe("1218_P7150_P7100");
  });
});

const drafts = () => asked.filter((a) => a.what === "POST /positions/payoff")
  .map((a) => a.body as { legs: { side: string; option_type: string; strike: number }[]; entry: number; contracts: number });

describe("legs added and removed (#334)", () => {
  const legs = () => screen.getAllByLabelText(/^spread 1, leg \d strike$/);
  const addLeg = () => fireEvent.click(screen.getByRole("button", { name: "spread 1: add a leg" }));

  for (const n of [3, 5, 6]) {
    it(`saves a ${n}-leg combo, each leg its own side, type and strike, previewed whole`, async () => {
      const { onSaved } = open();
      type("expiry", "2026-12-18");
      const strikes = ["7150", "7100", "7050", "7000", "6950", "6900"];
      for (let i = 2; i < n; i++) addLeg();
      expect(legs()).toHaveLength(n);
      strikes.slice(0, n).forEach((k, i) => type(`spread 1, leg ${i + 1} strike`, k));
      // the last leg made a short call: its own side and type, not its neighbours'
      fireEvent.click(screen.getByRole("button", { name: `spread 1, leg ${n} side: long — flip` }));
      fireEvent.click(screen.getByRole("button", { name: `spread 1, leg ${n} type: PUT — change` }));
      type("spread 1 entry", "3");
      await waitFor(() => expect(drafts().at(-1)?.legs).toHaveLength(n));
      fireEvent.click(screen.getByRole("button", { name: "Record holding + 3 Monitors" }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
      const body = posted()[0]!.body as { spreads: { legs: { side: string; option_type: string; strike: number }[]; monitors: unknown[] }[] };
      expect(SpreadsIn.safeParse(body).success).toBe(true);
      const sent = body.spreads[0]!;
      expect(sent.legs.map((l) => `${l.side[0]}${l.option_type[0]}${l.strike}`)).toEqual([
        "sP7150", "lP7100", ...strikes.slice(2, n - 1).map((k) => `lP${k}`), `sC${strikes[n - 1]}`,
      ]);
      expect(sent.monitors).toEqual([
        { threshold: -6, direction: "below", compare: "signed" },
        { option_type: "PUT", strike: 7150, threshold: 0.3 },
        { option_type: "CALL", strike: Number(strikes[n - 1]), threshold: 0.3 },
      ]);
    });
  }

  it("offers no seventh leg, and takes none away below two", () => {
    open();
    expect(screen.queryByRole("button", { name: /^remove spread 1, leg/ })).toBeNull();
    for (let i = 0; i < 4; i++) addLeg();
    expect(legs()).toHaveLength(6);
    expect(screen.queryByRole("button", { name: "spread 1: add a leg" })).toBeNull();
    type("spread 1, leg 3 strike", "7050");
    fireEvent.click(screen.getByRole("button", { name: "remove spread 1, leg 2" }));
    expect(legs()).toHaveLength(5);
    expect((legs()[1] as HTMLInputElement).value).toBe("7050");
    expect(screen.getByRole("button", { name: "spread 1: add a leg" })).toBeTruthy();
  });

  it("keeps the focus with its leg when a leg above it is removed", () => {
    open();
    addLeg(); addLeg();
    ["7150", "7100", "7050", "7000"].forEach((k, i) => type(`spread 1, leg ${i + 1} strike`, k));
    const third = screen.getByLabelText("spread 1, leg 3 strike") as HTMLInputElement;
    third.focus();
    fireEvent.click(screen.getByRole("button", { name: "remove spread 1, leg 2" }));
    // the box the owner was in is still the 7050 leg's, now the second, and still focused
    expect(document.activeElement).toBe(third);
    expect(third.value).toBe("7050");
    expect(third.getAttribute("aria-label")).toBe("spread 1, leg 2 strike");
  });

  it("gives the focus to + leg when the remove button that had it goes with its leg", () => {
    open();
    addLeg(); addLeg();
    const remove = screen.getByRole("button", { name: "remove spread 1, leg 4" });
    remove.focus();
    fireEvent.click(remove);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "spread 1: add a leg" }));
    // down to two, every remove button gone: the focus is not left on nothing
    const last = screen.getByRole("button", { name: "remove spread 1, leg 3" });
    last.focus();
    fireEvent.click(last);
    expect(screen.queryByRole("button", { name: /^remove spread 1, leg/ })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "spread 1: add a leg" }));
  });

  it("gives a structure with no short leg no |Δ| Monitor, and saves it without one", async () => {
    const { onSaved } = open();
    type("expiry", "2026-12-18");
    type("spread 1, leg 1 strike", "7150");
    type("spread 1, leg 2 strike", "7100");
    fireEvent.click(screen.getByRole("button", { name: "spread 1, leg 1 side: short — flip" }));
    expect(screen.getByRole("switch", { name: "spread 1 delta Monitor" }).getAttribute("aria-checked")).toBe("false");
    type("spread 1 entry", "-4");
    fireEvent.click(screen.getByRole("button", { name: "Record holding + 0 Monitors" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect((posted()[0]!.body as { spreads: { monitors: unknown[] }[] }).spreads[0]!.monitors).toEqual([]);
  });
});

describe("a quantity per leg (#351)", () => {
  it("saves a butterfly as three legs, its middle sold twice over, previewed with the quantity", async () => {
    const { onSaved } = open();
    type("expiry", "2026-12-18");
    fireEvent.click(screen.getByRole("button", { name: "spread 1: add a leg" }));
    ["7100", "7150", "7200"].forEach((k, i) => type(`spread 1, leg ${i + 1} strike`, k));
    fireEvent.click(screen.getByRole("button", { name: "spread 1, leg 1 side: short — flip" }));
    fireEvent.click(screen.getByRole("button", { name: "spread 1, leg 2 side: long — flip" }));
    expect((screen.getByLabelText("spread 1, leg 2 quantity") as HTMLInputElement).value).toBe("1");
    type("spread 1, leg 2 quantity", "2");
    type("spread 1 entry", "-1.20");
    await waitFor(() => expect(drafts().at(-1)?.legs[1]).toEqual({ side: "short", option_type: "PUT", strike: 7150, qty: 2 }));
    // a debit: its stop is switched off, and the short leg's |Δ| is one Monitor
    fireEvent.click(screen.getByRole("button", { name: "Record holding + 1 Monitor" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    const body = posted()[0]!.body as { spreads: { name: string; legs: unknown[]; monitors: unknown[] }[] };
    expect(SpreadsIn.safeParse(body).success).toBe(true);
    expect(body.spreads[0]!.legs).toEqual([
      { side: "long", option_type: "PUT", strike: 7100 }, { side: "short", option_type: "PUT", strike: 7150, qty: 2 },
      { side: "long", option_type: "PUT", strike: 7200 },
    ]);
    expect(body.spreads[0]!.name).toBe("1218_+P7100_-2P7150_+P7200");
    expect(body.spreads[0]!.monitors).toEqual([{ option_type: "PUT", strike: 7150, threshold: 0.3 }]);
  });

  it("says a quantity it cannot read before asking the service anything", () => {
    open();
    type("expiry", "2026-12-18");
    type("spread 1, leg 1 strike", "7150");
    type("spread 1, leg 2 strike", "7100");
    type("spread 1 entry", "1.50");
    type("spread 1, leg 2 quantity", "11");
    fireEvent.click(screen.getByRole("button", { name: /^Record holding/ }));
    expect(screen.getByRole("alert").textContent).toContain("spread 1, leg 2: the quantity is a whole number from 1 to 10");
    expect(posted()).toEqual([]);
  });
});

describe("the preview", () => {

  it("redraws as a strike is typed: the legs named under it, and the readout off the new curve (#396)", async () => {
    open();
    type("spread 1, leg 1 strike", "7150");
    type("spread 1, leg 2 strike", "7100");
    type("spread 1 entry", "1.50");
    const chart = await screen.findByRole("group", { name: /payoff at expiry by SPX price/ });
    const payoff = screen.getByRole("group", { name: "payoff at expiry" });
    const strikes = () => [...payoff.querySelectorAll("[data-strikes]")].map((t) => t.textContent).join(" ");
    const said = () => payoff.querySelector("[data-said]")!.textContent ?? "";
    await waitFor(() => expect(strikes()).toBe("+P7100 −P7150"));
    fireEvent.keyDown(chart, { key: "Home" });
    // below both strikes: the 50-point width less the 1.50 taken, per contract
    expect(said()).toMatch(/: -48\.50 pts$/);

    // the long leg typed a digit at a time, from 7100 to 7050
    type("spread 1, leg 2 strike", "705");
    type("spread 1, leg 2 strike", "7050");
    await waitFor(() => expect(strikes()).toBe("+P7050 −P7150"));
    const redrawn = screen.getByRole("group", { name: /payoff at expiry by SPX price/ });
    fireEvent.keyDown(redrawn, { key: "Home" });
    expect(said()).toMatch(/: -98\.50 pts$/);
    fireEvent.keyDown(redrawn, { key: "End" });
    expect(said()).toMatch(/: \+1\.50 pts$/);
  });

  it("asks for the payoff once the strikes are typed, per contract, and again when a side flips", async () => {
    open();
    expect(screen.getByText("type the strikes to see its payoff at expiry")).toBeTruthy();
    type("spread 1, leg 1 strike", "7150");
    type("spread 1, leg 2 strike", "7100");
    type("spread 1 entry", "1.50");
    await waitFor(() => expect(drafts().at(-1)?.entry).toBe(1.5));
    expect(drafts().at(-1)).toEqual({
      legs: [
        { side: "short", option_type: "PUT", strike: 7150 },
        { side: "long", option_type: "PUT", strike: 7100 },
      ],
      entry: 1.5, contracts: 1,
    });
    await screen.findByRole("group", { name: /payoff at expiry by SPX price/ });

    fireEvent.click(screen.getByRole("button", { name: "spread 1, leg 2 side: long — flip" }));
    // at once, before the pause that settles the typing: the curve on screen is no longer this
    // draft's, and says so rather than standing as current
    expect(screen.getByRole("group", { name: "payoff at expiry" }).getAttribute("aria-busy")).toBe("true");
    await waitFor(() => expect(drafts().at(-1)?.legs.map((l) => l.side)).toEqual(["short", "short"]));
  });
});

describe("the desk's panel", () => {
  beforeEach(() => {
    document.cookie = "ui_arrangement=desk;path=/";
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      const path = String(url).replace(/^.*\/api/, "");
      const body = path === "/health"
        ? { db: true, provider: { name: "moomoo", ok: true }, monitor: { last_sweep_at: null, alarms: { label: "watching", bad: false }, fetched_at: null }, settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 } }
        : [];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }));
  });
  afterEach(() => { document.cookie = "ui_arrangement=;path=/;max-age=0"; });

  it("takes the focus into the form, names itself from +, and gives it back on Escape", async () => {
    render(<Next />);
    const plus = screen.getByRole("button", { name: "add" });
    fireEvent.click(plus);
    const panel = screen.getByRole("region", { name: "add a spread or contract" });
    expect(plus.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.id).not.toBe("");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("expiry")));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "add a spread or contract" })).toBeNull();
    expect(document.activeElement).toBe(plus);
  });
});


describe("a spread's rules at or above, or at or below (#405)", () => {
  const pair = (which: string) => screen.getByRole("group", { name: `spread 1 ${which} direction` });
  const press = (which: string, words: string) =>
    fireEvent.click(within(pair(which)).getByRole("button", { name: words }));
  const pressed = (which: string) =>
    within(pair(which)).getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.textContent);

  it("saves a watched spread's |value| ≤ and |Δ| ≤, each posted below", async () => {
    const { onSaved } = open();
    fireEvent.click(screen.getByRole("button", { name: "Watch it" }));
    type("expiry", "2026-12-18");
    type("spread 1, leg 1 strike", "7150");
    type("spread 1, leg 2 strike", "7100");
    type("spread 1 value threshold", "0.40");
    type("spread 1 delta threshold", "0.05");
    expect([pressed("value"), pressed("delta")]).toEqual([["≥"], ["≥"]]);
    press("value", "≤ at or below");
    press("delta", "≤ at or below");
    expect([pressed("value"), pressed("delta")]).toEqual([["≤"], ["≤"]]);
    fireEvent.click(screen.getByRole("button", { name: "Watch it + 2 Monitors" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    const body = posted()[0]!.body as { spreads: { monitors: unknown[] }[] };
    expect(SpreadsIn.safeParse(body).success).toBe(true);
    expect(body.spreads[0]!.monitors).toEqual([
      { threshold: 0.4, direction: "below" },
      { option_type: "PUT", strike: 7150, threshold: 0.05, direction: "below" },
    ]);
  });

  it("words a watched spread's value as its size, and goes back to ≥ when asked", async () => {
    const { onSaved } = open();
    fireEvent.click(screen.getByRole("button", { name: "Watch it" }));
    const line = screen.getByRole("switch", { name: "spread 1 value Monitor" }).parentElement!;
    expect(line.textContent).toMatch(/^on\s*\|/);
    expect(line.textContent).toContain(`|${fieldWords("mid_price")}|`);
    type("expiry", "2026-12-18");
    type("spread 1, leg 1 strike", "7150");
    type("spread 1, leg 2 strike", "7100");
    type("spread 1 value threshold", "1.8");
    fireEvent.click(screen.getByRole("switch", { name: "spread 1 delta Monitor" }));
    press("value", "≤ at or below");
    press("value", "≥ at or above");
    fireEvent.click(screen.getByRole("button", { name: "Watch it + 1 Monitor" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect((posted()[0]!.body as { spreads: { monitors: unknown[] }[] }).spreads[0]!.monitors).toEqual([{ threshold: 1.8 }]);
  });

  it("keeps a held credit's stop the cost to close ≥, offering a choice for its delta only", async () => {
    const { onSaved } = open();
    type("expiry", "2026-12-18");
    type("spread 1, leg 1 strike", "7150");
    type("spread 1, leg 2 strike", "7100");
    type("spread 1 entry", "1.50");
    const line = screen.getByRole("switch", { name: "spread 1 value Monitor" }).parentElement!;
    expect(line.textContent).toMatch(/^on\s*cost to close ≥/);
    expect(screen.queryByRole("group", { name: "spread 1 value direction" })).toBeNull();
    press("delta", "≤ at or below");
    fireEvent.click(screen.getByRole("button", { name: "Record holding + 2 Monitors" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect((posted()[0]!.body as { spreads: { monitors: unknown[] }[] }).spreads[0]!.monitors).toEqual([
      { threshold: -3, direction: "below", compare: "signed" },
      { option_type: "PUT", strike: 7150, threshold: 0.3, direction: "below" },
    ]);
  });

  it("starts a held debit's value rule at ≤ when switched on, and posts it below (owner, #405)", async () => {
    const { onSaved } = open();
    type("expiry", "2026-12-18");
    type("spread 1, leg 1 strike", "7150");
    type("spread 1, leg 2 strike", "7100");
    type("spread 1 entry", "-1.50");
    fireEvent.click(screen.getByRole("switch", { name: "spread 1 value Monitor" }));
    expect(pressed("value")).toEqual(["≤"]);
    expect(pressed("delta")).toEqual(["≥"]);
    type("spread 1 value threshold", "0.75");
    fireEvent.click(screen.getByRole("button", { name: "Record holding + 2 Monitors" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect((posted()[0]!.body as { spreads: { monitors: unknown[] }[] }).spreads[0]!.monitors[0])
      .toEqual({ threshold: 0.75, direction: "below" });
  });

  it("calls a held spread's |Δ| ≥ a risk, and its |Δ| ≤ a close-cheap signal", () => {
    open();
    const line = () => screen.getByRole("switch", { name: "spread 1 delta Monitor" }).parentElement!;
    expect(line().querySelector("small")!.textContent).toBe("risk");
    press("delta", "≤ at or below");
    expect(line().querySelector("small")!.textContent).toBe("close-cheap signal");
    press("delta", "≥ at or above");
    expect(line().querySelector("small")!.textContent).toBe("risk");
  });

  it("lets a held debit's value rule be pressed back to ≥, posting no direction", async () => {
    const { onSaved } = open();
    type("expiry", "2026-12-18");
    type("spread 1, leg 1 strike", "7150");
    type("spread 1, leg 2 strike", "7100");
    type("spread 1 entry", "-1.50");
    fireEvent.click(screen.getByRole("switch", { name: "spread 1 value Monitor" }));
    press("value", "≥ at or above");
    expect(pressed("value")).toEqual(["≥"]);
    type("spread 1 value threshold", "3");
    fireEvent.click(screen.getByRole("button", { name: "Record holding + 2 Monitors" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect((posted()[0]!.body as { spreads: { monitors: unknown[] }[] }).spreads[0]!.monitors[0]).toEqual({ threshold: 3 });
  });

  it("switches a rule's pair off with its rule", () => {
    open();
    fireEvent.click(screen.getByRole("switch", { name: "spread 1 delta Monitor" }));
    for (const b of within(pair("delta")).getAllByRole("button")) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("what each choice does, said on it (#408)", () => {
  it("describes 'I hold it' and 'Watch it' by their consequence, in both forms, their names unchanged", () => {
    open();
    const said = () => ["I hold it", "Watch it"].map((name) => {
      const b = screen.getByRole("button", { name });
      return document.getElementById(b.getAttribute("aria-describedby")!)!.textContent;
    });
    const expected = ["records a holding; its rules become a stop and risk", "rules only, as entry signals"];
    expect(said()).toEqual(expected);
    fireEvent.click(screen.getByRole("button", { name: "one contract" }));
    expect(said()).toEqual(expected);
  });
});

describe("switching Watch and Hold (#408)", () => {
  const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;
  const pressedIn = (group: string) =>
    within(screen.getByRole("group", { name: group })).getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent);
  const toWatch = () => fireEvent.click(screen.getByRole("button", { name: "Watch it" }));
  const toHold = () => fireEvent.click(screen.getByRole("button", { name: "I hold it" }));

  it("loses nothing typed, either way, any number of times — and posts all of it", async () => {
    const { onSaved } = open();
    toWatch();
    type("expiry", "2026-12-18");
    fireEvent.click(screen.getByRole("button", { name: "spread 1: add a leg" }));
    type("spread 1, leg 1 strike", "7150");
    type("spread 1, leg 2 strike", "7100");
    type("spread 1, leg 3 strike", "7200");
    type("spread 1, leg 3 quantity", "2");
    fireEvent.click(screen.getByRole("button", { name: "spread 1, leg 3 type: PUT — change" }));
    fireEvent.click(screen.getByRole("button", { name: "spread 1, leg 3 side: long — flip" }));
    type("spread 1 name", "my ratio");
    type("spread 1 value threshold", "0.40");
    fireEvent.click(within(screen.getByRole("group", { name: "spread 1 value direction" })).getByRole("button", { name: "≤ at or below" }));
    type("spread 1 delta threshold", "0.12");
    fireEvent.click(within(screen.getByRole("group", { name: "spread 1 delta direction" })).getByRole("button", { name: "≤ at or below" }));
    fireEvent.click(screen.getByRole("button", { name: "call spread" }));
    type("spread 2, leg 1 strike", "7700");
    type("spread 2, leg 2 strike", "7750");
    type("spread 2 value threshold", "1.10");
    fireEvent.click(screen.getByRole("switch", { name: "spread 2 delta Monitor" }));

    toHold();
    type("opened", "2026-11-09");
    type("spread 1 entry", "-0.80");
    type("spread 1 contracts", "3");
    type("spread 2 entry", "1.25");
    type("spread 2 contracts", "2");

    for (let i = 0; i < 3; i += 1) {
      toWatch();
      // what Watch has, as typed
      expect(value("expiry")).toBe("2026-12-18");
      expect([1, 2, 3].map((j) => value(`spread 1, leg ${j} strike`))).toEqual(["7150", "7100", "7200"]);
      expect(value("spread 1, leg 3 quantity")).toBe("2");
      expect(screen.getByRole("button", { name: "spread 1, leg 3 type: CALL — change" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "spread 1, leg 3 side: short — flip" })).toBeTruthy();
      expect(value("spread 1 name")).toBe("my ratio");
      expect(value("spread 1 value threshold")).toBe("0.40");
      expect(value("spread 1 delta threshold")).toBe("0.12");
      expect([pressedIn("spread 1 value direction"), pressedIn("spread 1 delta direction")]).toEqual([["≤"], ["≤"]]);
      expect(value("spread 2 value threshold")).toBe("1.10");
      expect(screen.getByRole("switch", { name: "spread 2 delta Monitor" }).getAttribute("aria-checked")).toBe("false");
      expect(screen.queryByLabelText("opened")).toBeNull();
      expect(screen.queryByLabelText("spread 1 entry")).toBeNull();
      toHold();
      // what only Hold has, set aside and back
      expect(value("opened")).toBe("2026-11-09");
      expect([value("spread 1 entry"), value("spread 1 contracts")]).toEqual(["-0.80", "3"]);
      expect([value("spread 2 entry"), value("spread 2 contracts")]).toEqual(["1.25", "2"]);
      // and what both have, still as typed
      expect(value("spread 1 value threshold")).toBe("0.40");
      expect(value("spread 1 delta threshold")).toBe("0.12");
      expect(value("spread 2 value threshold")).toBe("1.10");
    }

    fireEvent.click(screen.getByRole("button", { name: /^Record 2 holdings/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    const body = posted()[0]!.body as { strike_date: string; spreads: unknown[] };
    expect(SpreadsIn.safeParse(body).success).toBe(true);
    expect(body.strike_date).toBe("2026-12-18");
    expect(body.spreads).toEqual([
      {
        name: "my ratio", held: true, entry: -0.8, contracts: 3, opened_at: "2026-11-09",
        legs: [
          { side: "short", option_type: "PUT", strike: 7150 },
          { side: "long", option_type: "PUT", strike: 7100 },
          { side: "short", option_type: "CALL", strike: 7200, qty: 2 },
        ],
        // a held debit: the value rule as typed, at or below; both short legs' |Δ| at or below
        monitors: [
          { threshold: 0.4, direction: "below" },
          { option_type: "PUT", strike: 7150, threshold: 0.12, direction: "below" },
          { option_type: "CALL", strike: 7200, threshold: 0.12, direction: "below" },
        ],
      },
      {
        name: "1218_C7700_C7750", held: true, entry: 1.25, contracts: 2, opened_at: "2026-11-09",
        legs: [{ side: "short", option_type: "CALL", strike: 7700 }, { side: "long", option_type: "CALL", strike: 7750 }],
        // a held credit's stop at the figure typed while watched, as its cost to close
        monitors: [{ threshold: -1.1, direction: "below", compare: "signed" }],
      },
    ]);
  });
});
