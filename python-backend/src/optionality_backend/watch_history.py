"""A watched set of contracts' history, read (#402): what the sweep stored for the contracts a rule
watches, priced the way its reader prices them. Port of backend/src/watch-history.ts.

The rows (`watch_samples`, migration 0014) are keyed by the CONTRACTS — sorted codes, no signs, no
quantities — and carry each contract's mid rather than any one structure's value. So every value here
is worked out when it is read, by the domain's own functions:

- **a rule's** under its own signs and quantities, as the sweep values it (`monitor_value` on the
  price): what its history charts and what `/quotes`' `last_close` says;
- **a holding's** by SIDE, as `cost_to_close` values a holding — never from a combo's signs, which are a
  convention: the "before entry" days of its burndown.

None of it asks a Provider anything: stored history, read when asked.
"""

import json
import math
import sqlite3
from collections.abc import Callable, Iterable
from datetime import datetime
from typing import Any, TypedDict

from optionality.contract import build_spx_code
from optionality.expiry import (
    SampleTiming,
    ValuedTiming,
    close_sample,
    in_session,
    market_date,
    sample_timing,
    valued_timing,
)
from optionality.js import js_string
from optionality.monitor import Monitor, monitor_leg_codes, monitor_value
from optionality.position import Position, cost_to_close, position_leg_codes
from optionality.quote import ByCode, strike_distances

from .db.queries import find_watch_sample, list_watch_samples, recent_priced_watch_samples
from .db.rows import PositionRow, WatchSampleRow
from .db.time import display_stored, from_sql_datetime


def contract_set_key(codes: Iterable[str]) -> str:
    """The key a set of contracts is stored under: the codes, each once, sorted and joined by commas. No
    sign and no quantity, so a rule edited, a rule replaced by its holding's, or a holding recorded later
    on the same contracts all find the same history (owner's decision, 2026-11-15)."""
    return ",".join(sorted(set(codes)))


def stored_leg_map(text: str | None) -> dict[str, float] | None:
    """A stored per-contract map whose every reading is a finite number, or None: absent, unreadable, or
    holding something that is not a number (a boolean is not, as `typeof` says). A corrupt map costs its
    own figures, never the request."""
    if text is None:
        return None
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    if not isinstance(parsed, dict):
        return None
    try:
        numbers = all(
            isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v) for v in parsed.values()
        )
    except OverflowError:
        # an integer too long for a double, which JSON.parse reads as Infinity: not finite either
        return None
    return parsed if numbers else None


def _day_records(day: WatchSampleRow) -> ByCode:
    """A stored day as a batch: each contract's record under the field names a batch uses, so it is
    valued, and its strikes placed, by exactly the functions a live batch is. Only what the row stores."""
    records: dict[str, dict[str, Any]] = {}
    for field, text in (
        ("mid_price", day["legs_mid"]),
        ("option_implied_volatility", day["legs_iv"]),
        ("option_vega", day["legs_vega"]),
        ("option_delta", day["legs_delta"]),
    ):
        for code, value in (stored_leg_map(text) or {}).items():
            records.setdefault(code, {})[field] = value
    return records


class WatchDay(TypedDict):
    """One stored day as a chart reads it: its figures, the value its reader gives it, and the shorts
    placed against that day's SPX."""

    observed_on: str
    observed_at: str | None
    timing: SampleTiming
    dte: int
    #: the reader's price for the day: a rule's signed value, a holding's Cost to close
    value: float | None
    legs_iv: dict[str, float] | None
    legs_vega: dict[str, float] | None
    legs_delta: dict[str, float] | None
    spx: float | None
    short_strikes: list[dict[str, Any]]


def _days(
    rows: list[WatchSampleRow], value: Callable[[ByCode], float | None], shorts: list[str], tz: str
) -> list[WatchDay]:
    out: list[WatchDay] = []
    for s in rows:
        timing = sample_timing(s["observed_at"])
        records = _day_records(s)
        out.append(
            {
                "observed_on": s["observed_on"],
                "observed_at": None if timing == "unrecorded" else display_stored(s["observed_at"], tz),
                "timing": timing,
                "dte": s["dte"],
                "value": value(records),
                "legs_iv": stored_leg_map(s["legs_iv"]),
                "legs_vega": stored_leg_map(s["legs_vega"]),
                "legs_delta": stored_leg_map(s["legs_delta"]),
                "spx": s["spx"],
                "short_strikes": [d.model_dump() for d in strike_distances(shorts, records, s["spx"], s["dte"])],
            }
        )
    return out


def _rule_price(monitor: Monitor) -> Callable[[ByCode], float | None]:
    """A rule's price under its own signs and quantities, whatever field it watches: a delta rule's spread
    still has a price, which is what its payoff is drawn at (#402)."""
    priced = monitor.model_copy(update={"field": "mid_price"})
    return lambda records: monitor_value(priced, records)


def _rule_shorts(monitor: Monitor) -> list[str]:
    """The strikes a rule's history places against SPX: a combo's short legs (minus is short, as the
    watchlist's own `short_strikes`), and a single contract's own strike."""
    if not monitor.legs:
        return [monitor.code]
    codes = monitor_leg_codes(monitor)
    return [code for leg, code in zip(monitor.legs, codes, strict=True) if leg.sign < 0]


