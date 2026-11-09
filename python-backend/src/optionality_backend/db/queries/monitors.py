"""The monitors table: the rules the alarm engine evaluates. Port of backend/src/db/queries/monitors.ts.

Links to Positions are in `links.py` — they are a table of their own, and SQLite refuses to delete a
linked monitor until they are cleared, which is a fact about that table rather than about this one.
"""

import sqlite3
from typing import Any, cast

from ..rows import MonitorRow
from .sql import insert_row, row, rows, update_fields

#: The watchlist's order: expiry groups, combos before single legs, then calls before puts, then
#: strike. `legs is null` is 0 for a combo and 1 for a single leg, so ascending puts the combos first —
#: which is what the dashboard shows and what the bot's tables print.
#:
#: Two combos in the same expiry have no defined order between them, in either backend: both carry
#: option_type 'CMB' and strike 0.
WATCHLIST_ORDER = "order by strike_date, legs is null, option_type, strike"


def list_monitors(db: sqlite3.Connection) -> list[MonitorRow]:
    return cast(list[MonitorRow], rows(db, f"select * from monitors {WATCHLIST_ORDER}"))


def enabled_monitors(db: sqlite3.Connection, include_combos: bool) -> list[MonitorRow]:
    """Enabled monitors only, for the live `/quotes` family. Combos are excluded unless asked for
    because the bot's narrower tables cannot render a signed sum in four columns."""
    combos = "" if include_combos else "and legs is null"
    return cast(list[MonitorRow], rows(db, f"select * from monitors where enabled = 1 {combos} {WATCHLIST_ORDER}"))


def find_monitor(db: sqlite3.Connection, id_: str) -> MonitorRow | None:
    return cast(MonitorRow | None, row(db, "select * from monitors where id = ?", id_))


def find_monitor_by_code_field(
    db: sqlite3.Connection, code: str, field: str, except_id: str | None = None
) -> MonitorRow | None:
    """The (code, field) pair is unique. `except_id` is for an update, which must not conflict with
    itself."""
    if except_id:
        return cast(
            MonitorRow | None,
            row(db, "select * from monitors where code = ? and field = ? and id != ?", code, field, except_id),
        )
    return cast(MonitorRow | None, row(db, "select * from monitors where code = ? and field = ?", code, field))


def insert_monitor(db: sqlite3.Connection, value: MonitorRow) -> MonitorRow:
    insert_row(db, "monitors", value)
    # re-read, because the database applies the defaults for anything the row left unset
    return cast(MonitorRow, find_monitor(db, value["id"]))


def update_monitor_fields(db: sqlite3.Connection, id_: str, changes: dict[str, Any]) -> MonitorRow:
    """Update named columns of a monitor. The caller decides which, because PATCH changes only what it
    was given and PUT replaces a fixed set."""
    update_fields(db, "monitors", id_, changes)
    return cast(MonitorRow, find_monitor(db, id_))


def delete_monitor_row(db: sqlite3.Connection, id_: str) -> None:
    db.execute("delete from monitors where id = ?", (id_,))


def orphan_monitors(db: sqlite3.Connection) -> list[MonitorRow]:
    """Monitors with NO link at all. Deliberately not "monitors whose links look wrong": see
    adopt_orphan_monitors for why recomputing every link would be worse than the bug it fixed."""
    return cast(
        list[MonitorRow], rows(db, "select * from monitors where id not in (select monitor_id from monitor_positions)")
    )


def clear_scope_of_orphans(db: sqlite3.Connection) -> None:
    """Forget the scope of every monitor that no longer has a holding.

    Scope says HOW a rule covers its holding — "all" the whole structure, "leg" part of one — so it is
    meaningless without one. Deleting a holding cleared the links and left the scope behind, and the
    live US.SPXW261120C8200000 read scope "leg" while holding nothing at all.

    Only the link-less — which is what makes it safe beside adopt_orphan_monitors in either order, since
    adoption always sets a scope explicitly on what it places and so leaves nothing here to undo. Remove
    that guard and this wipes the scope of every monitor, holding or not."""
    db.execute(
        """update monitors set scope = null
     where scope is not null and id not in (select monitor_id from monitor_positions)"""
    )


def set_monitor_scope(db: sqlite3.Connection, id_: str, scope: str | None) -> None:
    db.execute("update monitors set scope = ? where id = ?", (scope, id_))


def find_monitors_by_identifier(
    db: sqlite3.Connection, token: str, joined: str, expanded_code: str | None
) -> list[MonitorRow]:
    """Monitors a bot identifier might mean: the exact code, the joined-and-upcased form, an id prefix,
    or a short contract like `260918 C8100`.

    Deliberately returns every match rather than the first. "Ambiguous" is an answer the owner can act
    on; silently picking one is how the wrong alarm gets deleted."""
    clauses = ["code = ?", "code = ?", "id like ?"]
    params: list[Any] = [joined, token, f"{token}%"]
    if expanded_code:
        clauses.append("code = ?")
        params.append(expanded_code)
    return cast(list[MonitorRow], rows(db, f"select * from monitors where {' or '.join(clauses)}", *params))


def find_combo_by_name(db: sqlite3.Connection, name: str) -> MonitorRow | None:
    return cast(MonitorRow | None, row(db, "select * from monitors where code = ? and legs is not null", name))
