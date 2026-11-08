/** `reference_securities`: the Securities kept on the page to read the market by (ADR 0018, 0019).
 *
 *  No update of any kind, which is the table's own rule rather than an omission: a Reference is a
 *  code, a label and a source, and changing any of them makes it a Reference about something
 *  else. Nothing auto-deletes one either — a Reference with no figure is a dash, not an event.
 */
import type { DatabaseSync } from "node:sqlite";

import type { ReferenceRow } from "../rows.ts";
import { insertRow, row, rows } from "./sql.ts";

/** Every Reference, oldest first (ADR 0018).
 *
 *  By `created_at` rather than by code or label: the strip reads left to right and the order the
 *  owner added them in is the only order they themselves chose. `code` breaks a tie, because two
 *  rows written in the same millisecond would otherwise have no defined order at all — and the
 *  strip would reshuffle between polls, which reads as a change.
 */
export function listReferences(db: DatabaseSync): ReferenceRow[] {
  return rows<ReferenceRow>(db, "select * from reference_securities order by created_at, code");
}

export function findReference(db: DatabaseSync, id: string): ReferenceRow | undefined {
  return row<ReferenceRow>(db, "select * from reference_securities where id = ?", id);
}

/** The code is unique: two References on one Security would be two figures that cannot differ. */
export function findReferenceByCode(db: DatabaseSync, code: string): ReferenceRow | undefined {
  return row<ReferenceRow>(db, "select * from reference_securities where code = ?", code);
}

export function insertReference(db: DatabaseSync, value: ReferenceRow): ReferenceRow {
  insertRow(db, "reference_securities", value);
  return findReference(db, value.id)!;
}

/** Remove a Reference. The only way one ever goes: nothing in the service deletes one as a side
 *  effect, and a Reference with no figure is a dash rather than an event (ADR 0018). */
export function deleteReferenceRow(db: DatabaseSync, id: string): void {
  db.prepare("delete from reference_securities where id = ?").run(id);
}
