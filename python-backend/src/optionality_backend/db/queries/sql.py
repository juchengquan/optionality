"""The three things every query in this package was writing out by hand. Port of
backend/src/db/queries/sql.ts.

Collected here so that each table's module is SQL and the reason for it, not boilerplate. The shape a
row comes back in is the database's business and nothing can check it at the call — `rows` answers
dicts and the caller names the row type, held to schema.sql by `tests/db/test_rows.py` rather than
retyped per query.

**Where the Python differs, and why.** node:sqlite answers each row as an object; `sqlite3` answers
tuples unless the connection was given a row factory, so `rows` builds the dict itself from the
cursor's own column names and never depends on how the connection was opened. A row missing a column
is refused with a `KeyError` naming it, where node:sqlite says "cannot be bound" — the same refusal
for the same reason (see `insert_row`).
"""

import sqlite3
from typing import Any

from ..rows import COLUMNS, TableName


def rows(db: sqlite3.Connection, sql: str, *params: Any) -> list[dict[str, Any]]:
    """Every row a statement answers with, as a dict keyed by column, in the statement's order.

    The caller casts to the row type it names: the columns are schema.sql's business, and
    `tests/db/test_rows.py` is what ties the two together."""
    cursor = db.execute(sql, params)
    names = [d[0] for d in cursor.description]
    return [dict(zip(names, r, strict=True)) for r in cursor.fetchall()]


def row(db: sqlite3.Connection, sql: str, *params: Any) -> dict[str, Any] | None:
    """The first row, or None."""
    cursor = db.execute(sql, params)
    found = cursor.fetchone()
    if found is None:
        return None
    return dict(zip([d[0] for d in cursor.description], found, strict=True))


def insert_row(db: sqlite3.Connection, table: TableName, value: Any) -> None:
    """Insert every column the schema declares, in its order.

    Every column, not the ones that happen to be set: a row built by `blank()` carries all of them, and
    listing only the present keys would let a half-built row through as a row with defaults. The
    caller re-reads what it wrote, because SQLite applies the defaults."""
    columns = COLUMNS[table]
    # read before the statement is built, so a missing column refuses the row and writes nothing
    values = [value[c] for c in columns]
    db.execute(
        f"insert into {table} ({', '.join(f'"{c}"' for c in columns)})\n"
        f"     values ({', '.join('?' for _ in columns)})",
        values,
    )


def update_fields(db: sqlite3.Connection, table: TableName, id_: str, changes: dict[str, Any]) -> bool:
    """Update the named columns of one row by id, and say whether anything was written.

    The caller decides which columns, because PATCH changes only what it was given. False for an empty
    change set rather than a statement with no assignments, which SQLite rejects — and the callers use
    the answer to skip a pointless re-read."""
    keys = list(changes)
    if not keys:
        return False
    db.execute(
        f"update {table} set {', '.join(f'"{k}" = ?' for k in keys)} where id = ?",
        [*(changes[k] for k in keys), id_],
    )
    return True


def database_responds(db: sqlite3.Connection) -> bool:
    """Whether the database answers at all — /health reports rather than raising."""
    try:
        db.execute("select 1").fetchone()
        return True
    except Exception:  # noqa: BLE001 — whatever the failure, the answer is "no", which is the report
        return False
