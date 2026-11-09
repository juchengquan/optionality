"""`reference_securities`: the Securities kept on the page to read the market by (ADR 0018, 0019). Port
of backend/src/db/queries/references.ts.

No update of any kind, which is the table's own rule rather than an omission: a Reference is a code, a
label and a source, and changing any of them makes it a Reference about something else. Nothing
auto-deletes one either — a Reference with no figure is a dash, not an event.
"""

import sqlite3
from typing import cast

from ..rows import ReferenceRow
from .sql import insert_row, row, rows


def list_references(db: sqlite3.Connection) -> list[ReferenceRow]:
    """Every Reference, oldest first (ADR 0018).

    By `created_at` rather than by code or label: the strip reads left to right and the order the owner
    added them in is the only order they themselves chose. `code` breaks a tie, because two rows written
    in the same millisecond would otherwise have no defined order at all — and the strip would reshuffle
    between polls, which reads as a change.
    """
    return cast(list[ReferenceRow], rows(db, "select * from reference_securities order by created_at, code"))


def find_reference(db: sqlite3.Connection, id_: str) -> ReferenceRow | None:
    return cast(ReferenceRow | None, row(db, "select * from reference_securities where id = ?", id_))


def find_reference_by_code(db: sqlite3.Connection, code: str) -> ReferenceRow | None:
    """The code is unique: two References on one Security would be two figures that cannot differ."""
    return cast(ReferenceRow | None, row(db, "select * from reference_securities where code = ?", code))


def insert_reference(db: sqlite3.Connection, value: ReferenceRow) -> ReferenceRow:
    insert_row(db, "reference_securities", value)
    return cast(ReferenceRow, find_reference(db, value["id"]))


def delete_reference_row(db: sqlite3.Connection, id_: str) -> None:
    """Remove a Reference. The only way one ever goes: nothing in the service deletes one as a side
    effect, and a Reference with no figure is a dash rather than an event (ADR 0018)."""
    db.execute("delete from reference_securities where id = ?", (id_,))
