import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";
import { holdingBody } from "../api";
// the service's OWN schema, so a body this form sends can be proved acceptable rather than
// assumed — the same contract the add-forms test holds to
import { PositionIn } from "backend/schemas";

/** Recording what a holding cost, AFTER the rule was added.
 *
 *  The gap this closes: a combo added without an entry has no Position at all, so the inline
 *  entry cell — which derives its target from `entry.positions` — rendered nothing, and the
 *  add-form was the only way in. Miss it once and the combo was permanently entry-less.
 *
 *  Opened comes with it, because entry alone restores no exit schedule: on-pace needs a DTE at
 *  entry and ADR 0011 will not guess one. Nothing in the UI set Opened before this.
 */

const health = {
  db: true, opend: true, queue_depth: 0,
  monitor: { last_sweep_at: "x", alarms: { label: "active", bad: false }, fetched_at: "x" },
  settings: { sweep_seconds: 15, expired_retention_days: 7 },
};

const LEGS = [
  { sign: -1, option_type: "CALL", strike: 8200 },
  { sign: 1, option_type: "CALL", strike: 8250 },
  { sign: -1, option_type: "PUT", strike: 7150 },
  { sign: 1, option_type: "PUT", strike: 7100 },
];

/** a combo rule with NO holding — scope null, no positions, no entry */
const bare = {
  id: "m1", code: "1130_IC_8200_7150", field: "mid_price", threshold: 7.0,
  direction: "above", compare: "abs", triggered: false, strike_date: "2026-11-30",
  dte: 47, fill: null, scope: null, positions: [],
  cost_to_close: null, entry: null, pnl: null, quote: null,
  legs: LEGS, combo_value: -6.2, combo_greeks: {}, schedule: null,
};
/** the same rule as /monitors spells it: `code` for the name, and the legs with their signs */
const rule = {
  id: "m1", code: "1130_IC_8200_7150", strike_date: "2026-11-30",
  option_type: "CMB", strike: 0, legs: LEGS, scope: null,
  field: "mid_price", threshold: 7.0, direction: "above", compare: "abs",
  enabled: true, name: null, triggered: false, last_value: null,
};
/** a DIFFERENT rule, listed FIRST, so finding the right one by id is load-bearing rather than
 *  being satisfied by whatever happens to be at the head of the list */
const otherRule = {
  ...{ id: "zzz", code: "1016_IC_8000_7000", strike_date: "2026-10-16" },
  option_type: "CMB", strike: 0, scope: null,
  legs: [
    { sign: -1, option_type: "CALL", strike: 8000 },
    { sign: 1, option_type: "CALL", strike: 8050 },
  ],
  field: "mid_price", threshold: 1.0, direction: "above", compare: "abs",
  enabled: true, name: null, triggered: false, last_value: null,
};
/** and one that already holds its Position, so entry is a patch rather than a create */
const held = {
  ...bare, id: "m2", code: "1120_IC_7100_8200", scope: "all",
  positions: [{ id: "p9", name: "1120_IC_7100_8200" }], entry: 6.86,
};

let posted: { url: string; method: string; body: Record<string, unknown> }[] = [];

function mockApi(rows: unknown[], rules: unknown[] = [rule]) {
  posted = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      posted.push({ url, method, body: JSON.parse(init!.body as string) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    }
    const body = url.endsWith("/vol") ? { vol: null, from: null, to: null, days: null }
      : url.endsWith("/quotes") ? rows : url.endsWith("/monitors") ? rules : health;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  }));
}

beforeEach(() => { document.cookie = "ui_cols_combo=;path=/"; });

const openRow = async (code: string) => {
  await waitFor(() => expect(screen.getByText(code)).toBeTruthy());
  await userEvent.click(screen.getByText(code));
  return await screen.findByRole("dialog");
};
const type = (scope: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(scope).getByLabelText(label, { exact: false }), { target: { value } });

