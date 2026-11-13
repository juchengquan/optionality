/** Adding spreads in one step: each one's holding, when held, and the Monitors it starts with —
 *  all of it, or none of it (#293, ADR 0023).
 *
 *  The old dashboard made a condor in four requests, a rule and a holding per spread, and a refusal
 *  half way left half a condor behind. Here one request carries the lot, and nothing is written
 *  until everything has passed. The order is create-monitor.ts's, for its reason — everything free
 *  comes before the one step that leaves the machine:
 *
 *    1. what the request says about itself: more legs in all than one probe may ask for
 *       (`MAX_PROBE_LEGS`), a spread that would record nothing, a watched spread carrying a
 *       holding's figures, a rule on a leg the spread does not have, a threshold the rule
 *       refuses, a combo field that does not add up, a name or a rule given twice;
 *    2. the database: a holding of that name, a Monitor on that (code, field) already there;
 *    3. ONE probe of every leg of every spread, deduplicated — strict as POST /positions and
 *       POST /monitors are, so one Contract the Provider refuses refuses the whole request;
 *    4. one transaction: the holdings, then the Monitors, each linked to what holds its Contracts,
 *       then any older rule the new holdings now cover is adopted, as POST /positions does.
 *
 *  It never trades. The only call that leaves the machine is the bounded market-data probe the
 *  two older routes already make (CLAUDE.md's invariants).
 *
 *  Faults are values, with the status they answer as: this has one door, and the wording of every
 *  refusal the older routes share is theirs, word for word, so a form reads the same sentence
 *  whichever route refused it.
 */
import type { DatabaseSync } from "node:sqlite";

import { buildSpxCode } from "optionality/domain/contract";
import { comboFieldError, thresholdFault } from "optionality/domain/monitor";
import { positionsHolding } from "optionality/domain/position";
import { type QuoteFetcher, verifyContracts } from "optionality/quotes";
import { atomic } from "./db/open.ts";
import {
  clearMonitorLinks, deleteMonitorRow, findMonitorByCodeField, findPositionByName, insertMonitor,
  insertPosition, linkMonitorToPositions, positionsForMonitor, updateMonitorFields,
} from "./db/queries/index.ts";
import type { MonitorRow, PositionRow } from "./db/rows.ts";
import { toSqlDatetime } from "./db/time.ts";
import { newId, toSqliteJson } from "./db/values.ts";
import { toPosition } from "./hydrate.ts";
import { adoptOrphanMonitors, editedMonitor, linkToPositions } from "./monitors.ts";
import {
  DEFAULT_COMBO_FIELD, DEFAULT_COMPARE, DEFAULT_DIRECTION, DEFAULT_SINGLE_FIELD, thresholdError,
} from "./schemas/monitor.ts";
import { DEFAULT_CONTRACTS } from "./schemas/position.ts";
import { MAX_PROBE_LEGS } from "./schemas/spread.ts";

export interface SpreadDeps {
  db: DatabaseSync;
  fetchQuotes: QuoteFetcher;
  now: () => Date;
  /** the new rows' ids; uuids unless a door scenario states them (ADR 0021) */
  newId?: () => string;
}

export interface SpreadLeg {
  side: "short" | "long";
  option_type: "CALL" | "PUT";
  strike: number;
}

export interface SpreadMonitor {
  option_type?: "CALL" | "PUT";
  strike?: number;
  field?: string;
  threshold: number;
  direction?: string;
  compare?: string;
}

export interface Spread {
  name: string;
  legs: SpreadLeg[];
  held: boolean;
  entry?: number | null;
  contracts?: number;
  opened_at?: string | null;
  monitors: SpreadMonitor[];
}

export interface SpreadsInput {
  strike_date: string;
  spreads: Spread[];
}

export interface SpreadFault {
  status: 409 | 422;
  message: string;
}

/** What was added, by id: the page reads the book again rather than trusting an echo of it. And
 *  the watch rules a held spread replaced, which the form names before the save and after it. */
