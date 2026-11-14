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
from optionality.expiry import days_to_expiry, market_date, takes_sample
from optionality.js import js_string, to_fixed
from optionality.position import cost_to_close, leg_readings
from optionality.quote import ByCode, derived_spx

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
    book rather than defended on arithmetic (ADR 0011).

    Written freely only in the sample hours, 09:30 to 16:15 in New York, so the day's row is the last
    sweep at or before the options' close. Until then it was rewritten up to New York's midnight, and
    SPXW trades again from about 20:15 — so the row that survived could be an overnight mark under a
    chart that calls it the close. Outside the hours a row is only ever FILLED (a day with none: a trade
    recorded in the evening, a session missed whole) or COMPLETED (a row the feed left without its IV or
    vega), never changed — `takes_sample` decides, and every write carries the sweep's instant in
    `observed_at`, so a filled point is never mistaken for a close. Every calendar day, weekends
    included, because the vol chain needs a row for each (vol.py).

    Guarded per Position, like the telegram send is: the sweep exists to raise alarms, and a sample is
    a nice-to-have that must never be the reason a breach went unmessaged.

    The day is the MARKET day, matching the `dte` stored beside it and the dashboard's column.
    Deliberately not the sweeper's `_utc_date` — that is the expiry reckoning, and the two differ for
    the hours New York is behind UTC, which would pair a New York Wednesday with Thursday's DTE.
    """
    observed_on = market_date(at)
    # SPX's price as this sweep's batch implies it, once for every row: each was valued against the
    # same index. Never a Reference's figure (ADR 0018, 0024); None where the batch cannot give it,
    # which costs the sample nothing else.
    spx = derived_spx(list(by_code.values())).price
    for row in rows:
        try:
            dte = days_to_expiry(row["strike_date"], at)
            if dte < 0:
                continue
            position = to_position(row)
            # unknown, not zero: one leg without a mid and there is no cost to record. The vol may
            # still be there to read — moomoo quotes every option 0/0 out of hours and serves the
            # greeks — and the chain needs the day, so the row is written with the cost left empty
            # (#380, below).
            cost = cost_to_close(position, by_code)

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
            # The delta the same way and for the same reason as the vega: the risk the owner manages
            # by, only knowable when observed, all or nothing, and gated on its own so a withheld delta
            # never costs the IV or the vega reading beside it.
            deltas = leg_readings(position, by_code, "option_delta")
            legs_delta = None if deltas is None else to_sqlite_json(deltas)
            # nothing observed at all — a leg the Provider did not return — is no row: neither a price
            # nor a reading to keep, and skipping it is quiet, as it always was
            if cost is None and ivs is None and vegas is None and deltas is None:
                continue

            # The day's row as it stands decides what this sweep may do with it: fill it, write it if its
            # figures moved, restamp or replace a provisional one, complete one without its vol readings
            # — or nothing, which is how a settled close stays the close (takes_sample).
            stored = find_position_sample(db, row["id"], observed_on)
            # ...and an EMPTY cost never replaces a stored one, whatever the hour (#380)
            write = takes_sample(at, stored, {"legs_iv": legs_iv, "legs_vega": legs_vega, "cost_to_close": cost})
            if write == "no":
                continue

            # Only when something actually differs. The sweep runs every 15 seconds and the day's row
            # is meant to settle on the close, not to be rewritten 5,760 times — overnight and at
            # weekends nearly every one of those writes stored what was already there, and the IV map
            # triples what each one carries. `observed_at` is NOT compared: it stamps a write, so it says
            # when the figures were last seen to change, which is when they were observed.
            if (
                write == "if-changed"
                and stored is not None
                and stored["dte"] == dte
                and stored["cost_to_close"] == cost
                and stored["legs_iv"] == legs_iv
                and stored["legs_vega"] == legs_vega
                and stored["legs_delta"] == legs_delta
                and stored["spx"] == spx
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
                    "legs_delta": legs_delta,
                    "observed_at": to_sql_datetime(at),
                    "spx": spx,
                },
            )
        except Exception:
            log.exception("recording a sample for %s failed:", row["name"])
