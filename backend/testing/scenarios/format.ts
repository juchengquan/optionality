/** What a door scenario IS, as `testdata/scenarios/` holds it (ADR 0021, Decision 4).
 *
 *  Plain JSON that a person can read and could later write by hand, because the long run is a
 *  shared spec both backends meet (Decision 2). So nothing in here may lean on how the TypeScript
 *  happens to work: the world is rows as SQLite holds them, the settings are `.env` lines, the
 *  vendors are tables of figures, and every expectation is something a client, a phone or the
 *  database could see. `testdata/scenarios/README.md` says the same for a reader in another
 *  language, and it is the document — this file is the TypeScript's reading of it.
 */
import type { DatabaseSync } from "node:sqlite";

/** A row as the database holds it, column for column — except that the JSON columns below are
 *  written as the JSON they contain rather than as a string of it. */
export type Row = Record<string, unknown>;

/** Every table a scenario states, in the order rows can be inserted without breaking a foreign
 *  key. `schema_migrations` is deliberately not one: it is bookkeeping, stamped with the time a
 *  database was made, and no door reads it. */
export const TABLES = [
  "positions", "monitors", "monitor_positions", "position_samples", "watch_samples",
  "reference_securities", "sweep_interval",
] as const;
export type TableName = (typeof TABLES)[number];
export type Tables = Record<TableName, Row[]>;

/** The columns that hold JSON text. A scenario writes their CONTENT, so `legs` reads as a list
 *  rather than as an escaped string — and so the two backends are compared on the value and not
 *  on the bytes, which differ by design (`db/values.ts`: `8050` against `8050.0`). */
export const JSON_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  monitors: ["legs"],
  positions: ["legs"],
  position_samples: ["legs_iv", "legs_vega", "legs_delta"],
  watch_samples: ["legs_mid", "legs_iv", "legs_vega", "legs_delta"],
};

/** One market-data vendor, as a table of what it answers.
 *
 *  A call asks for some codes and gets, in this order of precedence: an error if `down` is set;
 *  an error naming the first requested code listed in `rejects` (moomoo's habit of refusing a
 *  whole batch over one code); otherwise a record for every requested code in `quotes`, the
 *  requested codes listed in `unknown` reported as unknown, and nothing at all for the rest —
 *  which is what "subscribed, nothing yet" looks like, and is not the same as unknown. */
export interface Vendor {
  quotes: Record<string, Record<string, unknown>>;
  unknown: string[];
  rejects: Record<string, string>;
  down: string | null;
}

/** What the Provider last read of the account's quote grade for US options (#464), as its client
 *  keeps it — the reading, not a GetUserInfo answer: the client reads that once per connection
 *  episode, which no single door event shows, and its own suites hold that rule. */
export interface QuoteGrade {
  /** moomoo's grade as the Python SDK names it; null while none has been read */
  us_option: string | null;
  /** what the grade means — the library's `isRealtime` of `us_option` — or null */
  realtime: boolean | null;
  /** when it was read, ISO 8601 in UTC; null with `us_option` */
  read_at: string | null;
  /** OpenD's words for why the latest read failed, or null; it leaves a grade read before it */
  failure: string | null;
}

/** The Provider: the one vendor the alarms read from. `reachable` is what its own port probe
 *  says, which `/health` consults only while no batch has been asked for. `quote_grade` is what it
 *  last read of the account's grade, or null for a Provider that reports none. */
export interface Provider extends Vendor {
  name: string;
  reachable: boolean;
  quote_grade: QuoteGrade | null;
}

/** A sweep that happened BEFORE the event, there to give the engine its memory — the run of
 *  failures, the silence counts — which lives in no table. It may not change a row: `tables` is
 *  the database as the event finds it. `down`, when set, is that sweep's Provider failing. */
export interface EarlierSweep {
  at: string;
  down: string | null;
}

/** IB Gateway's account watch (ADR 0031, #477), as a table of what it answers — the library
 *  client's, as a vendor's table states its batch: the wire is held by the client's own recorded
 *  conversations, and the choice of account and the masking by the library's cases.
 *
 *  A start asks for an account (`IBKR_ACCOUNT`, or none) and gets, in this order: unreachable with
 *  `lost.down`, if the connection has been lost by the clock and that is not null; unreachable with
 *  the words `down`, if it is not null; otherwise a refusal with the words `refused` (the library's,
 *  every id masked), if it is not null; otherwise a failure with the words `fails` (its deadline
 *  passing), if it is not null; otherwise a watch holding `account`. */
export interface IbkrAccountTable {
  /** no session with the gateway: the connect's words (the library's `IbkrUnreachable`) — a
   *  refused session's are shown, anything else is a gateway that did not answer */
  down: string | null;
  /** the library would not choose an account: its words */
  refused: string | null;
  /** connected, and the first picture does not come: its words */
  fails: string | null;
  /** the picture every watch holds, the library's `IbkrLiveAccount`, the id masked as the library
   *  masks it */
  account: Record<string, unknown> | null;
  /** the connection closing: from `at`, every watch started before `at` is lost with `words`, and
   *  a start is unreachable with `down` where that is not null; null, it never closes */
  lost: { at: string; words: string; down: string | null } | null;
}