export interface Added {
  positions: { id: string; name: string }[];
  monitors: { id: string; code: string; field: string }[];
  replaced: { id: string; code: string; field: string }[];
}

export function isSpreadFault(result: Added | SpreadFault): result is SpreadFault {
  return "status" in result;
}

/** One Monitor, decided: its code, what it watches, and every column it will be written with. */
interface Planned {
  code: string;
  field: string;
  /** the Contracts it watches: the legs for the value, the one contract for a leg */
  contracts: string[];
  columns: Partial<MonitorRow>;
}

const refuse = (message: string, status: 409 | 422 = 422): SpreadFault => ({ status, message });

/** A Monitor of `spread`, as the row it would be, or why it cannot be. */
function plan(
  strikeDate: string, spread: Spread, m: SpreadMonitor, index: number,
): Planned | SpreadFault {
  const which = `monitor ${index + 1} of '${spread.name}'`;
  const onLeg = m.option_type !== undefined || m.strike !== undefined;
  const compare = m.compare ?? DEFAULT_COMPARE;
  const common = {
    threshold: m.threshold, direction: m.direction ?? DEFAULT_DIRECTION, compare,
  };

  if (onLeg) {
    if (m.option_type === undefined || m.strike === undefined) {
      return refuse(`${which} names a leg: give both its option_type and its strike`);
    }
    const { option_type: type, strike } = m;
    if (!spread.legs.some((l) => l.option_type === type && l.strike === strike)) {
      return refuse(`${which} watches ${type} ${strike}, which is not one of its legs`);
    }
    if (thresholdFault(compare, m.threshold)) return refuse(thresholdError(compare, m.threshold)!);
    const code = buildSpxCode(strikeDate, type, strike);
    const field = m.field ?? DEFAULT_SINGLE_FIELD;
    return {
      code, field, contracts: [code],
      columns: { code, strike_date: strikeDate, option_type: type, strike, field, ...common },
    };
  }

  if (spread.legs.length < 2) {
    return refuse(`'${spread.name}' has one leg, so its value is that contract's: watch the leg instead`);
  }
  const field = m.field ?? DEFAULT_COMBO_FIELD;
  const notAdditive = comboFieldError(field);
  if (notAdditive) return refuse(notAdditive);
  if (thresholdFault(compare, m.threshold)) return refuse(thresholdError(compare, m.threshold)!);
  // minus is short (ADR 0013): a credit spread's value is the negative of its cost to close, which
  // `compare: abs` is indifferent to
  const legs = spread.legs.map((l) => ({
    sign: l.side === "short" ? -1 : 1, option_type: l.option_type, strike: l.strike,
  }));
  return {
    code: spread.name, field,
    contracts: spread.legs.map((l) => buildSpxCode(strikeDate, l.option_type, l.strike)),
    columns: {
      code: spread.name, strike_date: strikeDate, option_type: "CMB", strike: 0, field,
      legs: toSqliteJson(legs), ...common,
    },
  };
}

/** Step 2, the database: the first clash it finds, or the watch rules a HELD spread replaces.
 *
 *  A planned Monitor whose (code, field) is already taken is a 409 — unless the spread is held and
 *  the rule in the way is linked to no holding: a WATCH rule on the candidate the owner has now
 *  sold, which the holding's own rule replaces (owner's decision, #322). One another holding owns
 *  is still a 409, and a watched spread never replaces anything. `replacing: false` asks for the
 *  409 alone, which is how a clash the write itself ran into is answered. */
function inTheWay(
  db: DatabaseSync, spreads: Spread[], planned: Planned[][], replacing: boolean,
): MonitorRow[] | SpreadFault {
  for (const spread of spreads) {
    if (spread.held && findPositionByName(db, spread.name)) {
      return refuse(`position '${spread.name}' already exists`, 409);
    }
  }
  const replaced: MonitorRow[] = [];
  for (const [i, spread] of spreads.entries()) {
    for (const p of planned[i]!) {
      const there = findMonitorByCodeField(db, p.code, p.field);
      if (!there) continue;
      const watching = positionsForMonitor(db, there.id).every((h) => h.closed_on !== null);
      if (!(replacing && spread.held && watching)) {
        return refuse(`monitor for (${p.code}, ${p.field}) already exists`, 409);
      }
      replaced.push(there);
    }
  }
  return replaced;
}

