import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";
// the service's OWN schemas, not a copy of them — see the contract test at the end of this file
import { MonitorCreateIn } from "../../../backend/src/schemas/monitor.ts";
import { PositionIn } from "../../../backend/src/schemas/position.ts";

/** Phase 1 of the shadcn rebuild (ADR 0007): the two add-forms had NO tests, and they hold
 *  nine of the native selects phase 4 replaces. These assert what reaches the server, never
 *  how the form was operated — so when the controls become Base UI popups, only the three
 *  helpers below change and every expectation stands untouched.
 *
 *  If you are here in phase 4 rewriting more than those helpers, the tests were wrong. */

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
};

let posted: { url: string; body: Record<string, unknown> }[] = [];

function mockApi(failWith?: string) {
  posted = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET") {
      posted.push({ url, body: JSON.parse(init!.body as string) });
      if (failWith) {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({ detail: failWith }) } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    }
    const body = url.endsWith("/quotes") ? [] : url.endsWith("/monitors") ? [] : health;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  }));
}

// ── the three interaction helpers phase 4 rewrites ──────────────────────────────
// Everything below the line asserts payloads and should survive the swap untouched.

function type(scope: HTMLElement, label: string, value: string) {
  fireEvent.change(within(scope).getByLabelText(label, { exact: false }), { target: { value } });
}

function choose(scope: HTMLElement, label: string, value: string) {
  fireEvent.change(within(scope).getByLabelText(label, { exact: false }), { target: { value } });
}

/** Rewritten in phase 4, which is the whole point of fencing these off. The row used to be
 *  one <label> wrapping three controls, found by walking the DOM; the two selects now carry
 *  their own names, so this asks for them rather than groping for them. */
function setLeg(scope: HTMLElement, n: number, sign: string, type_: string, strike: string) {
  fireEvent.change(within(scope).getByLabelText(`leg ${n} sign`), { target: { value: sign } });
  fireEvent.change(within(scope).getByLabelText(`leg ${n} type`), { target: { value: type_ } });
  fireEvent.change(
    within(scope).getByLabelText(`leg ${n}`, { exact: true }),
    { target: { value: strike } },
  );
}
// ────────────────────────────────────────────────────────────────────────────────

/** The forms live in a sheet since phase 5 of the responsive work (ADR 0008), so getting
 *  at one means opening it. Still an interaction helper; still no assertion moved. */
async function openForm(which: "monitor" | "combo", failWith?: string) {
  mockApi(failWith);
  render(<App />);
  await waitFor(() => expect(screen.getByText(`add ${which}`)).toBeTruthy());
  await userEvent.click(screen.getByText(`add ${which}`));
  return await screen.findByRole("dialog");
}

/** The combo form starts at two legs and grows; ask for the rows before filling them. */
async function needLegs(scope: HTMLElement, n: number) {
  for (let i = 2; i < n; i++) await userEvent.click(within(scope).getByText("add leg"));
}

describe("adding a single-leg monitor", () => {
  beforeEach(() => { document.cookie = "ui_cols_single=;path=/"; });

  it("posts the contract, the rule, and numbers as numbers", async () => {
    const monitor = await openForm("monitor");

    type(monitor, "expiry", "2026-10-16");
    choose(monitor, "type", "PUT");
    type(monitor, "strike", "7100");
    choose(monitor, "field", "option_delta");
    type(monitor, "threshold", "-0.25");
    choose(monitor, "direction", "below");
    choose(monitor, "compare", "signed");
    fireEvent.submit(within(monitor).getByRole("button", { name: "watch" }).closest("form")!);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.url).toMatch(/\/monitors$/);
    expect(posted[0]!.body).toEqual({
      strike_date: "2026-10-16",
      option_type: "PUT",
      strike: 7100,
      field: "option_delta",
      threshold: -0.25,
      direction: "below",
      compare: "signed",
    });
    // strings here would be accepted by JSON and rejected by the service
    expect(typeof posted[0]!.body.strike).toBe("number");
    expect(typeof posted[0]!.body.threshold).toBe("number");
  });

  it("offers implied volatility, which a single contract does have", async () => {
    const monitor = await openForm("monitor");
    const field = within(monitor).getByLabelText("field", { exact: false });
    expect([...field.querySelectorAll("option")].map((o) => o.textContent))
      .toContain("option_implied_volatility");
  });
});