/** The `calls` key a watch's start is recorded under, each as `[wanted]`, or `[]` for none. */
export const ACCOUNT_CALLS = "ibkr account";
/** The `calls` key a watch's stop is recorded under, each as `[]`. */
export const ACCOUNT_STOPS = "ibkr account stop";

export interface World {
  /** the instant the event happens at, ISO 8601 in UTC */
  clock: string;
  /** `.env` lines: the service's defaults everywhere this does not say otherwise */
  settings: Record<string, string>;
  provider: Provider;
  /** vendors a Reference may name beyond the Provider, which is a source under its own name too */
  sources: Record<string, Vendor>;
  /** IB Gateway's account watch; absent where IB Gateway is not configured (`IBKR_HOST` blank) */
  ibkr_account?: IbkrAccountTable;
  /** "down": every Telegram send fails */
  telegram: "up" | "down";
  sweeps: EarlierSweep[];
  tables: Tables;
}

/** A row that changed: its primary key, and the columns that moved, before and after. */
export interface Change {
  key: Row;
  from: Row;
  to: Row;
}

export interface TableDiff {
  added?: Row[];
  changed?: Change[];
  /** the primary keys of the rows that went */
  removed?: Row[];
}

/** Per table, only the tables something happened to. */
export type Diff = Partial<Record<TableName, TableDiff>>;

/** The codes each vendor was asked for, call by call, in order. */
export type Calls = Record<string, string[][]>;

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** sent as JSON, with `Content-Type: application/json`; null sends no body */
  body: unknown;
}

export interface HttpExpect {
  /** `body` is the parsed JSON, null for an empty one, and the raw text for anything else */
  response: { status: number; body: unknown };
  /** every Telegram message the request delivered, in order — absent where it delivered none, which
   *  is every request but an agent's write over MCP (ADR 0028) */
  messages?: string[];
  rows: Diff;
  calls: Calls;
}

/** A request made BEFORE the event, through the same service, for the memory it leaves that lives
 *  in no table — a shared batch, a cap's count (ADR 0027). Held, like an earlier sweep, to changing
 *  no row; its answer and its calls are not part of the expectation. */
export interface EarlierRequest {
  at: string;
  request: HttpRequest;
}

export interface HttpScenario {
  name: string;
  world: World;
  /** absent where there are none */
  earlier?: EarlierRequest[];
  request: HttpRequest;
  expect: HttpExpect;
}

/** A Telegram update, in Telegram's own shape. */
export interface Update {
  update_id: number;
  message: { chat: { id: number | string }; text: string };
}

export interface BotExpect {
  /** what the bot sent back, or null for no reply at all */
  reply: { chat_id: string; text: string; parse_mode: string | null } | null;
  rows: Diff;
  calls: Calls;
}

export interface BotScenario {
  name: string;
  world: World;
  update: Update;
  expect: BotExpect;
}

export interface SweepExpect {
  /** every Telegram message the tick delivered, in order */
  messages: string[];
  rows: Diff;
  calls: Calls;
}

export interface SweepScenario {
  name: string;
  /** what this tick demonstrates, from `outcomes.ts`'s list — checked, not trusted */
  outcomes: string[];
  world: World;
  expect: SweepExpect;
}

export type Door = "http" | "bot" | "sweep";
export const DOORS: readonly Door[] = ["http", "bot", "sweep"];

/** A scenario's file name: its name, lower-cased, with every run of anything else a hyphen. */
export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The bytes a scenario is written as: two-space JSON and a final newline, as the golden cases
 *  are. Key order is whatever the object was built in, which `world.ts` and `doors.ts` fix. */
export function render(scenario: unknown): string {
  return `${JSON.stringify(scenario, null, 2)}\n`;
}

/** Each table's primary key, read from the schema rather than written here, so a table whose key
 *  changes cannot be diffed on the old one. Asked of a throwaway database built from the same
 *  `schema.sql` every scenario's database is built from. */
export function primaryKeys(db: DatabaseSync): Record<TableName, string[]> {
  const out = {} as Record<TableName, string[]>;
  for (const table of TABLES) {
    const info = db.prepare(`pragma table_info(${table})`).all() as { name: string; pk: number }[];
    out[table] = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  }
  return out;
}

/** Each table's columns, in the order the schema declares them. */
export function columnsOf(db: DatabaseSync): Record<TableName, string[]> {
  const out = {} as Record<TableName, string[]>;
  for (const table of TABLES) {
    const info = db.prepare(`pragma table_info(${table})`).all() as { name: string }[];
    out[table] = info.map((c) => c.name);
  }
  return out;
}