/** Two legs on one contract: a typo, or a leg that cancels itself. */
function twiceOver(spread: Spread): SpreadFault | null {
  const seen = new Map<string, SpreadLeg>();
  for (const l of spread.legs) {
    const key = `${l.option_type} ${l.strike}`;
    const before = seen.get(key);
    if (before) {
      return refuse(before.side === l.side
        ? `'${spread.name}' names ${key} twice`
        : `'${spread.name}' is both short and long ${key}`);
    }
    seen.set(key, l);
  }
  return null;
}

/** What a watch rule's alarm leaves the holding's rule that replaces it (#336): its state — the bell,
 *  when it last sent, the figure it last read — where the new rule watches the same figure the same
 *  way, as a PATCH moving the threshold alone keeps it (#292); nothing where it watches another way
 *  or the watch rule was off, as such a PATCH would forget it. One rule, `editedMonitor`'s, so the
 *  two doors cannot disagree. Remade fresh, a ringing rule would send "crossed" again next sweep. */
function carriedAlarm(was: MonitorRow | undefined, now: MonitorRow): Partial<MonitorRow> {
  if (!was) return {};
  const edited = editedMonitor(was, {
    field: now.field, direction: now.direction, compare: now.compare, threshold: now.threshold, enabled: now.enabled,
  });
  if (edited.triggered !== undefined) return {};
  return { triggered: was.triggered, last_alarm_at: was.last_alarm_at, last_value: was.last_value };
}

const isUniqueClash = (err: unknown) => err instanceof Error && /UNIQUE constraint failed/.test(err.message);

export async function createSpreads(deps: SpreadDeps, input: SpreadsInput): Promise<Added | SpreadFault> {
  const { db } = deps;
  const date = input.strike_date;

  // 1. what the request says about itself, starting with its size: the one probe is bounded
  const legCount = input.spreads.reduce((n, s) => n + s.legs.length, 0);
  if (legCount > MAX_PROBE_LEGS) {
    return refuse(`this request has ${legCount} legs: at most ${MAX_PROBE_LEGS} in one request`);
  }
  const names = new Set<string>();
  const planned: Planned[][] = [];
  const watched = new Set<string>();
  for (const spread of input.spreads) {
    if (!spread.held && spread.monitors.length === 0) {
      return refuse(`'${spread.name}' is neither held nor watched: nothing would be recorded`);
    }
    const holdingFigures = (spread.entry !== undefined && spread.entry !== null)
      || spread.contracts !== undefined || (spread.opened_at !== undefined && spread.opened_at !== null);
    if (!spread.held && holdingFigures) {
      return refuse(`'${spread.name}' is watched, not held: an entry, a count and an Opened belong to a holding`);
    }
    if (names.has(spread.name)) return refuse(`'${spread.name}' is named twice`);
    names.add(spread.name);
    const twice = twiceOver(spread);
    if (twice) return twice;
    const mine: Planned[] = [];
    for (const [i, m] of spread.monitors.entries()) {
      const p = plan(date, spread, m, i);
      if ("status" in p) return p;
      const key = `${p.code}\u0000${p.field}`;
      if (watched.has(key)) return refuse(`the monitor for (${p.code}, ${p.field}) is given twice`);
      watched.add(key);
      mine.push(p);
    }
    planned.push(mine);
  }

  // 2. the database
  const replacing = inTheWay(db, input.spreads, planned, true);
  if ("status" in replacing) return replacing;

  // 3. one probe, last: the one step that leaves the machine
  const codes = [...new Set(input.spreads.flatMap((s) =>
    s.legs.map((l) => buildSpxCode(date, l.option_type, l.strike))))].sort();
  const missing = await verifyContracts(codes, deps.fetchQuotes);
  if (missing) return refuse(missing);

  // 4. all of it, in one transaction
  const id = deps.newId ?? newId;
  const createdAt = toSqlDatetime(deps.now());
  try {
    return await atomic(db, () => write(db, input, planned, replacing, id, createdAt));
  } catch (err) {
    // Something got in after the checks — a second save of the same spread, landing between this
    // one's checks and its transaction. The transaction is rolled back, and the clash is answered
    // as the checks would have answered it, rather than as a 500.
    if (!isUniqueClash(err)) throw err;
    const clash = inTheWay(db, input.spreads, planned, false);
    if ("status" in clash) return clash;
    throw err;
  }
}

