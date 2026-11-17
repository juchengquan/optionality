"""`sweep_interval`: the sweep's interval as the page set it, one row or none (#442, ADR 0025). Port of
backend/src/db/queries/sweep-interval.ts.

The one behaviour knob kept in the database. No row means `.env`'s MONITOR_INTERVAL_SECONDS, so "back
to the default" is a delete rather than a row that names the default — a row naming 15 would stay 15
after `.env` moved. What a stored value MEANS — a preset in force, or a hand-edit refused — is
`sweep_interval.py`'s, not this file's.
"""

import sqlite3
from typing import cast

from ..rows import SweepIntervalRow
from .sql import row


def read_sweep_interval(db: sqlite3.Connection) -> SweepIntervalRow | None:
    return cast(SweepIntervalRow | None, row(db, "select * from sweep_interval where id = 1"))


def write_sweep_interval(db: sqlite3.Connection, seconds: int, set_at: str) -> None:
    """The page's choice, replacing any before it: the table holds one row at most."""
    db.execute("insert or replace into sweep_interval (id, seconds, set_at) values (1, ?, ?)", (seconds, set_at))


def clear_sweep_interval(db: sqlite3.Connection) -> None:
    """Back to `.env`'s interval."""
    db.execute("delete from sweep_interval")
