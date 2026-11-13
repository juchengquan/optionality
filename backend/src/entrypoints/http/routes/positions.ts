/** `/positions` — what is actually held, as distinct from what is watched (ADR 0009, phase 5).
 *
 *  A Position is a holding: it exists whether or not anything watches it, and deleting an alarm must
 *  never delete the record of what you own (ADR 0001). That asymmetry is the whole reason legs live
 *  here and not on a Monitor.
 */
import { Hono } from "hono";
import { z } from "zod";

import { marketDate, sampleTiming } from "optionality/domain/expiry";
import { dteAtOpen, exitLevels, exitPolicy, onPace } from "optionality/domain/exit";
import {
  POSITION_GREEK_FIELDS, contractSize, legReadings, positionGreek, positionLegCodes, realizedPoints,
} from "optionality/domain/position";
import type { Deps } from "../deps.ts";
import {
  clearPositionLinks, clearPositionSamples, clearScopeOfOrphans, deletePositionRow, findPosition,
  findPositionByName, insertPosition,
  listPositionSamples, listPositions, monitorsWatching, openPositions, updateMonitorFields,
  updatePositionFields,
} from "../../../db/queries/index.ts";
import { monitorLegCodes } from "optionality/domain/monitor";
import { buildSpxCode } from "optionality/domain/contract";
import { payoffAtExpiry } from "optionality/domain/payoff";
import { derivedSpx, strikeDistances } from "optionality/domain/quote";
import { atomic } from "../../../db/open.ts";
import { holdingValues } from "../../../holdings.ts";
import type { MonitorRow, PositionRow } from "../../../db/rows.ts";
import { newId, toSqliteBool, toSqliteJson } from "../../../db/values.ts";
import { toSqlDatetime } from "../../../db/time.ts";
import { httpError, notFound, providerFailed } from "../errors.ts";
import { paceExplained, type PacedSample } from "optionality/domain/vol";
import { toMonitor, toPosition } from "../../../hydrate.ts";
import { adoptOrphanMonitors } from "../../../monitors.ts";
import { verifyContracts } from "optionality/quotes";
import type { DisabledReason } from "../../../schemas/monitor.ts";
import {
  ClosePositionIn, DEFAULT_CONTRACTS, PayoffIn, PositionIn, PositionPatch,
} from "../../../schemas/position.ts";
import { displayStored } from "../../../db/time.ts";
import { displayTime } from "optionality/domain/timefmt";
import { documented } from "../openapi.ts";
import { valid } from "../validate.ts";
import { StrikeDistanceOut } from "./monitors.ts";

/** `side` as the two values, not a string: a stored leg that still said "sold" would otherwise be
 *  served as though nothing were wrong, and the dashboard would read it as long (ADR 0013). */
const LegOut = z.object({
  side: z.enum(["short", "long"]), option_type: z.string(), strike: z.number(),
});

const PositionOut = z.object({
  id: z.string(),
  name: z.string(),
  strategy: z.string().nullable(),
  strike_date: z.string(),
  contracts: z.number(),
  entry: z.number().nullable(),
  legs: z.array(LegOut),
  created_at: z.string().nullable(),
  /** the day it was PUT ON, which created_at is not. Null until declared (ADR 0011). */
  opened_at: z.string().nullable(),
  /** the New York market day it was closed, or null while it is held (ADR 0022) */
  closed_on: z.string().nullable(),
  /** what was paid to close it, per contract, in points; null where nobody said */
  exit: z.number().nullable(),
  /** Entry less Exit across the contracts held, in POINTS — not P&L, which is money and needs a
   *  contract size only a Quote carries, while a closed holding is no longer quoted. Null while
   *  it is held, and wherever either side is unknown (`realizedPoints`). */
  realized_points: z.number().nullable(),
});

/** A close, answered: the holding as it now stands, and the rules the close switched off, so the
 *  page can say which without a second request. */
const ClosedOut = PositionOut.extend({
  disabled_monitors: z.array(z.object({ id: z.string(), code: z.string() })),
});

/** The exit schedule, or null for a Position whose Opened nobody has declared — which is the
 *  opt-in, because nothing is inferred from created_at (ADR 0011). */
