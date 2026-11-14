/** The schema as TypeScript sees it (ADR 0009, phase 4).
 *
 *  These are STORED shapes, not domain shapes: a BOOLEAN column is a number here because that is
 *  what SQLite holds and what the Python wrote, and a JSON column is the unparsed string. The
 *  domain types in src/domain are the parsed, meaningful versions; converting between them is
 *  what db/values.ts and db/time.ts are for. Keeping the two apart is deliberate — the moment a
 *  row type claims `enabled: boolean`, something has to be lying about what is in the file.
 *
 *  Choosing node:sqlite over Drizzle gave up one real thing: a schema declared once, in a form
 *  both the database and the types derive from. COLUMNS and the Exact checks below put that back.
 *  schema.sql is the database's truth, COLUMNS is the runtime's, and the interfaces are the
 *  compiler's; rows.test.ts ties the first two together and the compiler ties the last two. Change
 *  one without the others and something fails rather than drifts.
 */

/** Every column of every table, in the order schema.sql declares them. */
export const COLUMNS = {
  monitors: [
    "id", "code", "strike_date", "option_type", "strike", "field", "threshold", "direction",
    "compare", "legs", "scope", "enabled", "disabled_reason", "triggered", "last_value",
    "last_checked_at", "last_alarm_at", "created_at",
  ],
  positions: [
    "id", "name", "strategy", "strike_date", "contracts", "entry", "legs", "created_at",
    // appended, because ALTER TABLE adds at the end and a migrated database lists them here
    "opened_at", "manage_notified_at", "closed_on", "exit", "qty_corrected_at",
  ],
  position_samples: [
    "position_id", "observed_on", "dte", "cost_to_close",
    // appended, because ALTER TABLE adds at the end
    "legs_iv", "legs_vega", "legs_delta", "observed_at", "spx",
  ],
  monitor_positions: ["monitor_id", "position_id"],
  reference_securities: ["id", "code", "label", "source", "created_at"],
  /** bookkeeping: COLUMNS covers every table the schema creates, and a table left out of it is a
   *  table nothing checks (db/migrate.ts) */
  schema_migrations: ["name", "applied_at"],
} as const satisfies Record<string, readonly string[]>;

export type TableName = keyof typeof COLUMNS;

/** Which columns the database allows to be NULL.
 *
 *  A separate list because nullability is the half that bites at runtime: an interface that says
 *  `scope: string` for a column the database leaves empty produces code that reads a null as a
 *  string and only fails on the row that happens to have one. rows.test.ts checks this against
 *  the database, and the compiler checks it against the interfaces.
 */
export const NULLABLE = {
  monitors: [
    "legs", "scope", "disabled_reason", "last_value", "last_checked_at", "last_alarm_at",
  ],
  positions: [
    "strategy", "entry", "opened_at", "manage_notified_at", "closed_on", "exit", "qty_corrected_at",
  ],
  position_samples: ["cost_to_close", "legs_iv", "legs_vega", "legs_delta", "observed_at", "spx"],
  monitor_positions: [],
  reference_securities: ["label"],
  schema_migrations: [],
} as const satisfies Record<TableName, readonly string[]>;

export interface MonitorRow {
  id: string;
  code: string;
  strike_date: string;
  option_type: string;
  strike: number;
  field: string;
  threshold: number;
  /** "above" | "below" */
  direction: string;
  /** "abs" | "signed" */
  compare: string;
  /** JSON text, or null for a single-leg monitor */
  legs: string | null;
  /** "all" | "calls" | "puts" | "leg" | null */
  scope: string | null;
  /** 0 | 1 */
  enabled: number;
  /** DISABLED_REASONS, or null: "manual" | "expired" | "unknown-contract" | "no-figure"
   *  | "unreadable" | "holding-closed". See schemas/monitor.ts, which is where the list lives. */
  disabled_reason: string | null;
  /** 0 | 1 */
  triggered: number;
  last_value: number | null;
  last_checked_at: string | null;
  last_alarm_at: string | null;
  created_at: string;
}

export interface PositionRow {
  id: string;
  name: string;
  strategy: string | null;
  strike_date: string;
  contracts: number;
  entry: number | null;
  /** JSON text */
  legs: string;
  created_at: string;
  /** the day the Position was PUT ON, which created_at is not; null until someone says */
  opened_at: string | null;
  /** sent-once marker for the manage-by notice */
  manage_notified_at: string | null;
  /** the New York market day it was closed, or null while it is still held. A closed holding is
   *  KEPT, with its samples — closing is not deleting (ADR 0022) */
  closed_on: string | null;
  /** what was paid to close it, per contract, in points — Entry's counterpart. Null where the
   *  owner left it blank when closing; the holding is closed either way (ADR 0022) */
  exit: number | null;
  /** when a held leg's quantity was last corrected, UTC, or null if never (#359): a sample observed
   *  before it was summed under earlier quantities, and is kept as it was */
  qty_corrected_at: string | null;
}

/** A Reference: a Security kept on the page to read the market by (ADR 0018).
 *
 *  It never alarms, need not be held, and no rule reads one — so there is nothing here about a
 *  threshold, an enabled flag or a disabled reason. A Reference is never auto-disabled, never
 *  notified and never deleted: its absence is not an event, and quarantine does not transfer,
 *  because that is defined as a Monitor the service disabled because it cannot be EVALUATED and a
 *  Reference evaluates nothing.
 */