describe("recording a holding on a rule that has none", () => {
  it("creates the Position, with the legs' sides derived from the rule's signs", async () => {
    mockApi([bare]);
    render(<App />);
    const sheet = await openRow("1130_IC_8200_7150");

    type(sheet, "entry", "7.05");
    type(sheet, "opened", "2026-10-14");
    await userEvent.click(within(sheet).getByRole("button", { name: /record/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.url).toMatch(/\/positions$/);
    expect(posted[0]!.body).toMatchObject({
      name: "1130_IC_8200_7150",
      strike_date: "2026-11-30",
      entry: 7.05,
      opened_at: "2026-10-14",
      legs: [
        { side: "short", option_type: "CALL", strike: 8200 },
        { side: "long", option_type: "CALL", strike: 8250 },
        { side: "short", option_type: "PUT", strike: 7150 },
        { side: "long", option_type: "PUT", strike: 7100 },
      ],
    });
  });

  it("sends a body the service's own schema accepts", async () => {
    mockApi([bare]);
    render(<App />);
    const sheet = await openRow("1130_IC_8200_7150");
    type(sheet, "entry", "7.05");
    type(sheet, "opened", "2026-10-14");
    await userEvent.click(within(sheet).getByRole("button", { name: /record/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(() => PositionIn.parse(posted[0]!.body)).not.toThrow();
  });

  it("patches, rather than creating a second one, when the holding already exists", async () => {
    mockApi([held], []);
    render(<App />);
    const sheet = await openRow("1120_IC_7100_8200");

    type(sheet, "entry", "6.90");
    type(sheet, "opened", "2026-10-06");
    await userEvent.click(within(sheet).getByRole("button", { name: /record/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.url).toMatch(/\/positions\/p9$/);
    expect(posted[0]!.method).toBe("PATCH");
    expect(posted[0]!.body).toEqual({ entry: 6.9, opened_at: "2026-10-06" });
  });

  it("records the entry alone when no Opened is given, rather than refusing", async () => {
    // a holding with no Opened is the state every Position recorded before ADR 0011 was in: P&L
    // works, the schedule is absent. Better than demanding a date the owner may not have to hand.
    mockApi([bare]);
    render(<App />);
    const sheet = await openRow("1130_IC_8200_7150");
    type(sheet, "entry", "7.05");
    await userEvent.click(within(sheet).getByRole("button", { name: /record/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toMatchObject({ entry: 7.05, opened_at: null });
  });

  it("asks nothing and sends nothing without an entry", async () => {
    mockApi([bare]);
    render(<App />);
    const sheet = await openRow("1130_IC_8200_7150");
    await userEvent.click(within(sheet).getByRole("button", { name: /record/i }));
    expect(posted).toHaveLength(0);
  });
});

describe("one derivation, so the two surfaces cannot disagree", () => {
  /** The owner asked for BOTH an inline control and a form in the sheet, and the obvious risk of
   *  two surfaces is two derivations that drift. There is one: `holdingBody`. These assert that
   *  the add-form's body and a /monitors row — which spell the rule's name differently and agree
   *  on everything else — produce the identical Position. */
  it("derives the same holding from the add-form's body and from a /monitors row", () => {
    const fromForm = { name: "1130_IC_8200_7150", strike_date: "2026-11-30", legs: LEGS };
    const fromRule = { code: "1130_IC_8200_7150", strike_date: "2026-11-30", legs: LEGS };
    const values = { entry: 7.05, opened_at: "2026-10-14" };
    expect(holdingBody(fromRule, values)).toEqual(holdingBody(fromForm, values));
  });

  it("signs a lone long contract's entry negative, whichever surface asked", () => {
    // entry is a net credit RECEIVED, so a debit is negative; a long recorded positive reports
    // more than double its real profit. Asserted here because the sheet now asks for a side too.
    const rule = { code: "x", strike_date: "2026-11-20", option_type: "CALL", strike: 8100 };
    expect(holdingBody(rule, { entry: 5, side: "long" })).toMatchObject({
      name: "2026-11-20_C8100", entry: -5,
      legs: [{ side: "long", option_type: "CALL", strike: 8100 }],
    });
    expect(holdingBody(rule, { entry: 5, side: "short" })).toMatchObject({ entry: 5 });
  });

  it("states Opened as null when none was given, rather than leaving it out", () => {
    expect(holdingBody({ code: "x", strike_date: "2026-11-30", legs: LEGS }, { entry: 1 }))
      .toMatchObject({ opened_at: null });
  });
});

describe("which surface offers what", () => {
  it("the sheet can record a holding where the inline box shows nothing at all", async () => {
    // the bug exactly: EntryCell finds its target in `entry.positions`, so a rule with none
    // rendered no control. The sheet is the surface that can bring one into being.
    mockApi([bare]);
    render(<App />);
    const sheet = await openRow("1130_IC_8200_7150");
    // the inline box is absent — no holding to point at
    expect(within(sheet).queryByPlaceholderText("entry")).toBeNull();
    // ...and the full form is present
    expect(within(sheet).getByLabelText("opened", { exact: false })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: /record/i })).toBeTruthy();
  });

  it("offers a side for a lone contract and not for a combo", async () => {
    mockApi([bare]);
    render(<App />);
    const combo = await openRow("1130_IC_8200_7150");
    // a combo's sides come from its legs' signs; asking again could contradict them
    expect(within(combo).queryByLabelText("side", { exact: false })).toBeNull();
  });

  it("adds nothing for a rule spanning two holdings, which have no single Opened", async () => {
    // ADR 0011: two Positions put on different days have no one DTE at entry, so no schedule —
    // and the split credit is what the inline box already sends.
    const spanning = {
      ...bare, id: "m3", scope: "all",
      positions: [{ id: "pa", name: "a" }, { id: "pb", name: "b" }],
    };
    mockApi([spanning], []);
    render(<App />);
    const sheet = await openRow("1130_IC_8200_7150");
    expect(within(sheet).queryByRole("button", { name: /record/i })).toBeNull();
    expect(within(sheet).queryByLabelText("opened", { exact: false })).toBeNull();
  });
});

describe("finding the rule the holding belongs to", () => {
  it("derives from the rule with the row's OWN id, not the first one listed", async () => {
    // App resolves the rule from its /monitors state by id. A mutation sweep found that taking
    // the head of the list passed every test, because every test had one rule — and the wrong
    // rule means a holding recorded against another trade's strikes, which no screen would
    // contradict.
    mockApi([bare], [otherRule, rule]);
    render(<App />);
    const sheet = await openRow("1130_IC_8200_7150");
    type(sheet, "entry", "7.05");
    await userEvent.click(within(sheet).getByRole("button", { name: /record/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toMatchObject({
      name: "1130_IC_8200_7150", strike_date: "2026-11-30",
    });
    expect((posted[0]!.body.legs as { strike: number }[]).map((l) => l.strike))
      .toEqual([8200, 8250, 7150, 7100]);
  });

  it("says so in words when the rules have not loaded yet", async () => {
    // the guard turns a TypeError deep in the derivation into something the toast can show.
    // Without it the message is "Cannot read properties of undefined", which tells the owner
    // nothing about what to do — and a mutation sweep showed nothing could tell the two apart.
    mockApi([bare], []);
    render(<App />);
    const sheet = await openRow("1130_IC_8200_7150");
    type(sheet, "entry", "7.05");
    await userEvent.click(within(sheet).getByRole("button", { name: /record/i }));

    await waitFor(() => expect(screen.getByText(/has not loaded yet/)).toBeTruthy());
    expect(posted).toHaveLength(0);
  });
});

describe("a rule that watches PART of someone else's holding", () => {
  /** The live bug. `1120_BS_7100` names two legs of the 1120 condor, so its row carries
   *  scope "leg" and `positions: [the condor]`. recordHolding derived `whole` from
   *  `scope === "all"`, got an empty list, read that as "nothing is held" and posted a new
   *  Position named after the rule — which already existed:
   *
   *      409  position '1120_BS_7100' already exists
   *
   *  An empty `whole` means "this rule covers no whole holding", NOT "nothing holds these
   *  contracts". A leg rule has no entry of its own: "a leg rule watches part of a structure and
   *  its P&L would be a fraction of someone else's credit" (watchlist.ts), so there is nothing
   *  here to record and the holding's own row is where its entry and Opened belong.
   */
  const legRule = {
    ...bare, id: "m4", code: "1120_BS_7100", scope: "leg",
    positions: [{ id: "pIC", name: "1120_IC_7100_8200" }],
  };

  it("offers no holding form, because the entry is not this rule's to state", async () => {
    mockApi([legRule], []);
    render(<App />);
    const sheet = await openRow("1120_BS_7100");
    expect(within(sheet).queryByRole("button", { name: /record/i })).toBeNull();
    expect(within(sheet).queryByLabelText("opened", { exact: false })).toBeNull();
  });

  it("names the holding whose row to use instead, rather than leaving a blank", async () => {
    mockApi([legRule], []);
    render(<App />);
    const sheet = await openRow("1120_BS_7100");
    expect(within(sheet).getByText(/1120_IC_7100_8200/)).toBeTruthy();
  });

  it("creates nothing even if asked directly", async () => {
    // the form is gone, so this is the guard behind it: a create here collides on the name and
    // a 409 is the best case — the worse one is a second Position claiming contracts the first
    // already holds, which is what makes a holding un-adoptable.
    mockApi([legRule], []);
    render(<App />);
    await openRow("1120_BS_7100");
    const { recordHolding } = await import("../api");
    await expect(recordHolding(legRule as never, undefined, { entry: 2.43 }))
      .rejects.toThrow(/belongs to the holding/i);
    expect(posted).toHaveLength(0);
  });

  it("still offers a create where nothing holds the contracts at all", async () => {
    // the case #112 was for, unchanged: no Position anywhere covers these
    mockApi([bare]);
    render(<App />);
    const sheet = await openRow("1130_IC_8200_7150");
    expect(within(sheet).getByRole("button", { name: /record/i })).toBeTruthy();
  });
});
