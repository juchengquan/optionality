"""Stored rows into the shapes the domain works in (ADR 0009, phase 5). Port of backend/src/hydrate.ts.

The split is deliberate: a row holds `legs` as JSON text and `enabled` as 0 or 1, because that is what
SQLite holds and what both backends write. The domain holds parsed legs and real booleans. One of the
two has to be converted, and doing it here means no row type ever claims to be something it is not and
no domain function ever parses JSON.

**Where the Python differs, and why.** The TypeScript's domain types are interfaces, so its conversion
is a CAST: legs that parse but are not legs — a leg with no sign, a side of "sold" — pass through, to
fail or not wherever they are first used. The library's are pydantic models, which validate, so the
same row is refused HERE, with a `pydantic.ValidationError` (a `ValueError`, as unparseable JSON's is).
Every caller that can meet a corrupt row hydrates inside the guard that quarantines what it cannot
read (`engine/sweeper.ts`: "unreadable"), so the outcome differs only for a row that parses into
nonsense — which the TypeScript sweeps, with a NaN where a sign should be, and the Python quarantines.
Only a hand edit, a bad import or a damaged restore produces one; the write paths validate.
"""

from optionality.monitor import Monitor
from optionality.position import Position

from .db.rows import MonitorRow, PositionRow
from .db.values import from_sqlite_json


def to_monitor(row: MonitorRow) -> Monitor:
    return Monitor(
        id=row["id"],
        code=row["code"],
        strike_date=row["strike_date"],
        option_type=row["option_type"],
        strike=row["strike"],
        field=row["field"],
        threshold=row["threshold"],
        direction=row["direction"],
        compare=row["compare"],
        legs=from_sqlite_json(row["legs"]),
    )


def to_position(row: PositionRow) -> Position:
    legs = from_sqlite_json(row["legs"])
    return Position(
        id=row["id"],
        name=row["name"],
        strategy=row["strategy"],
        opened_at=row["opened_at"],
        strike_date=row["strike_date"],
        contracts=row["contracts"],
        entry=row["entry"],
        legs=legs if legs is not None else [],
    )