const ScheduleOut = z.object({
  dte_at_open: z.number(),
  on_pace: z.number().nullable(),
  pace_gap: z.number().nullable(),
  target: z.number().nullable(),
  stop: z.number().nullable(),
  target_dte: z.number().nullable(),
  manage_by_dte: z.number(),
  /** which Level the Cost to close has reached, null for neither (CONTEXT.md: Level) */
  reached: z.enum(["target", "stop"]).nullable(),
  manage_by_due: z.boolean(),
}).nullable();

const PositionValues = PositionOut.extend({
  cost_to_close: z.number().nullable(),
  pnl: z.number().nullable(),
  /** the share of the credit's Entry captured so far, (Entry − Cost to close) / Entry, unrounded:
   *  1 is all of it kept and below 0 costs more to close than was taken in. Null for a debit,
   *  which has no credit to keep and no Target, and wherever either side is unknown (ADR 0023). */
  captured: z.number().nullable(),
  contract_size: z.number().nullable(),
  /** SPX's price as this response's one batch implies it, from its options' premiums (ADR 0024):
   *  the same on every holding, as `contract_size` is. Null where the batch cannot give it,
   *  never a Reference's figure. */
  spx: z.number().nullable(),
  /** why `spx` is null, in words; null when there is a figure */
  spx_reason: z.string().nullable(),
  greeks: z.record(z.string(), z.number().nullable()),
  /** each leg's OWN delta, contract code -> delta, from the same batch: what a short leg's Δ is
   *  read from, which `greeks` (a signed sum over the legs) cannot give. Null when any leg's delta
   *  is missing, as the daily sample's map is (`legReadings`, #318). */
  legs_delta: z.record(z.string(), z.number()).nullable(),
  /** each SHORT leg placed against `spx`, in points and σ, with its own delta (#297): what the
   *  strike strip draws. The strikes and deltas are there without an SPX; only the distances
   *  are null, and `spx_reason` says why. */
  short_strikes: z.array(StrikeDistanceOut),
  fetched_at: z.string().nullable(),
  /** days left where the option trades, the same reckoning the dashboard's column uses */
  dte: z.number(),
  schedule: ScheduleOut,
});

/** What of a pace gap vol accounts for, measured over this holding's own samples — the first
 *  four null together where the chain is not whole enough to say (ADR 0011) — and the gap it
 *  splits, at the close it runs to (`paceExplained`, #333). */
const VolOut = z.object({
  vol: z.number().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  days: z.number().nullable(),
  /** why the vol part is not to be read, in words; null when it is */
  reason: z.string().nullable(),
  /** the last sample's day: the one `gap`, `rest` and `vega` are at */
  at: z.string().nullable(),
  /** what that sample is: the day's close, a reading in hours that are still running, or one from
   *  before the open or after the close, or one whose time was never recorded */
  timing: z.enum(["close", "in-hours", "before-open", "after-close", "unrecorded"]).nullable(),
  /** Cost to close less On-pace at that sample: positive is BEHIND */
  gap: z.number().nullable(),
  /** why there is no gap, and so no rest; null when there is one */
  gap_reason: z.string().nullable(),
  /** the gap less the vol part, left unattributed (CONTEXT.md: The rest); null with either reason */
  rest: z.number().nullable(),
  /** the structure's vega at that sample, exposure-signed as a holding's position vega; 0 below
   *  display precision */
  vega: z.number().nullable(),
  /** the IV points that would account for the whole gap, |gap ÷ vega| */
  cover: z.number().nullable(),
  /** why there is no cover; null when there is one */
  cover_reason: z.string().nullable(),
});

/** The payoff at expiry, in POINTS across the contracts (`payoffAtExpiry`, #291): the P&L at each
 *  strike and the slope beyond the outer two, which is the whole of a curve that bends only at the
 *  strikes, its breakevens and its maximums. At expiry only (ADR 0023): no T+0 curve and no
 *  probability, because there is no pricing model to draw them with. */
const PayoffOut = z.object({
  at_strikes: z.array(z.object({ spx: z.number(), pnl: z.number() })),
  slope_below: z.number(),
  slope_above: z.number(),
  breakevens: z.array(z.number()),
  /** the highest P&L, or null where it has no ceiling */
  max_profit: z.number().nullable(),
  /** the LOWEST P&L, signed (a loss is negative), or null where it has no floor */
  max_loss: z.number().nullable(),
});

/** Each leg's reading on one day, contract code -> figure: null where the sweep withheld the map,
 *  and where a stored one cannot be read — a corrupt map costs its own figure, never the request. */
