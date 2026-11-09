"""The rows a sweep test needs in a database, and a fetcher that prices them. The Python's half of
backend/testing/sweep.ts.

Here rather than in a test file because two suites drive the sweep: `engine/test_sweeper.py` for
the alarms, and `engine/test_positions.py` for what the same batch does to holdings — the sampler
and the manage-by notice, which are `positions.py`'s and spent 494 lines inside the alarm engine's
suite in the TypeScript because that is where the batch happened to be. Nobody looking for the
sampler's tests found them there.

Each builder takes its database explicitly rather than closing over a fixture: the fixture is
per-test (a fresh temp database), and a module-level one shared between files is how two suites end
up writing to each other's rows.

Not a test module, so pytest collects nothing here.
"""

import sqlite3
from typing import Any, TypedDict, cast

from harness import FakeFetch

from optionality_backend.db.queries.sql import row
from optionality_backend.db.values import to_sqlite_json

#: The Python's own fixture settings: telegram configured, no cooldown. The display zone is the
#: owner's, so a UTC-only test cannot pass by coincidence — both suites pin TZ=UTC.
SWEEP_SETTINGS: dict[str, Any] = {
    "telegram_bot_token": "t",
    "telegram_chat_id": "c",
    "alarm_cooldown_seconds": 0,
    "display_tz": "Asia/Singapore",
}

#: A single-contract monitor on SPXW, as the dashboard's form would have made it.
SINGLE_CODE = "US.SPXW261218C6500000"

_seq = 0


def insert_monitor(db: sqlite3.Connection, **over: Any) -> str:
    """One monitor row, and its id. `strike_date` is the caller's business: it is reckoned from the
    test's own clock, which this module deliberately knows nothing about."""
    global _seq
    _seq += 1
    values: dict[str, Any] = {
        "id": f"m{_seq}".ljust(32, "0"),
        "strike_date": "",
        "code": SINGLE_CODE,
        "option_type": "CALL",
        "strike": 6500,
        "field": "option_delta",
        "threshold": 0.6,
        "direction": "above",
        "compare": "abs",
        "legs": None,
        "scope": None,
        "enabled": 1,
        "disabled_reason": None,
        **over,
    }
    db.execute(
        """insert into monitors (id, code, strike_date, option_type, strike, field, threshold,
       direction, compare, legs, scope, enabled, disabled_reason, triggered, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '2026-08-01 00:00:00.000000')""",
        (
            values["id"],
            values["code"],
            values["strike_date"],
            values["option_type"],
            values["strike"],
            values["field"],
            values["threshold"],
            values["direction"],
            values["compare"],
            None if values["legs"] is None else to_sqlite_json(values["legs"]),
            values["scope"],
            values["enabled"],
            values["disabled_reason"],
        ),
    )
    return values["id"]


def insert_combo(db: sqlite3.Connection, **over: Any) -> str:
    """A two-leg call spread as a combo monitor: one code of its own, legs that each price."""
    return insert_monitor(
        db,
        **{
            "code": "sep-condor",
            "option_type": "CMB",
            "strike": 0,
            "field": "mid_price",
            "threshold": 10,
            "direction": "below",
            "legs": [
                {"sign": 1, "option_type": "CALL", "strike": 8100},
                {"sign": -1, "option_type": "CALL", "strike": 8150},
            ],
            **over,
        },
    )


def quoting(field: str, values: dict[str, float]) -> FakeFetch:
    """A fetcher returning one field per code, read from a mutable table so a test can move the
    market. A code absent from the table is simply not answered for — which is what "subscribed,
    nothing yet" looks like to the sweep, and is NOT the same as `unknown`."""

    def fetch(codes: list[str]) -> list[dict[str, Any]]:
        return [{"code": c, "name": c, field: values[c]} for c in codes if c in values]

    return fetch


class MonitorState(TypedDict):
    triggered: int
    last_value: float | None
    last_checked_at: str | None
    enabled: int
    disabled_reason: str | None


def monitor_state(db: sqlite3.Connection, id_: str) -> MonitorState | None:
    """What a sweep left on a monitor row."""
    return cast(MonitorState | None, row(db, "select * from monitors where id = ?", id_))
