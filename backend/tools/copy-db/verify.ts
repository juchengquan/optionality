/** Compare two databases field by field (ADR 0009, phase 4).
 *
 *  24 rows is small enough to verify COMPLETELY rather than by sampling — a luxury that will not
 *  exist again, so it is spent here rather than saved.
 *
 *  Exact equality, including type: a `1` where the source holds `"1"` is a divergence, because
 *  the Python reading this file back would get a string where it expects a boolean. The column
 *  order differs between the two (the live monitors table carries its columns in the order
 *  migrations appended them), so every comparison is by column NAME.
 */
import type { DatabaseSync } from "node:sqlite";

/** Copy and verify in this order: a child table's rows cannot be inserted before its parents,
 *  because foreign_keys is ON. */
export const TABLES = [
  "configs", "schedules", "runs", "monitors", "positions", "monitor_positions", "reports",
  "alembic_version",
] as const;

/** What to order each table by so that two databases are walked in the same sequence. */
const ORDER_BY: Record<string, string> = {
  configs: "id",
  schedules: "id",
  runs: "id",
  monitors: "id",
  positions: "id",
  monitor_positions: "monitor_id, position_id",
  reports: "run_id",
  alembic_version: "version_num",
};

type Row = Record<string, unknown>;

export function readTable(db: DatabaseSync, table: string): Row[] {
  return db.prepare(`select * from ${table} order by ${ORDER_BY[table]}`).all() as Row[];
}

export interface Divergence {
  table: string;
  row: string;
  detail: string;
}

export interface Result {
  divergences: Divergence[];
  /** how many individual field values were actually compared — the check on the check */
  compared: number;
  rows: number;
  perTable: Record<string, number>;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return `${typeof value} ${JSON.stringify(value)}`;
  return `${typeof value} ${String(value)}`;
}

/** Every table, every row, every field. */
export function verify(source: DatabaseSync, target: DatabaseSync): Result {
  const divergences: Divergence[] = [];
  const perTable: Record<string, number> = {};
  let compared = 0;
  let rows = 0;

  const tablesOf = (db: DatabaseSync) =>
    (db.prepare("select name from sqlite_master where type='table' order by name").all() as Row[])
      .map((r) => r.name as string);
  const sourceTables = tablesOf(source);
  const targetTables = tablesOf(target);
  if (sourceTables.join() !== targetTables.join()) {
    divergences.push({
      table: "(schema)", row: "-",
      detail: `tables differ: source [${sourceTables}] target [${targetTables}]`,
    });
  }

  for (const table of TABLES) {
    const a = readTable(source, table);
    const b = readTable(target, table);
    perTable[table] = a.length;
    rows += a.length;
    if (a.length !== b.length) {
      divergences.push({ table, row: "-", detail: `${a.length} rows in source, ${b.length} in target` });
      continue;
    }
    for (const [i, left] of a.entries()) {
      const right = b[i]!;
      const key = String(left[ORDER_BY[table]!.split(",")[0]!.trim()] ?? i);
      const leftKeys = Object.keys(left).sort();
      const rightKeys = Object.keys(right).sort();
      if (leftKeys.join() !== rightKeys.join()) {
        divergences.push({ table, row: key, detail: `columns differ: [${leftKeys}] vs [${rightKeys}]` });
        continue;
      }
      for (const column of leftKeys) {
        compared += 1;
        // Object.is, not ===, so that a NaN in a FLOAT column compares as itself and a -0 that
        // became 0 is reported rather than passed over
        if (!Object.is(left[column], right[column])) {
          divergences.push({
            table, row: key,
            detail: `${column}: source ${describe(left[column])} target ${describe(right[column])}`,
          });
        }
      }
    }
  }
  return { divergences, compared, rows, perTable };
}