const LegMap = z.record(z.string(), z.number()).nullable();

/** One Daily sample as stored (ADR 0011), with the day's On-pace beside it. */
const SampleOut = z.object({
  /** the New York market day it is that day's row for */
  observed_on: z.string(),
  /** the instant it was observed, in DISPLAY_TZ; null on rows written before migration 0009, and
   *  where the stored stamp cannot be read (`timing` is then `unrecorded`) */
  observed_at: z.string().nullable(),
  /** whether it is the day's close, and if not why (`sampleTiming`): what the chart marks */
  timing: z.enum(["close", "before-open", "after-close", "unrecorded"]),
  dte: z.number(),
  cost_to_close: z.number(),
  /** what Cost to close would be at this DTE if only time had passed (`onPace`); null without a
   *  schedule */
  on_pace: z.number().nullable(),
  legs_iv: LegMap,
  legs_vega: LegMap,
  legs_delta: LegMap,
  /** SPX's price as the writing sweep's batch implied it (ADR 0024), or null */
  spx: z.number().nullable(),
});

/** A holding's recorded history, for the burndown and the IV chart (#295): every Daily sample to
 *  the day it closed, the Levels it is held against, and the planned decay at every DTE from the
 *  open to expiry — the service's figures, so no curve is computed in the browser. */
const SamplesOut = z.object({
  /** null where Opened was never recorded: no schedule is inferred (ADR 0011) */
  levels: z.object({
    dte_at_open: z.number(),
    /** null for a debit, which has no credit to keep a fraction of */
    target: z.number().nullable(),
    stop: z.number().nullable(),
    target_dte: z.number().nullable(),
    manage_by_dte: z.number(),
  }).nullable(),
  /** On-pace at each DTE from the open down to 0; empty without a schedule or an Entry */
  plan: z.array(z.object({ dte: z.number(), on_pace: z.number() })),
  /** oldest first, none after the day it closed (ADR 0022) */
  samples: z.array(SampleOut),
});

const list = documented("List positions", { 200: z.array(PositionOut) });
const values = documented("Live value, P&L and exit schedule of every position", { 200: z.array(PositionValues) }, [502]);
const vol = documented("How much of the pace gap vol accounts for", { 200: VolOut }, [404]);
const samples = documented("A holding's daily samples, with its on-pace and its levels", { 200: SamplesOut }, [404]);
const payoff = documented("A holding's payoff at expiry", { 200: PayoffOut }, [404, 422]);
const draft = documented("The payoff at expiry of draft legs, saving nothing and asking no Provider", { 200: PayoffOut });
const create = documented("Create a position", { 201: PositionOut }, [409]);
const update = documented("Update a position", { 200: PositionOut }, [404]);
const close = documented("Close a position, keeping it and its history", { 200: ClosedOut }, [404, 409]);
const remove = documented("Delete a position", { 204: null }, [404]);

/** Why a holding cannot have closed on this day, or null. Three bounds, the same for the close and
 *  for correcting one afterwards: not before it was opened, not after its expiry — nothing is held
 *  past one — and not after today in New York, since a close that has not happened yet is a plan.
 *  ISO dates compare as text. */
function closedOnFault(
  row: PositionRow, closedOn: string, openedAt: string | null, today: string,
): string | null {
  if (openedAt !== null && closedOn < openedAt) {
    return `closed on ${closedOn}, before it was opened on ${openedAt}`;
  }
  if (closedOn > row.strike_date) return `closed on ${closedOn}, after its expiry on ${row.strike_date}`;
  if (closedOn > today) return `closed on ${closedOn}, after today (${today} in New York)`;
  return null;
}

/** Every contract some OPEN holding holds. */
function heldCodes(db: Deps["db"]): Set<string> {
  return new Set(openPositions(db).flatMap((p) => positionLegCodes(toPosition(p))));
}

/** Whether every contract a rule names is still held by something open. A row that cannot be read
 *  names nothing anyone can vouch for, so it reads as not held — the sweep would quarantine it
 *  anyway. */
function stillHeld(monitor: MonitorRow, held: Set<string>): boolean {
  try {
    return monitorLegCodes(toMonitor(monitor)).every((code) => held.has(code));
  } catch {
    return false;
  }
}

