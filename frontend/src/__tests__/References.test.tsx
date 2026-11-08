/** The Reference strip on the page, and the panel that keeps one (ADR 0018). */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SOURCES } from "backend/schemas";

import { App } from "../App";

const health = {
  db: true, provider: { name: "moomoo", ok: true },
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7, manage_by_dte: 21 },
};

const SPX = {
  id: "r1", code: "US.SPY", label: "SPX", source: "moomoo", name: "SPDR S&P 500 ETF Trust",
  figure: 7587.3, field: "mid_price", change: 0.003982956650611325, error: null,
};

/** A row with a breach, so the top line has something to say and the ORDER can be seen. */
const ringing = {
  id: "m1", code: "US.SPXW261120C8100000", field: "option_delta", threshold: 0.2,
  direction: "above", compare: "abs", triggered: true, strike_date: "2026-11-20",
  dte: 45, fill: 99, scope: null, positions: [], cost_to_close: null, entry: null,
  pnl: null, schedule: null, quote: { name: "SPXW 261120 8100.00C" },
};

let posted: { url: string; init: RequestInit }[] = [];
let references: unknown[] = [];

function mockApi(rows: unknown[] = [], quotes: unknown[] = []) {
  posted = [];
  references = rows;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (init.method && init.method !== "GET") {
      posted.push({ url, init });
      return { ok: true, status: 204, json: () => Promise.resolve(null) } as unknown as Response;
    }
    return {
      ok: true,
      json: () => Promise.resolve(
        url.endsWith("/references") ? references
          : url.endsWith("/quotes") ? quotes
            : url.endsWith("/monitors") ? []
              : url.includes("/positions") ? []
                : health),
    } as Response;
  }));
}

afterEach(() => { vi.useRealTimers(); });

const settled = async () => { await act(async () => { await Promise.resolve(); }); };

describe("the strip on the page", () => {
  it("draws the figure the poll brought back", async () => {
    mockApi([SPX]);
    render(<App />);
    await settled();
    await settled();
    expect(screen.getByText("SPX (moomoo)")).toBeTruthy();
    expect(screen.getByText("7,587.30")).toBeTruthy();
  });

  it("sits BELOW what needs you, which must stay the conspicuous line", async () => {
    // TopLine appears rather than reports, and a line that is almost always the same becomes
    // furniture — which this strip is by design, so it must not take that position
    mockApi([SPX], [ringing]);
    const { container } = render(<App />);
    await settled();
    await settled();
    const top = container.querySelector(".topline")!;
    const strip = container.querySelector(".references")!;
    expect(top).toBeTruthy();
    expect(top.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("stays away entirely while nothing is kept", async () => {
    mockApi([]);
    const { container } = render(<App />);
    await settled();
    await settled();
    expect(container.querySelector(".references")).toBeNull();
  });

  it("goes away rather than showing figures it cannot vouch for", async () => {
    // its own catch inside the poll: a refusal here must neither blank the watchlist nor leave a
    // stale index level reading as current
    mockApi([SPX]);
    render(<App />);
    await settled();
    await settled();
    expect(screen.getByText("7,587.30")).toBeTruthy();

    vi.stubGlobal("fetch", vi.fn(async (url: string) => (
      url.endsWith("/references")
        ? { ok: false, status: 502, json: () => Promise.resolve({ detail: "no" }) } as Response
        : {
          ok: true,
          json: () => Promise.resolve(
            url.endsWith("/quotes") ? [] : url.endsWith("/monitors") ? [] : health),
        } as Response
    )));
    fireEvent.click(screen.getByRole("button", { name: "refresh now" }));
    await settled();
    await settled();
    expect(screen.queryByText("7,587.30")).toBeNull();
    // and the page is not claiming a failed poll: the watchlist's own figures arrived
    expect(screen.queryByText(/502/)).toBeNull();
  });
});

describe("keeping one", () => {
  it("posts the code, the label and the source", async () => {
    mockApi([]);
    render(<App />);
    await settled();
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    await settled();
    const sheet = screen.getByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText("code"), { target: { value: "US.SPY" } });
    fireEvent.change(within(sheet).getByLabelText("call it"), { target: { value: "SPX" } });
    fireEvent.change(within(sheet).getByLabelText("from"), { target: { value: "ibkr" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "keep it" }));
    await settled();
    await settled();

    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toMatch(/\/references$/);
    expect(JSON.parse(String(posted[0]!.init.body)))
      .toEqual({ code: "US.SPY", label: "SPX", source: "ibkr" });
  });

  it("sends no label where that box was left alone, and the default source", async () => {
    // the label is absent rather than null or empty — the service reads a missing one as "the
    // code is its own name". The source is never absent: it is required, and defaults to moomoo
    mockApi([]);
    render(<App />);
    await settled();
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    await settled();
    const sheet = screen.getByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText("code"), { target: { value: "US.QQQ" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "keep it" }));
    await settled();
    await settled();
    expect(JSON.parse(String(posted[0]!.init.body))).toEqual({ code: "US.QQQ", source: "moomoo" });
  });

  it("offers exactly the vendors the backend knows about", async () => {
    // The list is the schema's, not the component's: `SOURCES` is what the route validates
    // against and what `VENDORS` is held to, so a vendor added beside its client must reach this
    // box with nobody editing a form — and one removed must leave it. Hand-written <option> tags
    // were four frontend edits per vendor and the reason this is checked rather than trusted.
    mockApi([]);
    render(<App />);
    await settled();
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    await settled();
    const sheet = screen.getByRole("dialog");
    const select = within(sheet).getByLabelText("from") as HTMLSelectElement;
    const offered = Array.from(select.options).map((o) => o.value);
    expect(offered).toEqual([...SOURCES]);
    // and the labels are the names themselves, so a vendor cannot arrive nameless
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([...SOURCES]);
  });

  it("states the reason a kept Reference has no figure, which the strip only hints at", async () => {
    mockApi([{
      ...SPX, code: "US..SPX", source: "moomoo", figure: null, field: null, change: null, name: null,
      error: "snapshot API failed: US stock indices are not supported",
    }]);
    render(<App />);
    await settled();
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    await settled();
    const panel = within(screen.getByRole("dialog")).getByTestId("references");
    expect(panel.textContent).toContain("US stock indices are not supported");
  });

  it("offers to remove one, and asks first", async () => {
    mockApi([SPX]);
    render(<App />);
    await settled();
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "settings" }));
    await settled();
    const panel = within(screen.getByRole("dialog")).getByTestId("references");
    fireEvent.click(within(panel).getByRole("button", { name: "remove" }));
    await settled();
    // the confirmation, because nothing here is removed by a misclick
    const dialogs = screen.getAllByRole("alertdialog");
    const confirm = within(dialogs[dialogs.length - 1]!);
    expect(confirm.getByText(/Delete SPX \(moomoo\)\?/)).toBeTruthy();
    fireEvent.click(confirm.getByRole("button", { name: /delete|remove/i }));
    await settled();
    await settled();
    expect(posted.map((p) => [p.init.method, p.url.replace(/^.*\/api/, "")]))
      .toEqual([["DELETE", "/references/r1"]]);
  });
});