export interface ReferenceRow {
  id: string;
  /** a raw code, given rather than built: `buildSpxCode` cannot write `US.SPY` */
  code: string;
  /** what to call it, or null for "the code is its own name". Kept where `scale` went, and more
   *  useful than before: `^GSPC`, `US..SPX` and `SPX` are three vendors' names for one index. */
  label: string | null;
  /** the vendor that answers for this code — never "the Provider", which would change meaning
   *  the day OPTIONALITY_PROVIDER does, under the same unchanged label (ADR 0019) */
  source: string;
  created_at: string;
}

export interface SchemaMigrationRow {
  name: string;
  applied_at: string;
}

/** One observation of a Position's Cost to close, one per market day (ADR 0011). */
export interface PositionSampleRow {
  position_id: string;
  observed_on: string;
  dte: number;
  /** Null where a leg had no two-sided quote to price it — moomoo's 0/0 out of hours — on a row
   *  written for its vol readings, which the chain needs for every day (#380, migration 0012). An
   *  empty cost never replaces a stored one (`takesSample`). */
  cost_to_close: number | null;
  /** JSON text: contract code -> implied volatility. Null where not every leg was priced — a
   *  partial map would invite a vol figure computed from half a structure (ADR 0011). */
  legs_iv: string | null;
  /** JSON text: contract code -> vega, the weight legs_iv has to be combined with, since the legs
   *  of one structure do not share a vol. Null on the same all-or-nothing rule, and gated
   *  separately from legs_iv: a withheld vega does not make the IV reading untrue, and the IV is
   *  the half no later sweep can recover (ADR 0011). */
  legs_vega: string | null;
  /** JSON text: contract code -> delta, the risk the book is managed by. Null on the same
   *  all-or-nothing rule and gated on its own, like the vega: only knowable when observed. */
  legs_delta: string | null;
  /** When the sweep that wrote this row ran, UTC. Inside the sample hours it is the close or near
   *  it; outside them the row filled a day that had none, and a chart should say so (ADR 0011).
   *  Null on every row written before migration 0009. */
  observed_at: string | null;
  /** SPX's price as the writing sweep's batch implied it (`derivedSpx`, ADR 0024). Null where the
   *  batch could not give one, and on every row written before migration 0010. */
  spx: number | null;
}

export interface MonitorPositionRow {
  monitor_id: string;
  position_id: string;
}

/** Fails to compile unless the two sets of names are exactly the same. */
type Exact<A extends string, B extends string> = [A] extends [B]
  ? ([B] extends [A] ? true : { missingFromFirst: Exclude<B, A> })
  : { missingFromSecond: Exclude<A, B> };

type Checked<T extends true> = T;

/** The keys of a row type whose value may be null. */
type NullableKeys<T> = { [K in keyof T]-?: null extends T[K] ? K : never }[keyof T];

type _Monitors = Checked<Exact<keyof MonitorRow, (typeof COLUMNS.monitors)[number]>>;
type _Positions = Checked<Exact<keyof PositionRow, (typeof COLUMNS.positions)[number]>>;
type _MonitorPositions = Checked<
  Exact<keyof MonitorPositionRow, (typeof COLUMNS.monitor_positions)[number]>
>;
type _PositionSamples = Checked<
  Exact<keyof PositionSampleRow, (typeof COLUMNS.position_samples)[number]>
>;
type _References = Checked<
  Exact<keyof ReferenceRow, (typeof COLUMNS.reference_securities)[number]>
>;
type _SchemaMigrations = Checked<
  Exact<keyof SchemaMigrationRow, (typeof COLUMNS.schema_migrations)[number]>
>;

/** Compile-time proof that every interface above names exactly the columns COLUMNS does.
 *
 *  Exported so that `noUnusedLocals` keeps it alive: an unreferenced type alias is elided, and a
 *  check the compiler throws away is no check at all. Add a column to one place and not the other
 *  and `npm run typecheck` names the column that is missing and from which side.
 */
type _MonitorsNull = Checked<Exact<NullableKeys<MonitorRow> & string, (typeof NULLABLE.monitors)[number]>>;
type _PositionsNull = Checked<Exact<NullableKeys<PositionRow> & string, (typeof NULLABLE.positions)[number]>>;
type _MonitorPositionsNull = Checked<
  Exact<NullableKeys<MonitorPositionRow> & string, (typeof NULLABLE.monitor_positions)[number]>
>;
type _PositionSamplesNull = Checked<
  Exact<NullableKeys<PositionSampleRow> & string, (typeof NULLABLE.position_samples)[number]>
>;
type _ReferencesNull = Checked<
  Exact<NullableKeys<ReferenceRow> & string, (typeof NULLABLE.reference_securities)[number]>
>;
type _SchemaMigrationsNull = Checked<
  Exact<NullableKeys<SchemaMigrationRow> & string, (typeof NULLABLE.schema_migrations)[number]>
>;

/** Compile-time proof that every interface above names exactly the columns COLUMNS does, and
 *  marks nullable exactly the columns NULLABLE does.
 *
 *  Exported so that `noUnusedLocals` keeps it alive: an unreferenced type alias is elided, and a
 *  check the compiler throws away is no check at all. Add a column to one place and not the other
 *  and `npm run typecheck` names the column that is missing and from which side.
 */
export type SchemaChecks = [
  _Monitors, _Positions, _MonitorPositions, _PositionSamples, _References, _SchemaMigrations,
  _MonitorsNull, _PositionsNull, _MonitorPositionsNull, _PositionSamplesNull, _ReferencesNull,
  _SchemaMigrationsNull,
];
