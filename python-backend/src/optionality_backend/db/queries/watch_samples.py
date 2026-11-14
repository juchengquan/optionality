"""`watch_samples`: one observation of a watched set of contracts per market day (#402). Port of
backend/src/db/queries/watch-samples.ts.

Keyed by the contracts, not by a rule (migration 0014), and never deleted: a history outlives the rule
that watched it, as a holding's samples outlive nothing but the holding itself. Nothing here deletes a
row, and nothing should — the owner's decision of 2026-11-15, and CLAUDE.md's "nothing else is ever
auto-deleted".
"""

import sqlite3
from typing import cast

from ..rows import WatchSampleRow
from .sql import row, rows


def list_watch_samples(db: sqlite3.Connection, contracts: str) -> list[WatchSampleRow]:
    """Every day stored for one set of contracts (`contract_set_key`), oldest first."""
    return cast(
        list[WatchSampleRow],
        rows(db, "select * from watch_samples where contracts = ? order by observed_on", contracts),
    )


def recent_priced_watch_samples(db: sqlite3.Connection, contracts: str, limit: int) -> list[WatchSampleRow]:
    """The latest `limit` days stored for one set of contracts WITH a price — every contract's mid —
    newest first: what a last close is chosen from (`last_closes`), without reading and parsing every
    day a history has ever had on every poll."""
    return cast(
        list[WatchSampleRow],
        rows(
            db,
            """select * from watch_samples where contracts = ? and legs_mid is not null
               order by observed_on desc limit ?""",
            contracts,
            limit,
        ),
    )


def find_watch_sample(db: sqlite3.Connection, contracts: str, observed_on: str) -> WatchSampleRow | None:
    """The day already stored for this set of contracts, if any: what `takes_sample` decides against."""
    return cast(
        WatchSampleRow | None,
        row(db, "select * from watch_samples where contracts = ? and observed_on = ?", contracts, observed_on),
    )


def record_watch_sample(db: sqlite3.Connection, value: WatchSampleRow) -> None:
    """One day of a set of contracts, keyed on the market day: REPLACE, so the last write of a day is the
    one that stays, as `record_position_sample`'s. Columns named for its reason."""
    db.execute(
        """insert or replace into watch_samples
       (contracts, observed_on, dte, legs_mid, legs_iv, legs_vega, legs_delta, observed_at, spx,
        contract_size)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            value["contracts"],
            value["observed_on"],
            value["dte"],
            value["legs_mid"],
            value["legs_iv"],
            value["legs_vega"],
            value["legs_delta"],
            value["observed_at"],
            value["spx"],
            value["contract_size"],
        ),
    )