def rule_history(db: sqlite3.Connection, monitor: Monitor, tz: str) -> list[WatchDay]:
    """Every day stored for the contracts a rule watches, oldest first, valued under its signs."""
    rows = list_watch_samples(db, contract_set_key(monitor_leg_codes(monitor)))
    return _days(rows, _rule_price(monitor), _rule_shorts(monitor), tz)


class LastClose(TypedDict):
    """The day a rule's price is drawn at with no live one: its latest close (`close_sample`), said with
    when it was observed and what it is (`valued_timing`), so an evening's reading is never a close."""

    price: float
    observed_on: str
    observed_at: str | None
    timing: ValuedTiming


#: How many priced days back a last close is looked for: two weeks of them, which no weekend, holiday or
#: missed session outlasts, so `close_sample` over these chooses what it would over all of them.
LAST_CLOSE_DAYS = 14


def last_closes(
    db: sqlite3.Connection,
    rules: list[tuple[str, Monitor | None]],
    holdings: list[Position],
    tz: str,
    now: datetime,
) -> dict[str, LastClose | None]:
    """Each rule's last close, by id (#402): one bounded query per set of contracts, not per rule, of the
    latest priced days only (`LAST_CLOSE_DAYS`). Not today's row while the session runs, which is the
    session so far and no close; none for contracts an open holding holds exactly, which the sweep
    records as the holding's from its entry, so a watch day would only go stale; none for a rule that
    cannot be read (`None` in `rules`)."""
    held = {contract_set_key(position_leg_codes(p)) for p in holdings}
    today = market_date(now) if in_session(now) else None
    by_key: dict[str, list[WatchSampleRow]] = {}
    out: dict[str, LastClose | None] = {}
    for id_, monitor in rules:
        if monitor is None:
            out[id_] = None
            continue
        key = contract_set_key(monitor_leg_codes(monitor))
        if key in held:
            out[id_] = None
            continue
        if key not in by_key:
            by_key[key] = [
                s for s in recent_priced_watch_samples(db, key, LAST_CLOSE_DAYS) if s["observed_on"] != today
            ]
        price = _rule_price(monitor)
        candidates = [{**s, "cost_to_close": price(_day_records(s))} for s in by_key[key]]
        close = close_sample(candidates)  # type: ignore[type-var]
        if close is None or close["cost_to_close"] is None:
            out[id_] = None
            continue
        timing = valued_timing(close["observed_at"])
        out[id_] = {
            "price": close["cost_to_close"],
            "observed_on": close["observed_on"],
            "observed_at": None if timing == "unrecorded" else display_stored(close["observed_at"], tz),
            "timing": timing,
        }
    return out


def structure_key(monitor: Monitor) -> str:
    """The key the page matches two rules on the same spread by (`contractsKey` in the dashboard's
    `lastknown.ts`): a contract by its code, a spread by its expiry and its legs, each with its sign and
    quantity. What a watched rule's price rule is found by."""
    if not monitor.legs:
        return monitor.code
    legs = sorted(
        f"{js_string(leg.sign)}{leg.option_type}{js_string(leg.strike)}x{js_string(leg.qty)}" for leg in monitor.legs
    )
    return f"{monitor.strike_date} {' '.join(legs)}"


def _entered_on(row: PositionRow) -> str:
    """The first day a holding is its own: Opened, or where nobody said, the New York day it was
    recorded. Its own samples run from there, and a watch history only up to the day before."""
    return row["opened_at"] if row["opened_at"] is not None else market_date(from_sql_datetime(row["created_at"]))


def before_entry(db: sqlite3.Connection, row: PositionRow, position: Position, tz: str) -> list[WatchDay]:
    """The days a holding's contracts were WATCHED before it was entered (#402): the history of the same
    set of contracts, before Opened, each valued as the holding values itself — Cost to close, by side.
    Read-time, so `position_samples` and everything that reads it never see a watch day."""
    before = _entered_on(row)
    rows = [
        s for s in list_watch_samples(db, contract_set_key(position_leg_codes(position))) if s["observed_on"] < before
    ]
    shorts = [
        build_spx_code(position.strike_date, leg.option_type, leg.strike)
        for leg in position.legs
        if leg.side == "short"
    ]
    return _days(rows, lambda records: cost_to_close(position, records), shorts, tz)


def entry_close(
    db: sqlite3.Connection, row: PositionRow, position: Position, own: list[Any], tz: str
) -> WatchDay | None:
    """The entry day's close as it was WATCHED (#402, owner's decision of 2026-11-15): where the holding's
    own row for the day it was entered has no Cost to close — recorded in New York's evening, priced by
    nothing (#380) — the watch history's row for the same contracts that day, valued as the holding's
    Cost to close, by side. None wherever its own row has a cost, it has no row that day, or the watch
    history has no priced row for it. Served apart, so `position_samples` and its readers are untouched."""
    on = _entered_on(row)
    mine = next((s for s in own if s["observed_on"] == on), None)
    if mine is None or mine["cost_to_close"] is not None:
        return None
    watched = find_watch_sample(db, contract_set_key(position_leg_codes(position)), on)
    if watched is None:
        return None
    shorts = [
        build_spx_code(position.strike_date, leg.option_type, leg.strike)
        for leg in position.legs
        if leg.side == "short"
    ]
    (day,) = _days([watched], lambda records: cost_to_close(position, records), shorts, tz)
    return None if day["value"] is None else day
