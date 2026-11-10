"""The positions table: what is actually held. Port of backend/src/db/queries/positions.ts.

A Position exists whether or not anything watches it, and nothing in this service deletes one as a
side effect (ADR 0001) — which is why there is no "delete the positions of" anything here, only a
delete by id that a route asks for explicitly.
"""

import sqlite3
from typing import Any, cast

from ..rows import PositionRow
from .sql import insert_row, row, rows, update_fields


def list_positions(db: sqlite3.Connection) -> list[PositionRow]:
    """Every position, in the order the dashboard lists them: expiry groups, then name.

    One function, not two. There were briefly two with identical SQL — one for the listing route and
    one for the linkage code that does not care about order — and the duplicate hid a mutation:
    breaking the order in one left the other intact, so no test noticed."""
    return cast(list[PositionRow], rows(db, "select * from positions order by strike_date, name"))


def open_positions(db: sqlite3.Connection) -> list[PositionRow]:
    """The positions still HELD — every one not closed — in the same order.

    Not the duplicate `list_positions`'s docstring warns about: the two differ in what they answer, not
    only in how. A closed holding is kept with its history (ADR 0022), so everything that asks "what do I
    hold right now" — the sweep's batch and its samples, the valuation, a rule looking for the holding it
    watches — must ask this, and only the listing asks for everything."""
    return cast(
        list[PositionRow],
        rows(db, "select * from positions where closed_on is null order by strike_date, name"),
    )


def find_position(db: sqlite3.Connection, id_: str) -> PositionRow | None:
    return cast(PositionRow | None, row(db, "select * from positions where id = ?", id_))


def find_position_by_name(db: sqlite3.Connection, name: str) -> PositionRow | None:
    return cast(PositionRow | None, row(db, "select * from positions where name = ?", name))


def insert_position(db: sqlite3.Connection, value: PositionRow) -> PositionRow:
    insert_row(db, "positions", value)
    return cast(PositionRow, find_position(db, value["id"]))


def update_position_fields(db: sqlite3.Connection, id_: str, changes: dict[str, Any]) -> PositionRow:
    update_fields(db, "positions", id_, changes)
    return cast(PositionRow, find_position(db, id_))


def delete_position_row(db: sqlite3.Connection, id_: str) -> None:
    db.execute("delete from positions where id = ?", (id_,))


def set_position_entry(db: sqlite3.Connection, id_: str, entry: float) -> None:
    db.execute("update positions set entry = ? where id = ?", (entry, id_))


def stamp_manage_notified(db: sqlite3.Connection, id_: str, at: str) -> None:
    """Stamp a Position as having had its manage-by notice, so it is said once and not once a sweep."""
    db.execute("update positions set manage_notified_at = ? where id = ?", (at, id_))
