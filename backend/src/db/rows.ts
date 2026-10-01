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
  configs: ["id", "name", "task_type", "body", "created_at", "updated_at"],
  schedules: ["id", "cron_expr", "tz", "task_type", "config_name", "enabled"],
  runs: [
    "id", "task_type", "config_name", "trigger", "notify", "attempt", "status", "error",
    "created_at", "started_at", "finished_at",
  ],
  monitors: [
    "id", "code", "strike_date", "option_type", "strike", "field", "threshold", "direction",
    "compare", "legs", "scope", "enabled", "disabled_reason", "triggered", "last_value",
    "last_checked_at", "last_alarm_at", "created_at",
  ],
  positions: [
    "id", "name", "strategy", "strike_date", "contracts", "entry", "legs", "created_at",
  ],
  monitor_positions: ["monitor_id", "position_id"],
  reports: ["run_id", "summary", "html", "created_at"],
  alembic_version: ["version_num"],
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
  configs: [],
  schedules: [],
  runs: ["error", "started_at", "finished_at"],
  monitors: [
    "legs", "scope", "disabled_reason", "last_value", "last_checked_at", "last_alarm_at",
  ],
  positions: ["strategy", "entry"],
  monitor_positions: [],
  reports: [],
  alembic_version: [],
} as const satisfies Record<TableName, readonly string[]>;

export interface ConfigRow {
  id: number;
  name: string;
  task_type: string;
  /** JSON text */
  body: string;
  created_at: string;
  updated_at: string;
}

export interface ScheduleRow {
  id: number;
  cron_expr: string;
  tz: string;
  task_type: string;
  config_name: string;
  /** 0 | 1 */
  enabled: number;
}

export interface RunRow {
  id: string;
  task_type: string;
  config_name: string;
  /** "schedule" | "api" — a reserved word in SQL, quoted in the DDL */
  trigger: string;
  /** 0 | 1 */
  notify: number;
  attempt: number;
  status: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

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
  /** "manual" | "expired" | "unknown-contract" | null */
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
}

export interface MonitorPositionRow {
  monitor_id: string;
  position_id: string;
}

export interface ReportRow {
  run_id: string;
  /** JSON text */
  summary: string;
  html: string;
  created_at: string;
}

export interface AlembicVersionRow {
  version_num: string;
}

/** Fails to compile unless the two sets of names are exactly the same. */
type Exact<A extends string, B extends string> = [A] extends [B]
  ? ([B] extends [A] ? true : { missingFromFirst: Exclude<B, A> })
  : { missingFromSecond: Exclude<A, B> };

type Checked<T extends true> = T;

/** The keys of a row type whose value may be null. */
type NullableKeys<T> = { [K in keyof T]-?: null extends T[K] ? K : never }[keyof T];

type _Configs = Checked<Exact<keyof ConfigRow, (typeof COLUMNS.configs)[number]>>;
type _Schedules = Checked<Exact<keyof ScheduleRow, (typeof COLUMNS.schedules)[number]>>;
type _Runs = Checked<Exact<keyof RunRow, (typeof COLUMNS.runs)[number]>>;
type _Monitors = Checked<Exact<keyof MonitorRow, (typeof COLUMNS.monitors)[number]>>;
type _Positions = Checked<Exact<keyof PositionRow, (typeof COLUMNS.positions)[number]>>;
type _MonitorPositions = Checked<
  Exact<keyof MonitorPositionRow, (typeof COLUMNS.monitor_positions)[number]>
>;
type _Reports = Checked<Exact<keyof ReportRow, (typeof COLUMNS.reports)[number]>>;
type _Alembic = Checked<
  Exact<keyof AlembicVersionRow, (typeof COLUMNS.alembic_version)[number]>
>;

/** Compile-time proof that every interface above names exactly the columns COLUMNS does.
 *
 *  Exported so that `noUnusedLocals` keeps it alive: an unreferenced type alias is elided, and a
 *  check the compiler throws away is no check at all. Add a column to one place and not the other
 *  and `npm run typecheck` names the column that is missing and from which side.
 */
type _ConfigsNull = Checked<Exact<NullableKeys<ConfigRow> & string, (typeof NULLABLE.configs)[number]>>;
type _SchedulesNull = Checked<Exact<NullableKeys<ScheduleRow> & string, (typeof NULLABLE.schedules)[number]>>;
type _RunsNull = Checked<Exact<NullableKeys<RunRow> & string, (typeof NULLABLE.runs)[number]>>;
type _MonitorsNull = Checked<Exact<NullableKeys<MonitorRow> & string, (typeof NULLABLE.monitors)[number]>>;
type _PositionsNull = Checked<Exact<NullableKeys<PositionRow> & string, (typeof NULLABLE.positions)[number]>>;
type _MonitorPositionsNull = Checked<
  Exact<NullableKeys<MonitorPositionRow> & string, (typeof NULLABLE.monitor_positions)[number]>
>;
type _ReportsNull = Checked<Exact<NullableKeys<ReportRow> & string, (typeof NULLABLE.reports)[number]>>;
type _AlembicNull = Checked<
  Exact<NullableKeys<AlembicVersionRow> & string, (typeof NULLABLE.alembic_version)[number]>
>;

/** Compile-time proof that every interface above names exactly the columns COLUMNS does, and
 *  marks nullable exactly the columns NULLABLE does.
 *
 *  Exported so that `noUnusedLocals` keeps it alive: an unreferenced type alias is elided, and a
 *  check the compiler throws away is no check at all. Add a column to one place and not the other
 *  and `npm run typecheck` names the column that is missing and from which side.
 */
export type SchemaChecks = [
  _Configs, _Schedules, _Runs, _Monitors, _Positions, _MonitorPositions, _Reports, _Alembic,
  _ConfigsNull, _SchedulesNull, _RunsNull, _MonitorsNull, _PositionsNull, _MonitorPositionsNull,
  _ReportsNull, _AlembicNull,
];