describe("adding a combo", () => {
  beforeEach(() => { document.cookie = "ui_cols_combo=;path=/"; });

  it("posts legs with the signs the user chose", async () => {
    const combo = await openForm("combo");

    type(combo, "name", "1016_IC");
    type(combo, "expiry", "2026-10-16");
    await needLegs(combo, 4);
    setLeg(combo, 1, "-", "CALL", "8050");
    setLeg(combo, 2, "+", "CALL", "8075");
    setLeg(combo, 3, "-", "PUT", "7100");
    setLeg(combo, 4, "+", "PUT", "7075");
    choose(combo, "field", "mid_price");
    type(combo, "threshold", "3.21");
    fireEvent.submit(within(combo).getByRole("button", { name: "watch combo" }).closest("form")!);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toMatchObject({
      name: "1016_IC",
      strike_date: "2026-10-16",
      field: "mid_price",
      threshold: 3.21,
      direction: "above",
      compare: "abs",
      // short the body, long the wings — an iron condor, and the signs are the whole
      // meaning of the combo: reverse them and the value flips
      legs: [
        { sign: -1, option_type: "CALL", strike: 8050 },
        { sign: 1, option_type: "CALL", strike: 8075 },
        { sign: -1, option_type: "PUT", strike: 7100 },
        { sign: 1, option_type: "PUT", strike: 7075 },
      ],
    });
  });

  it("drops the leg rows left blank", async () => {
    const combo = await openForm("combo");

    type(combo, "name", "1016_bs_8050");
    type(combo, "expiry", "2026-10-16");
    // ask for a third row and leave it empty: the form no longer draws rows you did not
    // want, so proving blanks are dropped means creating one on purpose
    await needLegs(combo, 3);
    setLeg(combo, 1, "-", "CALL", "8050");
    setLeg(combo, 2, "+", "CALL", "8075");
    type(combo, "threshold", "2.76");
    fireEvent.submit(within(combo).getByRole("button", { name: "watch combo" }).closest("form")!);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body.legs).toHaveLength(2);
  });

  /** The holding. `entry` is the one thing the form asks that is not about the alarm: it is what
   *  you took in, and it is what makes P&L knowable. The service keeps it on a Position, never on
   *  a Monitor — "a Monitor exists to warn, never to record what you own" — so a filled entry is
   *  TWO records, and these tests are about that split rather than about one wider body. */
  async function fillCondor(combo: HTMLElement, entry?: string) {
    type(combo, "name", "1120_IC_7100_8200");
    type(combo, "expiry", "2026-11-20");
    await needLegs(combo, 4);
    setLeg(combo, 1, "-", "CALL", "8200");
    setLeg(combo, 2, "+", "CALL", "8250");
    setLeg(combo, 3, "-", "PUT", "7100");
    setLeg(combo, 4, "+", "PUT", "7050");
    type(combo, "threshold", "8.01");
    if (entry !== undefined) type(combo, "entry", entry);
    fireEvent.submit(within(combo).getByRole("button", { name: "watch combo" }).closest("form")!);
  }

  it("records the holding as well, when an entry is given", async () => {
    const combo = await openForm("combo");
    await fillCondor(combo, "7.4");

    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[0]!.url).toMatch(/\/monitors$/);
    expect(posted[1]!.url).toMatch(/\/positions$/);
    // the rule's body is untouched: entry is not a monitor field and must not be sent as one
    expect(posted[0]!.body).not.toHaveProperty("entry");
    expect(posted[1]!.body).toEqual({
      name: "1120_IC_7100_8200",
      strike_date: "2026-11-20",
      entry: 7.4,
      // `sign` is the combo's vocabulary and `side` the holding's: the minus the form offers
      // means short, and a short leg is one you sold. Reverse this and the P&L inverts.
      legs: [
        { side: "sold", option_type: "CALL", strike: 8200 },
        { side: "bought", option_type: "CALL", strike: 8250 },
        { side: "sold", option_type: "PUT", strike: 7100 },
        { side: "bought", option_type: "PUT", strike: 7050 },
      ],
    });
    // contracts is deliberately not sent — the service defaults it, and the form does not ask
    expect(posted[1]!.body).not.toHaveProperty("contracts");
  });

  it("posts only the rule when the entry is left blank", async () => {
    // watching a structure you do not hold is legitimate, and is what this form did before
    const combo = await openForm("combo");
    await fillCondor(combo);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.url).toMatch(/\/monitors$/);
    expect(posted.some((p) => p.url.includes("/positions"))).toBe(false);
  });

  it("records no holding when the rule itself is refused", async () => {
    // both routes probe the contracts, so the order decides only which record survives a
    // half-failure. The rule goes first: a rule with no entry is the state you were already
    // in, while a holding nothing watches has no screen on this dashboard that lists it.
    const combo = await openForm("combo", "no contract US.SPXW261120C8200000");
    await fillCondor(combo, "7.4");

    await waitFor(() => expect(screen.getByText(/no contract US.SPXW261120C8200000/)).toBeTruthy());
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toMatch(/\/monitors$/);
  });

  it("sends bodies the service's own schemas accept", async () => {
    // Neither tsc nor the mock above can check this. `createWatch` casts with `as never` — Hono's
    // validator InputType cannot be inferred, which is why that cast exists at all — and the
    // mocked fetch accepts anything that is JSON. So the two bodies are run through the REAL
    // schemas, the only thing that would catch `side` written as `sign`, or a renamed field.
    const combo = await openForm("combo");
    await fillCondor(combo, "7.4");
    await waitFor(() => expect(posted).toHaveLength(2));

    const rule = MonitorCreateIn.safeParse(posted[0]!.body);
    expect(rule.success ? null : rule.error.issues).toBeNull();
    const holding = PositionIn.safeParse(posted[1]!.body);
    expect(holding.success ? null : holding.error.issues).toBeNull();
  });

  it("never offers implied volatility, which cannot be summed", async () => {
    const combo = await openForm("combo");
    const field = within(combo).getByLabelText("field", { exact: false });
    const offered = [...field.querySelectorAll("option")].map((o) => o.textContent);
    // CLAUDE.md, combos: "IV is never summed" — two 20% legs are not a 40% combo
    expect(offered).not.toContain("option_implied_volatility");
    expect(offered).toContain("mid_price");
  });
});
