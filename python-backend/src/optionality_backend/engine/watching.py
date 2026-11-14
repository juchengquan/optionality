"""What a sweep records of the WATCHLIST: the daily close of every set of contracts an enabled rule
watches (#402). Port of backend/src/engine/watching.ts, which says why, at length.

Under EXACTLY the holdings' rules (`record_samples` in `positions.py`, ADR 0011), from the sweep's own
batch and never a call of its own, keyed by the contracts rather than a rule, and leaving the contracts
an open holding holds exactly to that holding's own samples. Guarded per set of contracts: a sample
must never be the reason a breach went unmessaged.

**Where the Python differs, and why.** The stored maps are `db/values.to_sqlite_json`, byte for byte
`JSON.stringify`, because a changed row is told by comparing that TEXT with what is stored.
"""

import logging
import math
import sqlite3
from datetime import datetime

from optionality.expiry import days_to_expiry, market_date, takes_sample
from optionality.js import number
from optionality.monitor import monitor_leg_codes
from optionality.position import contract_size, position_leg_codes
from optionality.quote import ByCode, derived_spx

from ..db.queries import find_watch_sample, record_watch_sample
from ..db.rows import MonitorRow, PositionRow, WatchSampleRow
from ..db.time import to_sql_datetime
from ..db.values import to_sqlite_json
from ..hydrate import to_monitor, to_position
from ..watch_history import contract_set_key

log = logging.getLogger(__name__)

_FIELDS = ("mid_price", "option_implied_volatility", "option_vega", "option_delta")


def _readings(codes: list[str], by_code: ByCode, field: str) -> dict[str, float] | None:
    """Every contract's finite reading of one field, in the key's order, or None if any contract lacks
    one: all or nothing, as a holding's maps are (`leg_readings`)."""
    out: dict[str, float] = {}
    for code in codes:
        record = by_code.get(code)
        value = None if record is None else record.get(field)
        if value is None:
            return None
        n = number(value)
        if not math.isfinite(n):
            return None
        out[code] = n
    return out


def _priced(mids: str | None) -> float | None:
    """`takes_sample` reads a Cost to close only for whether there is one; a set of contracts has a price
    exactly when every contract has a mid."""
    return None if mids is None else 0.0


def _watched_sets(monitors: list[MonitorRow], holdings: list[PositionRow]) -> dict[str, tuple[list[str], str]]:
    """The sets of contracts the enabled rules watch, by key, with the expiry they share: once each, and
    none an open holding holds exactly."""
    held: set[str] = set()
    for row in holdings:
        try:
            held.add(contract_set_key(position_leg_codes(to_position(row))))
        except ValueError:
            # a holding that cannot be read holds nothing here; the sweep already said so
            continue
    sets: dict[str, tuple[list[str], str]] = {}
    for row in monitors:
        if not row["enabled"]:
            continue
        try:
            monitor = to_monitor(row)
            key = contract_set_key(monitor_leg_codes(monitor))
            if key in held or key in sets:
                continue
            sets[key] = (key.split(","), monitor.strike_date)
        except ValueError:
            # a rule that cannot be read is quarantined by the sweep, and records nothing
            continue
    return sets


def record_watch_samples(
    db: sqlite3.Connection, monitors: list[MonitorRow], holdings: list[PositionRow], by_code: ByCode, at: datetime
) -> None:
    """One row per set of contracts per market day, from this sweep's batch."""
    observed_on = market_date(at)
    spx = derived_spx(list(by_code.values())).price
    size = contract_size(by_code)
    for key, (codes, strike_date) in _watched_sets(monitors, holdings).items():
        try:
            dte = days_to_expiry(strike_date, at)
            if dte < 0:
                continue
            maps = [_readings(codes, by_code, field) for field in _FIELDS]
            # nothing observed at all — contracts the Provider did not return — is no row
            if all(m is None for m in maps):
                continue
            mids, ivs, vegas, deltas = (None if m is None else to_sqlite_json(m) for m in maps)

            day = find_watch_sample(db, key, observed_on)
            write = takes_sample(
                at,
                None
                if day is None
                else {
                    "legs_iv": day["legs_iv"],
                    "legs_vega": day["legs_vega"],
                    "cost_to_close": _priced(day["legs_mid"]),
                    "observed_at": day["observed_at"],
                },
                {"legs_iv": ivs, "legs_vega": vegas, "cost_to_close": _priced(mids)},
            )
            if write == "no":
                continue
            # only when something differs, as the holdings' sampler: `observed_at` stamps a write
            if (
                write == "if-changed"
                and day is not None
                and day["dte"] == dte
                and day["legs_mid"] == mids
                and day["legs_iv"] == ivs
                and day["legs_vega"] == vegas
                and day["legs_delta"] == deltas
                and day["spx"] == spx
                and day["contract_size"] == size
            ):
                continue
            row: WatchSampleRow = {
                "contracts": key,
                "observed_on": observed_on,
                "dte": dte,
                "legs_mid": mids,
                "legs_iv": ivs,
                "legs_vega": vegas,
                "legs_delta": deltas,
                "observed_at": to_sql_datetime(at),
                "spx": spx,
                "contract_size": size,
            }
            record_watch_sample(db, row)
        except Exception:
            log.exception("recording a watch sample for %s failed:", key)
