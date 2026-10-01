/** Converting between what SQLite stores and what TypeScript works in (ADR 0009, phase 4).
 *
 *  Booleans are the reason this file exists: node:sqlite REFUSES a JavaScript boolean as a bind
 *  value — "Provided value cannot be bound to SQLite parameter" — so every write of `enabled`,
 *  `triggered` or `notify` has to go through here. The Python's rows hold 0 and 1, and so must
 *  ours, or the file stops being one both can read.
 */

/** A boolean on its way into the database. */
export function toSqliteBool(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

/** A boolean on its way out. Anything non-zero is true, which is what SQLAlchemy does. */
export function fromSqliteBool(value: number): boolean {
  return value !== 0;
}

/** JSON on its way into the database.
 *
 *  Note the Python writes `[{"sign": -1, ...}]` with spaces after the separators, and 8050.0
 *  rather than 8050; JSON.stringify writes neither. The values are the same and both sides parse
 *  the other's text, so new rows will look different from copied ones. That is accepted, not
 *  overlooked: matching Python's repr would mean writing a JSON serialiser to imitate another
 *  language's formatting, and nothing reads these bytes except a JSON parser.
 */
export function toSqliteJson(value: unknown): string {
  return JSON.stringify(value);
}

export function fromSqliteJson<T>(value: string | null): T | null {
  return value === null ? null : (JSON.parse(value) as T);
}
