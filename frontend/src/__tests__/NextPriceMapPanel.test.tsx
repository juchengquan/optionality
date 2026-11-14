/** The price map as a desk panel (#298, ADR 0023): it opens and closes beside the table, and ONE
 *  selection is shared — a spread picked on the map is the row picked in the table and the
 *  inspector, and a row picked in the table is the spread marked on the map. Behaviour only; that
 *  the panel keeps the table's fit and its labels apart is measured in the browser suite. */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Entry, Holding } from "../shared/api";
import type { BookProps } from "../Book";
import { DeskBook } from "../desk/DeskBook";
import { HOLDINGS, MONITORS, payoffAnswer, QUOTES, samplesAnswer, volAnswer } from "../testing/ownerBook";
import { legMarks } from "../testing/legs";

let asked: string[] = [];

beforeEach(() => {
  asked = [];
  document.cookie = "ui_price_map=;path=/";
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    asked.push(`${init?.method ?? "GET"} ${path}`);
    // the inspector's two reads, answered explicitly; anything else is a request this panel made
    const body = samplesAnswer(path) ?? payoffAnswer(path) ?? volAnswer(path);
    return Promise.resolve(body
      ? { ok: true, status: 200, json: () => Promise.resolve(body) }
      : { ok: false, status: 404, json: () => Promise.resolve({ detail: "not served here" }) });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.cookie = "ui_price_map=;path=/";
});

function props(over: Partial<BookProps> = {}): BookProps {
  return {
    quotes: QUOTES, monitors: MONITORS, holdings: HOLDINGS, holdingsError: null, holdingsAt: null,
    session: true, privacy: false, entryStyle: "opportunity", ...over,
  };
}

const REASON = "the Provider gives no option premium to derive it from";
function bare<T extends Entry | Holding>(row: T): T {
  return {
    ...row, spx: null, spx_reason: REASON,
    short_strikes: row.short_strikes.map((s) => ({ ...s, points: null, sigma: null, one_sigma: null })),
  };
}

const toggle = () => screen.getByRole("button", { name: "price map" });
const panel = () => screen.queryByRole("region", { name: "price map" });
const open = () => { fireEvent.click(toggle()); return panel()!; };
const spreadOn = (map: HTMLElement, id: string) => map.querySelector<SVGGElement>(`[data-spread="${id}"]`)!;
const deskRow = (id: string) =>
  [...document.querySelectorAll<HTMLElement>(".nxd-row[data-ref]")].find((r) => r.dataset.ref === id)!;