export function positionRoutes(deps: Deps) {
  const { db, settings } = deps;
  const tz = settings.displayTz;

  const out = (row: PositionRow) => ({
    id: row.id,
    name: row.name,
    strategy: row.strategy,
    strike_date: row.strike_date,
    contracts: row.contracts,
    entry: row.entry,
    legs: JSON.parse(row.legs) as unknown,
    created_at: displayStored(row.created_at, tz),
    // a plain date, NOT displayStored: created_at is an instant and converts to DISPLAY_TZ,
    // while Opened is the calendar day a trade was put on and has no time to convert
    opened_at: row.opened_at,
    closed_on: row.closed_on,
    exit: row.exit,
    // only for a closed holding: an open one's result is its live P&L, which is /values' to say
    // The legs play no part in it, so they are not parsed for it — a row this listing could always
    // serve must not start failing because it was closed.
    realized_points: row.closed_on === null ? null : realizedPoints({ ...row, legs: [] }, row.exit),
  });

  /** A stored JSON map, or null — including when it will not parse. Written by the sweeper and
   *  read here, so the two are the only places that know the encoding. */
  const parseMap = (text: string | null): Record<string, number> | null => {
    if (text === null) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      // SHAPE only. A map holding a non-numeric reading used to give vol: NaN, which zod rejects,
      // so the route answered 500 where its own comment promises the figure costs nothing but
      // itself. That is fixed in volAttribution, which now requires every reading to be a finite
      // number — and a value check here as well was unobservable: a mutation sweep removed it and
      // nothing failed, because the domain guard catches the same values. One gate, where the rule
      // lives, rather than two where only one is tested.
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, number>)
        : null;
    } catch {
      return null;
    }
  };

  /** A stored map whose every reading is a finite number, or null: the chart draws each leg's
   *  figure, and one that is not a number would fail the answer's own schema. */
  const legMap = (text: string | null): Record<string, number> | null => {
    const map = parseMap(text);
    if (map === null) return null;
    return Object.values(map).every((v) => typeof v === "number" && Number.isFinite(v)) ? map : null;
  };

  return new Hono()
    .get("/", list, (c) => list.reply(c, 200, listPositions(db).map(out)))

    /** Live cost to close, exposure and P&L for every position.
     *
     *  One bounded live call for every leg of every position, deduped. `Holdings.tsx` polls this
     *  while the panel is open, so it is a live call on the dashboard's path like `/quotes` — and
     *  CLAUDE.md's Provider invariant names it alongside the sweep, `/quotes` and the creation
     *  probes. It was a fifth exception in the code and a fourth in that sentence until
     *  2026-10-17, when the list was corrected rather than the route; `/spx/quote` left the list
     *  in #199, which took the route with it. */
    .get("/values", values, async (c) => {
      const now = deps.now();
      let valued;
      try {
        valued = await holdingValues(db, deps.provider.fetchQuotes, now, deps.settings, tz);
      } catch (err) {
        throw providerFailed(deps.provider.name, err);
      }
      // `values` is the route descriptor; the holdings are `held`
      const { byCode, values: held } = valued;
      if (held.length === 0) return values.reply(c, 200, []);
      const fetched = displayTime(now, tz);
      const spx = derivedSpx(Object.values(byCode));
      return values.reply(c, 200, held.map((v) => ({
        ...out(v.row),
        cost_to_close: v.cost,
        pnl: v.pnl,
        captured: v.captured,
        contract_size: contractSize(byCode),
        spx: spx.price,
        spx_reason: spx.reason,
        greeks: Object.fromEntries(
          POSITION_GREEK_FIELDS.map((f) => [f, positionGreek(v.position, byCode, f)]),
        ),
        legs_delta: legReadings(v.position, byCode, "option_delta"),
        short_strikes: strikeDistances(
          v.position.legs.filter((l) => l.side === "short")
            .map((l) => buildSpxCode(v.position.strike_date, l.option_type, l.strike)),
          byCode, spx.price, v.dte),
        fetched_at: fetched,
        dte: v.dte,
        schedule: v.schedule,
      })));
    })

    /** What of this holding's pace gap vol accounts for (ADR 0011).
     *
     *  One of the two routes that read history, with `/samples` (#295) — every other figure in this
     *  service comes from one live batch. Separate from `/quotes` on purpose: the dashboard polls that every 15 seconds per
     *  open tab and this changes once a market day, so the detail sheet asks for it when opened.
     *
     *  The remainder IS returned since #333, with the gap it is the remainder of: both at the
     *  close the vol part runs to, so the three are measured at one instant and the dashboard
     *  computes none of them. It once said the caller should subtract this from the gap it was
     *  showing — a live gap less a vol part measured to the last close, which charged the day's
     *  own vol moves to the rest.
     */
    .get("/:id/vol", vol, (c) => {
      const id = c.req.param("id");
      const row = findPosition(db, id);
      if (!row) throw notFound("position");
      const samples: PacedSample[] = listPositionSamples(db, id).map((s) => ({
        observed_on: s.observed_on,
        dte: s.dte,
        cost_to_close: s.cost_to_close,
        observed_at: s.observed_at,
        // a corrupt map costs the figure, never the request: the whole sheet would fail to load
        legs_iv: parseMap(s.legs_iv),
        legs_vega: parseMap(s.legs_vega),
      }));
      return vol.reply(c, 200, paceExplained(samples, toPosition(row), deps.now()));
    })

    /** A holding's daily samples, open or closed (#295): what REVIEW's burndown and IV chart draw.
     *
     *  Stored history, so no Provider call — which is why this is not on CLAUDE.md's list of
     *  market-data calls — and asked for once when REVIEW opens a holding, never polled, since a
     *  row changes at most once a market day. On-pace is `onPace` at each sample's DTE and at
     *  every DTE to expiry, the same figure `/positions/values` serves today: the plan is the
     *  service's, never redrawn in the browser. A backdated close hides the later rows
     *  (`listPositionSamples`, ADR 0022).
     */
    .get("/:id/samples", samples, (c) => {
      const id = c.req.param("id");
      const row = findPosition(db, id);
      if (!row) throw notFound("position");
      const openedDte = row.opened_at === null ? null : dteAtOpen(row.strike_date, row.opened_at);
      const levels = openedDte === null ? null
        : exitLevels(row.entry, openedDte, openedDte, exitPolicy(settings));
      const plan: { dte: number; on_pace: number }[] = [];
      for (let dte = openedDte ?? -1; dte >= 0; dte--) {
        const pace = onPace(row.entry, openedDte, dte);
        if (pace !== null) plan.push({ dte, on_pace: pace });
      }
      return samples.reply(c, 200, {
        levels: levels === null || openedDte === null ? null : {
          dte_at_open: openedDte, target: levels.target, stop: levels.stop,
          target_dte: levels.target_dte, manage_by_dte: levels.manage_by_dte,
        },
        plan,
        samples: listPositionSamples(db, id).map((s) => {
          const timing = sampleTiming(s.observed_at);
          return {
            observed_on: s.observed_on,
            // a stamp `sampleTiming` cannot read is no instant to convert: it costs its own time,
            // never the request (#295)
            observed_at: timing === "unrecorded" ? null : displayStored(s.observed_at, tz),
            timing,
            dte: s.dte,
            cost_to_close: s.cost_to_close,
            on_pace: onPace(row.entry, openedDte, s.dte),
            legs_iv: legMap(s.legs_iv),
            legs_vega: legMap(s.legs_vega),
            legs_delta: legMap(s.legs_delta),
            spx: s.spx,
          };
        }),
      });
    })

    /** A holding's payoff at expiry, from its legs, its Entry and its count — and nothing else: no
     *  quote, so no Provider call, which is why this is not on CLAUDE.md's list of market-data calls
     *  and why a closed holding answers as well as an open one. Asked for when a holding is opened,
     *  never polled, because none of it moves. */
    .get("/:id/payoff", payoff, (c) => {
      const row = findPosition(db, c.req.param("id"));
      if (!row) throw notFound("position");
      // a curve is drawn at a credit; without one there is nothing honest to draw, and a holding's
      // live value is not its Entry (a watched spread's is drawn that way, and labelled so)
      if (row.entry === null) {
        throw httpError(422, `position '${row.name}' has no entry: record what was taken in to draw its payoff`);
      }
      const position = toPosition(row);
      return payoff.reply(c, 200, payoffAtExpiry(position.legs, row.entry, row.contracts));
    })

    /** The payoff at expiry of legs nobody holds yet (#291): the add form's preview, which catches a
     *  wrong leg sign before anything is saved (ADR 0023), and a watched spread drawn at its current
     *  value. A POST only because legs do not fit a query string: it writes NOTHING and asks the
     *  Provider NOTHING — a door scenario holds both, with a Provider that is down. */
    .post("/payoff", draft, valid("json", PayoffIn), (c) => {
      const p = c.req.valid("json");
      return draft.reply(c, 200, payoffAtExpiry(p.legs, p.entry, p.contracts ?? DEFAULT_CONTRACTS));
    })

    .post("/", create, valid("json", PositionIn), async (c) => {
      const p = c.req.valid("json");
      if (findPositionByName(db, p.name)) {
        throw httpError(409, `position '${p.name}' already exists`);
      }
      const row: PositionRow = {
        id: (deps.newId ?? newId)(),
        name: p.name,
        strategy: p.strategy ?? null,
        strike_date: p.strike_date,
        contracts: p.contracts ?? DEFAULT_CONTRACTS,
        entry: p.entry ?? null,
        legs: toSqliteJson(p.legs),
        created_at: toSqlDatetime(deps.now()),
        opened_at: p.opened_at ?? null,
        manage_notified_at: null,
        // recorded as held; closing it later is a state of this row, not its removal (ADR 0022)
        closed_on: null,
        exit: null,
      };
      // strict gate, as for monitors: nothing enters the table unverified
      const codes = [...new Set(positionLegCodes(toPosition(row)))].sort();
      const error = await verifyContracts(codes, deps.provider.fetchQuotes);
      if (error) throw httpError(422, error);

      const saved = await atomic(db, () => {
        const inserted = insertPosition(db, row);
        // a holding you have just recorded may be the one an existing rule was already watching
        adoptOrphanMonitors(db);
        return inserted;
      });
      return create.reply(c, 201, out(saved));
    })

    /** Record what was taken in, after the fact. */
    .patch("/:id", update, valid("json", PositionPatch), (c) => {
      const given = c.req.valid("json");
      if (Object.keys(given).length === 0) throw httpError(422, "nothing to update");
      const id = c.req.param("id");
      const row = findPosition(db, id);
      if (!row) throw notFound("position");
      // An exit and a close day belong to a closed holding, and are corrected here — a mistyped
      // close is otherwise fixable only by deleting, which loses the samples (ADR 0022). On a
      // holding still held they would half-close it, so they are refused.
      if (row.closed_on === null && (given.exit !== undefined || given.closed_on !== undefined)) {
        throw httpError(422, `position '${row.name}' is not closed: close it first`);
      }
      if (row.closed_on !== null) {
        // the close's own bounds, against whatever this request leaves Opened at
        const fault = closedOnFault(
          row, given.closed_on ?? row.closed_on, given.opened_at ?? row.opened_at,
          marketDate(deps.now()),
        );
        if (fault) throw httpError(422, fault);
      }
      const changes: Partial<PositionRow> = {};
      if (given.entry !== undefined) changes.entry = given.entry;
      if (given.contracts !== undefined) changes.contracts = given.contracts;
      if (given.strategy !== undefined) changes.strategy = given.strategy;
      if (given.opened_at !== undefined) changes.opened_at = given.opened_at;
      if (given.exit !== undefined) changes.exit = given.exit;
      if (given.closed_on !== undefined) changes.closed_on = given.closed_on;
      return update.reply(c, 200, out(updatePositionFields(db, id, changes)));
    })

    /** Close a holding: it is no longer held, and it is KEPT (ADR 0022).
     *
     *  Until this existed the only way off the dashboard was DELETE, which takes the daily samples
     *  with it — and a closed trade's history is exactly what a review of past trades reads. So a
     *  close is a state of the row: the legs, the entry and the samples stay, and everything live
     *  stops looking at it (`openPositions`).
     *
     *  No market call. The exit is the owner's to say — the dashboard prefills it from the Cost to
     *  close it is already showing — and a close after the expiry could not be priced anyway.
     */
    .post("/:id/close", close, valid("json", ClosePositionIn), async (c) => {
      const id = c.req.param("id");
      const given = c.req.valid("json");
      const row = findPosition(db, id);
      if (!row) throw notFound("position");
      if (row.closed_on !== null) throw httpError(409, `position '${row.name}' is already closed`);

      // Today in the market's reckoning, as Opened is — or the expiry, if that came first: nothing
      // is held past one, so an iron condor that expired worthless last week and is only told to
      // the app today was closed on its expiry, not today. ISO dates compare as text.
      const today = marketDate(deps.now());
      const closedOn = given.closed_on ?? (row.strike_date < today ? row.strike_date : today);
      const fault = closedOnFault(row, closedOn, row.opened_at, today);
      if (fault) throw httpError(422, fault);

      const disabled = await atomic(db, () => {
        const watchers = monitorsWatching(db, id);
        updatePositionFields(db, id, { closed_on: closedOn, exit: given.exit ?? null });
        // The rules stop claiming the holding, exactly as a DELETE leaves them: nothing alive is
        // ever valued against a closed holding, because nothing alive is ever linked to one. A rule
        // spanning two holdings keeps its link to the one still held.
        clearPositionLinks(db, id);
        // ...then the delete path's two steps, for the delete path's reason: a rule this orphaned
        // may watch a contract ANOTHER holding still holds — a roll leaves the old and the new
        // sharing a strike — and it is handed to that one; one that cannot be placed stops
        // claiming a scope. Adoption looks only at OPEN holdings, so never back onto this one.
        adoptOrphanMonitors(db);
        clearScopeOfOrphans(db);

        // Only THEN is it decided which rules go off. Deciding first was a bug a review found: a
        // rule switched off here and then adopted by the rolled holding was the new trade's alarm,
        // silenced as "holding-closed" with no notice. So a rule goes off when something it names
        // is no longer held by anything open: a leg rule on the closed holding alone, and a rule
        // spanning two holdings when either closes, since its figure would now include legs
        // nobody holds (ADR 0004, ADR 0022). One already off keeps its own reason — the owner's
        // "manual", or the engine's quarantine — so the close neither claims it nor hides why.
        const held = heldCodes(db);
        const taken: { id: string; code: string }[] = [];
        const reason: DisabledReason = "holding-closed";
        for (const monitor of watchers) {
          if (!monitor.enabled || stillHeld(monitor, held)) continue;
          updateMonitorFields(db, monitor.id, { enabled: toSqliteBool(false), disabled_reason: reason });
          taken.push({ id: monitor.id, code: monitor.code });
        }
        return taken;
      });
      return close.reply(c, 200, { ...out(findPosition(db, id)!), disabled_monitors: disabled });
    })

    .delete("/:id", remove, async (c) => {
      const id = c.req.param("id");
      if (!findPosition(db, id)) throw notFound("position");
      // the same foreign-key fault the monitor side had: monitor_positions is a plain table, so the
      // links must go first or the DELETE is refused. Every Position in the live database is linked,
      // so this was broken for all of them (#71).
      //
      // `position_samples` is the THIRD time this key has bitten — #71 here, #81 in the sweep's
      // expiry path, and then ADR 0011 added a child table without touching this line, which made
      // DELETE refuse for every Position the moment the first sweep gave each of them a sample.
      // Adding a table that references this one means coming back here.
      //
      // The Monitors survive — nothing here deletes a rule as a side effect. They simply stop knowing
      // what they were watching, and would be adopted again if the holding came back. The samples do
      // NOT: they describe this holding and mean nothing without it.
      //
      // ...and then the rules this delete just orphaned get a chance at whatever is LEFT. A link is
      // otherwise only ever worked out when something is created, so a rule that lost its holding
      // here stayed orphaned for ever — reported from the live dashboard as `409 position
      // '1120_BS_7100' already exists`, on a rule showing no positions beside a holding that had an
      // entry and an opened date and covered its contracts exactly. The dashboard offered to create
      // the holding it already had, because nothing told it one was there.
      //
      // Safe by adoptOrphanMonitors's own design: it looks only at monitors with no link and only
      // ever adds. "What you already have cannot be taken away by something you subsequently hold"
      // — nor by something you subsequently drop. Inside the transaction, so a rule is never left
      // pointing at a row that is half gone.
      await atomic(db, () => {
        clearPositionLinks(db, id);
        clearPositionSamples(db, id);
        deletePositionRow(db, id);
        adoptOrphanMonitors(db);
        // ...and whatever adoption could not place stops claiming a scope it has no holding for.
        //
        // The ORDER does not matter, though the first spelling of this comment claimed it did —
        // a mutation sweep swapped the two lines and nothing failed, which is how the claim was
        // found. It cannot matter: clearing skips anything with a link, and adoption always sets
        // a scope explicitly on what it places, so each line only ever touches rows the other
        // leaves alone. The link guard is the load-bearing part, not the sequence.
        clearScopeOfOrphans(db);
      });
      return c.body(null, 204);
    });
}
