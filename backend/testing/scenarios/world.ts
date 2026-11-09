/** A scenario's world, made real: a database holding exactly its rows, vendors that answer from
 *  its tables, a clock that says what it says, and ids minted in a stated order.
 *
 *  Nothing here knows a door. `doors.ts` builds the service's three entrypoints on top of this,
 *  and the split is what keeps this half reusable by anything that wants the world without the
 *  service — and keeps the engine's seam declared for one file rather than two.
 *
 *  Deterministic BY INJECTION, never by scrubbing: the clock and the id minter are handed to the
 *  service (`Deps.now`, `Deps.newId`), so what a scenario file records is what the service
 *  actually wrote, not a placeholder standing where a random value was.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { createDatabase } from "../../src/db/open.ts";
import { type Settings, settingsFromEnv } from "../../src/env.ts";
import type { QuoteFetcher } from "optionality/quotes";
import {
  type Calls, type Diff, JSON_COLUMNS, type Row, TABLES, type TableName, type Tables,
  type Vendor, type World, columnsOf, primaryKeys,
} from "./format.ts";

/** The n-th id minted during the event: n in hexadecimal, zero-padded to the 32 characters of the
 *  uuid4 hex the service otherwise mints. Counted from 1, per scenario. */
export const mintedId = (n: number) => n.toString(16).padStart(32, "0");

export interface OpenWorld {
  db: DatabaseSync;
  settings: Settings;
  /** what the clock says now; moved by `doors.ts` for each earlier sweep */
  clock: { now: Date };
  newId(): string;
  /** the Provider's port, and what it answers to a probe */
  provider: { name: string; fetchQuotes: QuoteFetcher; reachable(): Promise<boolean> };
  /** every vendor by name, the Provider among them under its own, as `openVendors` assembles */
  sources: Record<string, QuoteFetcher>;
  /** whether the Provider is failing right now, and with what: an earlier sweep may say so */
  outage: { down: string | null };
  /** the Telegram transport: what it delivered, in order */
  send(text: string): void;
  sent: string[];
  calls: Calls;
  close(): void;
}

/** A vendor that answers from its table, recording every call. See `Vendor` for the rules. */
function fakeVendor(
  name: string, table: Vendor, calls: Calls, outage: () => string | null,
): QuoteFetcher {
  return async (codes) => {
    (calls[name] ??= []).push([...codes]);
    const down = outage();
    if (down !== null) throw new Error(down);
    const rejected = codes.find((c) => c in table.rejects);
    if (rejected !== undefined) throw new Error(table.rejects[rejected]);
    return {
      records: codes.filter((c) => c in table.quotes).map((c) => ({ code: c, ...table.quotes[c] })),
      unknown: codes.filter((c) => table.unknown.includes(c)),
    };
  };
}

function encode(table: TableName, column: string, value: unknown): unknown {
  if (!JSON_COLUMNS[table]?.includes(column) || value === null) return value;
  return JSON.stringify(value);
}

function decode(table: TableName, column: string, value: unknown): unknown {
  if (!JSON_COLUMNS[table]?.includes(column) || value === null) return value;
  return JSON.parse(String(value)) as unknown;
}