describe("the panel", () => {
  it("is shut until opened, and opens and closes from its toggle", () => {
    render(<DeskBook {...props()} />);
    expect(panel()).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    open();
    expect(panel()).not.toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle());
    expect(panel()).toBeNull();
  });

  it("remembers that it was open, on this device", () => {
    const first = render(<DeskBook {...props()} />);
    open();
    first.unmount();
    render(<DeskBook {...props()} />);
    expect(panel()).not.toBeNull();
  });

  it("draws a lane per expiry and every spread, held and watched", () => {
    render(<DeskBook {...props()} />);
    const map = open();
    expect([...map.querySelectorAll<SVGElement>("[data-lane]")].map((l) => l.dataset.lane))
      .toEqual(["2026-12-04", "2026-12-18", "2026-12-31"]);
    expect([...map.querySelectorAll<SVGElement>("[data-spread]")].map((s) => [s.dataset.spread, s.dataset.kind]))
      .toEqual([["w-dec04", "watched"], ["h-calls", "held"], ["h-puts", "held"], ["w-dec18", "watched"],
        ["h-ic", "held"], ["w-dec31", "watched"]]);
    // each short strike's label names its leg, the type marked for its colour (#391)
    const ic = map.querySelector<SVGElement>("[data-spread='h-ic']")!;
    expect(legMarks(ic)).toEqual(["P6300 short PUT", "C7400 short CALL"]);
  });

  it("draws SPX's price as one line through every lane, and a served ±1σ band in each", () => {
    render(<DeskBook {...props()} />);
    const map = open();
    expect(map.querySelectorAll("[data-spx-line]")).toHaveLength(1);
    expect(within(map).getByText("SPX 6900.50")).toBeTruthy();
    expect(map.querySelectorAll("[data-band]")).toHaveLength(3);
    const sigma = [...map.querySelectorAll(".nxm-sigma")];
    expect(sigma.map((t) => t.textContent)).toContainEqual(expect.stringMatching(/^±1σ \d+ pts · P7150's IV$/));
    // the strike named beside its figure is drawn as a leg, as the strike strip's caption is (#391)
    expect(sigma.flatMap((t) => legMarks(t))).toContain("P7150 short PUT");
  });

  it("says why there is no SPX line rather than drawing one at zero, and draws no band", () => {
    render(<DeskBook {...props({ quotes: QUOTES.map(bare), holdings: HOLDINGS.map(bare) })} />);
    const map = open();
    expect(map.querySelectorAll("[data-spx-line]")).toHaveLength(0);
    expect(map.querySelectorAll("[data-band]")).toHaveLength(0);
    expect(within(map).getByText(`SPX — ${REASON}`)).toBeTruthy();
    // the spreads are still placed: the strikes are served without SPX
    expect(map.querySelectorAll("[data-spread]")).toHaveLength(6);
  });

  it("says which batch its line is from, and outside the session that it is as last valued", () => {
    const at = "2026-11-10 23:14:35+08:00";
    const holdings = HOLDINGS.map((h) => ({ ...h, spx: 6911.25, fetched_at: at }));
    const view = render(<DeskBook {...props({ holdings })} />);
    let map = open();
    expect(within(map).getByText("SPX 6911.25 · from the holdings' batch, 23:14:35")).toBeTruthy();
    view.unmount();
    render(<DeskBook {...props({ holdings, session: false })} />);
    map = panel()!;
    expect(within(map).getByText("SPX 6911.25 · as last valued, 23:14:35")).toBeTruthy();
  });

  it("says the holdings are not on it while they are being valued, or could not be", () => {
    const view = render(<DeskBook {...props({ holdings: null })} />);
    let map = open();
    expect(within(map).getByText("holdings not valued yet — only watched spreads are drawn")).toBeTruthy();
    view.unmount();
    render(<DeskBook {...props({ holdings: null, holdingsError: "the Provider is down" })} />);
    map = panel()!;
    expect(within(map).getByText("holdings could not be valued — only watched spreads are drawn")).toBeTruthy();
    expect(map.querySelectorAll('[data-spread][data-kind="held"]')).toHaveLength(0);
  });

  it("asks the service for nothing: it draws what the page already polled", () => {
    render(<DeskBook {...props()} />);
    open();
    expect(asked).toEqual([]);
  });

  it("shows no dollar figure and no contract count, and none under privacy either", () => {
    render(<DeskBook {...props({ privacy: true })} />);
    const map = open();
    const said = [map.textContent ?? "",
      ...[...map.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label") ?? "")].join(" ");
    expect(said).not.toMatch(/\$/);
    expect(said).not.toMatch(/×\s?\d/);
    expect(said).not.toMatch(/contract/);
  });
});

describe("one selection, shared with the table", () => {
  it("a spread picked on the map is the row picked in the table and the inspector", () => {
    render(<DeskBook {...props()} />);
    const map = open();
    fireEvent.click(spreadOn(map, "h-puts"));
    expect(deskRow("h-puts").hasAttribute("data-selected")).toBe(true);
    expect(screen.getByRole("complementary", { name: "inspector: 1218_P6400" })).toBeTruthy();
    expect(spreadOn(map, "h-puts").getAttribute("aria-pressed")).toBe("true");
    // and a watched one, by the keyboard
    fireEvent.keyDown(spreadOn(map, "w-dec31"), { key: "Enter" });
    expect(deskRow("w-dec31").hasAttribute("data-selected")).toBe(true);
    expect(deskRow("h-puts").hasAttribute("data-selected")).toBe(false);
  });

  it("a row picked in the table is the spread marked on the map, and only that one", () => {
    render(<DeskBook {...props()} />);
    const map = open();
    fireEvent.click(within(deskRow("h-calls")).getByRole("button", { name: "1218_C7300" }));
    const pressed = [...map.querySelectorAll<SVGGElement>("[data-spread]")]
      .filter((s) => s.getAttribute("aria-pressed") === "true").map((s) => s.dataset.spread);
    expect(pressed).toEqual(["h-calls"]);
    // closing the inspector clears it on the map too
    fireEvent.click(screen.getByRole("button", { name: "close the inspector" }));
    expect(map.querySelectorAll('[data-spread][aria-pressed="true"]')).toHaveLength(0);
  });

  it("a row the map does not draw — a rule on a single contract — marks nothing on it", () => {
    render(<DeskBook {...props()} />);
    const map = open();
    fireEvent.click(within(deskRow("w-lone")).getAllByRole("button")[0]!);
    expect(map.querySelectorAll('[data-spread][aria-pressed="true"]')).toHaveLength(0);
  });
});