function write(
  db: DatabaseSync, input: SpreadsInput, planned: Planned[][], replacing: MonitorRow[],
  id: () => string, createdAt: string,
): Added {
  const date = input.strike_date;
  const added: Added = {
    positions: [], monitors: [],
    replaced: replacing.map((m) => ({ id: m.id, code: m.code, field: m.field })),
  };
  // the watch rules a held spread replaces go first, so their (code, field) is free: a deletion the
  // owner asked for by saving, not one the service decided on (CLAUDE.md's retention invariant)
  for (const m of replacing) {
    clearMonitorLinks(db, m.id);
    deleteMonitorRow(db, m.id);
  }
  const links: { monitorId: string; contracts: string[]; holding: PositionRow | null }[] = [];
  for (const [i, spread] of input.spreads.entries()) {
    let holding: PositionRow | null = null;
    if (spread.held) {
      holding = {
        id: id(),
        name: spread.name,
        strategy: null,
        strike_date: date,
        contracts: spread.contracts ?? DEFAULT_CONTRACTS,
        entry: spread.entry ?? null,
        legs: toSqliteJson(spread.legs.map((l) => ({
          side: l.side, option_type: l.option_type, strike: l.strike,
        }))),
        created_at: createdAt,
        opened_at: spread.opened_at ?? null,
        manage_notified_at: null,
        closed_on: null,
        exit: null,
      };
      insertPosition(db, holding);
      added.positions.push({ id: holding.id, name: holding.name });
    }
    for (const p of planned[i]!) {
      const row = {
        id: id(), code: "", strike_date: "", option_type: "", strike: 0, field: "", threshold: 0,
        direction: DEFAULT_DIRECTION, compare: DEFAULT_COMPARE, legs: null, scope: null,
        enabled: 1, disabled_reason: null, triggered: 0, last_value: null, last_checked_at: null,
        last_alarm_at: null, created_at: createdAt, ...p.columns,
      } as MonitorRow;
      Object.assign(row, carriedAlarm(replacing.find((m) => m.code === p.code && m.field === p.field), row));
      insertMonitor(db, row);
      added.monitors.push({ id: row.id, code: p.code, field: p.field });
      links.push({ monitorId: row.id, contracts: p.contracts, holding });
    }
  }
  for (const { monitorId, contracts, holding } of links) {
    if (holding) {
      // A held spread's rules are ITS rules, so they are linked to it and to nothing else, scoped
      // as against that one holding. Worked out against the whole book, a contract another open
      // holding shares — a neighbouring spread, or scaling in on the same strikes — reads as
      // ambiguous, and the new holding's own stop and delta rule came out linked to nothing.
      const { found, scope } = positionsHolding([toPosition(holding)], contracts);
      if (found.size === 0) continue;
      updateMonitorFields(db, monitorId, { scope });
      linkMonitorToPositions(db, monitorId, [...found]);
    } else {
      // a watched spread's rule is linked as POST /monitors links one: to whatever holds its contracts
      linkToPositions(db, monitorId, contracts);
    }
  }
  // and a rule set before these holdings were recorded is adopted by them, as POST /positions does
  adoptOrphanMonitors(db);
  return added;
}
