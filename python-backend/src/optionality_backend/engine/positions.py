"""What a sweep does to HOLDINGS: the daily sample, and the manage-by notice (ADR 0020). Port of
backend/src/engine/positions.ts.

Inside the engine's door because `engine/sweeper.py` is the only caller — measured, and the reason it
matters is the sample. `record_samples` writes one observation per Position per market DAY, stamped
with the sweep's single instant, which is what makes the √T decay shape checkable against this book
rather than defended on arithmetic (ADR 0011). Outside the engine any route could write a second
observation for the same day, mid-request, outside that guarantee; the seam lint refuses the import.

Neither of these is an alarm. They live here because the batch they read is the sweep's batch and the
instant they stamp is the sweep's instant — the figures come from one fetch, so a Position cannot be
in the batch and missing from the record.

**Where the Python differs, and why.**

- **The notice's numbers are JavaScript's.** `entry ${row.entry}` is `js_string`, because a REAL
  column answers `2.0` here where `String(2)` is "2"; every `toFixed(2)` is `_fixed`, which rounds as
  JavaScript does (`optionality.js.to_fixed`) and writes it as JavaScript does, -0 and NaN included.
- **The stored maps are `db/values.to_sqlite_json`**, byte for byte `JSON.stringify`: the sampler
  tells a changed row by comparing that TEXT with what is stored, and both backends write one file.
- `PositionSweepDeps` is a frozen dataclass; a failure is logged with its stack (`log.exception`),
  as `console.error` with the error prints one.
"""

import logging
import math
import sqlite3
from dataclasses import dataclass
from datetime import datetime

from optionality.exit import dte_at_open, on_pace
from optionality.expiry import days_to_expiry, market_date
from optionality.js import js_string, to_fixed
from optionality.position import cost_to_close, leg_readings
from optionality.quote import ByCode

from ..db.queries import find_position_sample, record_position_sample, stamp_manage_notified
from ..db.rows import PositionRow
from ..db.time import to_sql_datetime
from ..db.values import to_sqlite_json
from ..env import Settings
from ..hydrate import to_position
from ..notify import Notifier

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class PositionSweepDeps:
    """What the sweep hands these: the database, the policy, and a way to send that reports whether
    it got through. `notify.py`'s notifier swallows a failed send — it must, since the sweep's job is
    the alarm — so a caller that needs to know asks for the answer rather than for a raise."""

    db: sqlite3.Connection
    settings: Settings
    notify: Notifier


def _fixed(value: float, digits: int = 2) -> str:
    """`value.toFixed(digits)`: JavaScript's rounding and JavaScript's text. -0 is "0.00" there, since
    the sign is taken from `value < 0`, and a value that is not finite is written as `String` writes
    it."""
    if not math.isfinite(value):
        return js_string(value)
    return f"{to_fixed(value + 0.0, digits):.{digits}f}"


async def notice_manage_by(deps: PositionSweepDeps, rows: list[PositionRow], by_code: ByCode, at: datetime) -> None:
    """One notice per Position when it reaches the manage-by DTE (ADR 0011).

    A notice about a POSITION, not an Alarm about a Monitor: no threshold is involved, the cooldowns
    do not apply, and `manage_notified_at` is what makes it once rather than once a minute. Pace
    deliberately does not notify — being behind fires on every IV spike.

    `opened_at` is the gate, and that is the whole reason it is: three of the five Positions in the
    live book were already inside 21 DTE when this shipped, so without it the first sweep after the
    deploy would have fired three retroactive notices and looked like a fault.
    """
    settings = deps.settings
    for row in rows:
        try:
            if row["opened_at"] is None or row["manage_notified_at"] is not None:
                continue
            dte = days_to_expiry(row["strike_date"], at)
            if dte < 0 or dte > settings.exit_manage_by_dte:
                continue

            cost = cost_to_close(to_position(row), by_code)
            pace = on_pace(row["entry"], dte_at_open(row["strike_date"], row["opened_at"]), dte)

            line = f"⏰ {row['name']} is at {dte} DTE — manage by {settings.exit_manage_by_dte}"
            if row["entry"] is not None:
                line += f"\nentry {js_string(row['entry'])}"
            if cost is not None:
                line += f" · now {_fixed(cost)}"
            if pace is not None:
                gap = None if cost is None else cost - pace
                line += f"\non-pace {_fixed(pace)}"
                if gap is not None:
                    line += f" — {'behind' if gap > 0 else 'ahead'} by {_fixed(abs(gap))}"
            # stamped only once the notice has actually been delivered, so an undelivered one is
            # retried next sweep while a delivered one is never repeated. `notify` swallows a failed
            # send and therefore cannot be relied on to raise — it reports instead.
            if await deps.notify(line):
                stamp_manage_notified(deps.db, row["id"], to_sql_datetime(at))
        except Exception:
            log.exception("manage-by notice for %s failed:", row["name"])


def record_samples(db: sqlite3.Connection, rows: list[PositionRow], by_code: ByCode, at: datetime) -> None:
    """One observation per Position per market day, so the decay shape can be checked against this
    book rather than defended on arithmetic (ADR 0011). Nothing reads these yet.

    Guarded per Position, like the telegram send is: the sweep exists to raise alarms, and a sample is
    a nice-to-have that must never be the reason a breach went unmessaged.

    The day is the MARKET day, matching the `dte` stored beside it and the dashboard's column.
    Deliberately not the sweeper's `_utc_date` — that is the expiry reckoning, and the two differ for
    the hours New York is behind UTC, which would pair a New York Wednesday with Thursday's DTE.
    """
    observed_on = market_date(at)
    for row in rows:
        try:
            dte = days_to_expiry(row["strike_date"], at)
            if dte < 0:
                continue
            position = to_position(row)
            # unknown, not zero: one unpriced leg and there is no observation to make
            cost = cost_to_close(position, by_code)
            if cost is None:
                continue

            # Per LEG, because a structure has no IV — "IV is never summed" (CLAUDE.md), and these
            # legs run 10.5% to 22.1%, so one number for them would be a fiction. The vegas go with
            # them as the weight those IVs have to be combined with, and are recorded rather than
            # derived later because a vega is only knowable when it was observed.
            #
            # None rather than a partial map, per map: a vol adjustment needs every leg, and half a
            # structure's vol invites an answer computed from half a structure. Gated SEPARATELY,
            # though — a withheld vega does not make the IV reading untrue, and the IV is the half no
            # later sweep can recover.
            ivs = leg_readings(position, by_code, "option_implied_volatility")
            vegas = leg_readings(position, by_code, "option_vega")
            legs_iv = None if ivs is None else to_sqlite_json(ivs)
            legs_vega = None if vegas is None else to_sqlite_json(vegas)

            # Only when something actually differs. The sweep runs every 15 seconds and the day's row
            # is meant to settle on the close, not to be rewritten 5,760 times — overnight and at
            # weekends nearly every one of those writes stored what was already there, and the IV map
            # triples what each one carries.
            stored = find_position_sample(db, row["id"], observed_on)
            if (
                stored is not None
                and stored["dte"] == dte
                and stored["cost_to_close"] == cost
                and stored["legs_iv"] == legs_iv
                and stored["legs_vega"] == legs_vega
            ):
                continue

            record_position_sample(
                db,
                {
                    "position_id": row["id"],
                    "observed_on": observed_on,
                    "dte": dte,
                    "cost_to_close": cost,
                    "legs_iv": legs_iv,
                    "legs_vega": legs_vega,
                },
            )
        except Exception:
            log.exception("recording a sample for %s failed:", row["name"])
