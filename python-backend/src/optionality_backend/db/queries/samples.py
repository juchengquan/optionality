"""`position_samples`: one observation of a holding per market day (ADR 0011). Port of
backend/src/db/queries/samples.ts.

The one thing in this database that cannot be re-entered (CLAUDE.md), which is why nothing here
deletes a sample except the delete that follows the holding it belongs to — the foreign key says they
are its, and a series of what-this-was-worth means nothing once the holding is gone.
"""

import sqlite3
from typing import cast

from ..rows import PositionSampleRow
from .sql import row, rows


def list_position_samples(db: sqlite3.Connection, id_: str) -> list[PositionSampleRow]:
    """Every sample for one Position, oldest first — the order a day-by-day measurement needs."""
    return cast(
        list[PositionSampleRow],
        rows(db, "select * from position_samples where position_id = ? order by observed_on", id_),
    )


def clear_position_samples(db: sqlite3.Connection, id_: str) -> None:
    db.execute("delete from position_samples where position_id = ?", (id_,))


def record_position_sample(db: sqlite3.Connection, value: PositionSampleRow) -> None:
    """One observation of a Position's Cost to close, keyed on the market day (ADR 0011).

    REPLACE, not IGNORE: the sweep runs every few seconds and the row should converge on the settled
    mark, so the last write of a market day is the one that stays.

    Columns listed rather than taken from `COLUMNS`: this table's key is (position_id, observed_on) and
    it has no `id`, so the generic insert's shape does not fit it — and naming them is what makes
    `insert or replace` readable as the decision it is.
    """
    db.execute(
        """insert or replace into position_samples
       (position_id, observed_on, dte, cost_to_close, legs_iv, legs_vega)
     values (?, ?, ?, ?, ?, ?)""",
        (
            value["position_id"],
            value["observed_on"],
            value["dte"],
            value["cost_to_close"],
            value["legs_iv"],
            value["legs_vega"],
        ),
    )


def find_position_sample(db: sqlite3.Connection, position_id: str, observed_on: str) -> PositionSampleRow | None:
    """The sample already stored for this Position on this market day, if any.

    Read so the sampler can decline to write the same row again. It wrote on every sweep — 5,760 times
    a day at a 15-second interval, to persist one row — and overnight almost all of those stored a value
    identical to the one already there."""
    return cast(
        PositionSampleRow | None,
        row(db, "select * from position_samples where position_id = ? and observed_on = ?", position_id, observed_on),
    )