/** Every row of every table, keyed and ordered by primary key, columns in schema order. */
export function dumpTables(db: DatabaseSync): Tables {
  const keys = primaryKeys(db);
  const columns = columnsOf(db);
  const out = {} as Tables;
  for (const table of TABLES) {
    const found = db.prepare(`select * from ${table} order by ${keys[table].join(", ")}`).all();
    out[table] = found.map((row) => Object.fromEntries(
      columns[table].map((c) => [c, decode(table, c, (row as Row)[c])]),
    ));
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What happened to the tables, by primary key: rows added (whole), rows changed (the columns that
 *  moved, before and after), rows removed (their keys). Tables nothing happened to are left out. */
export function diffTables(db: DatabaseSync, before: Tables, after: Tables): Diff {
  const keys = primaryKeys(db);
  const diff: Diff = {};
  for (const table of TABLES) {
    const keyOf = (row: Row) => Object.fromEntries(keys[table].map((k) => [k, row[k]]));
    const index = (rows: Row[]) => new Map(rows.map((r) => [JSON.stringify(keyOf(r)), r]));
    const was = index(before[table] ?? []);
    const now = index(after[table] ?? []);
    const added = [...now].filter(([k]) => !was.has(k)).map(([, r]) => r);
    const removed = [...was].filter(([k]) => !now.has(k)).map(([, r]) => keyOf(r));
    const changed = [...now].filter(([k]) => was.has(k)).flatMap(([, r]) => {
      const old = was.get(JSON.stringify(keyOf(r)))!;
      const moved = Object.keys(r).filter((c) => !same(old[c], r[c]));
      if (moved.length === 0) return [];
      return [{
        key: keyOf(r),
        from: Object.fromEntries(moved.map((c) => [c, old[c]])),
        to: Object.fromEntries(moved.map((c) => [c, r[c]])),
      }];
    });
    if (added.length + removed.length + changed.length === 0) continue;
    diff[table] = {
      ...(added.length > 0 ? { added } : {}),
      ...(changed.length > 0 ? { changed } : {}),
      ...(removed.length > 0 ? { removed } : {}),
    };
  }
  return diff;
}

/** The world, opened: a fresh database from `schema.sql` holding exactly `world.tables`, and the
 *  fakes the service is built on. Closing it removes the database. */
export function openWorld(world: World): OpenWorld {
  const dir = mkdtempSync(join(tmpdir(), "optionality-scenario-"));
  const db = createDatabase(join(dir, "scenario.db"));
  const close = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    fill(db, world.tables);
  } catch (err) {
    close();
    throw err;
  }

  const calls: Calls = {};
  const outage = { down: world.provider.down };
  const provider = {
    name: world.provider.name,
    fetchQuotes: fakeVendor(world.provider.name, world.provider, calls, () => outage.down),
    reachable: () => Promise.resolve(world.provider.reachable),
  };
  const sources: Record<string, QuoteFetcher> = { [provider.name]: provider.fetchQuotes };
  for (const [name, table] of Object.entries(world.sources)) {
    sources[name] = fakeVendor(name, table, calls, () => table.down);
  }

  let minted = 0;
  const sent: string[] = [];
  return {
    db,
    settings: settingsFromEnv(world.settings),
    clock: { now: new Date(world.clock) },
    newId: () => mintedId(++minted),
    provider,
    sources,
    outage,
    send: (text) => {
      if (world.telegram === "down") throw new Error("telegram is down");
      sent.push(text);
    },
    sent,
    calls,
    close,
  };
}

/** The world's rows, inserted — and checked, because a row the database stores differently from
 *  how the file says it (a number as text, a missing column) is a scenario describing a world
 *  nobody can build. */
function fill(db: DatabaseSync, tables: Tables): void {
  const columns = columnsOf(db);
  for (const table of TABLES) {
    for (const row of tables[table] ?? []) {
      const missing = columns[table].filter((c) => !(c in row));
      const extra = Object.keys(row).filter((c) => !columns[table].includes(c));
      if (missing.length + extra.length > 0) {
        throw new Error(`a ${table} row must name every column and no other: `
          + `missing ${missing.join(", ") || "none"}, unknown ${extra.join(", ") || "none"}`);
      }
      const holes = columns[table].map(() => "?").join(", ");
      db.prepare(`insert into ${table} (${columns[table].join(", ")}) values (${holes})`)
        .run(...(columns[table].map((c) => encode(table, c, row[c])) as never[]));
    }
  }
  // compared row by row on the primary key rather than as text, so neither the order of the rows
  // nor the order of a row's columns is part of the format — only what the database holds
  const astray = diffTables(db, tables, dumpTables(db));
  if (Object.keys(astray).length > 0) {
    throw new Error("the database does not hold the rows the scenario states — write them as "
      + `it stores them:\n${JSON.stringify(astray, null, 2)}`);
  }
}
