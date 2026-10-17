/** The one place the stored datetime format is known (ADR 0009, phase 4).
 *
 *  Storage is SQLAlchemy's: UTC wall time as text, `2026-09-01 15:39:11.940183`, with no offset
 *  and six fractional digits. Keeping that format is what lets the Python open this file if the
 *  cutover has to be undone, so it is not an implementation detail to tidy up later.
 */
import { displayTime } from "../domain/timefmt.ts";

/** Format an instant the way the Python writes it. */
export function toSqlDatetime(when: Date = new Date()): string {
  const iso = when.toISOString(); // 2026-09-01T15:39:11.940Z — always UTC, always 3 digits
  // six digits with the last three zero: a Date has no finer resolution to offer, and the shape
  // stays identical to every row already in the file
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}000`;
}

const SQL_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/;

/** Read a stored datetime. */
export function fromSqlDatetime(value: string): Date {
  const m = SQL_DATETIME.exec(value);
  if (!m) throw new Error(`not a stored datetime: ${value}`);
  // truncated to milliseconds, not rounded — a Date cannot hold microseconds. Everything that
  // reads these compares them in seconds (the alarm cooldown, the sweep watchdog), so the lost
  // digits cannot change a decision; it is recorded here so nobody later assumes a round trip.
  const ms = (m[3] ?? "").padEnd(3, "0").slice(0, 3);
  // the Z is the point: without it, Date.parse reads this naive text as the machine's local time
  return new Date(`${m[1]}T${m[2]}.${ms}Z`);
}

/** A stored timestamp as the API reports it. Stored text in, display string out — the two
 *  conversions always travel together, and splitting them is how a naive parse creeps in.
 *
 *  Here rather than in domain/timefmt.ts, which is pure and canonical (the Python mirrors it):
 *  reading the storage format is the database's business, and the one thing this adds. */
export function displayStored(stored: string | null | undefined, tzName = ""): string | null {
  if (stored === null || stored === undefined) return null;
  return displayTime(fromSqlDatetime(stored), tzName);
}
