"""What a holding is worth and where it stands, computed once for everything that asks. Port of
backend/src/holdings.ts.

The dashboard asks through `/positions/values`; the bot asks through `/holdings`. The route used to do
all of this inline, so a second caller meant a second definition of cost, P&L and the exit schedule —
and #129 was a day spent on what happens when two surfaces answer one question their own way. The
figures are decided here; each surface only chooses how to say them.

**Where the Python differs, and why.**

- **The exit policy is read here** from Settings. The TypeScript reads it through the library's
  `exitPolicy`, "not a fourth hand-built copy of the same three knobs"; the Python library leaves that
  reader out because it takes the service's Settings, so each caller reads the same three settings
  into the same fields, as `routes/monitors.py` and `engine/health.py` do theirs.
- **Hydrating validates** (`hydrate.py`, issue #266). A stored holding whose legs parse but are not
  legs — a side of "sold" — is refused HERE, as a raise, where the TypeScript casts it and values it.
  Both callers turn any raise from here into their failure: the route's 502 naming the Provider and
  the bot's sentence. The TypeScript's route values that row and then answers 500 when its reply
  schema refuses the leg.
- **The codes are sorted as JavaScript sorts**, by UTF-16 code unit (`watchlist.py` says why that
  matters only in principle).
- `HoldingValue` is a frozen dataclass and its `schedule` a `Schedule`, the TypeScript's
  `ExitLevels & { dte_at_open }`, as the JSON the route answers and the bot reads. The anonymous
  `{ byCode, values }` the TypeScript returns is `Valued`.
"""

import sqlite3
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, TypedDict, cast

from optionality.exit import ExitPolicy, dte_at_open, exit_levels
from optionality.expiry import days_to_expiry
from optionality.position import Position, cost_to_close, position_leg_codes, position_pnl
from optionality.quote import ByCode, display_records

from .db.queries import open_positions
from .db.rows import PositionRow
from .env import Settings
from .hydrate import to_position
from .ports import QuoteFetcher


class Schedule(TypedDict):
    """The library's `ExitLevels`, and the DTE on the day it was Opened that places them."""

    dte_at_open: int
    on_pace: float | None
    pace_gap: float | None
    target: float | None
    stop: float | None
    target_dte: int | None
    manage_by_dte: int
    reached: Literal["target", "stop"] | None
    manage_by_due: bool


@dataclass(frozen=True)
class HoldingValue:
    row: PositionRow
    position: Position
    #: what it would cost to buy back right now, or None where a leg cannot be read
    cost: float | None
    #: Entry less cost to close, in money. None where either is unknown.
    pnl: float | None
    #: None for a Position whose Opened nobody declared: nothing is inferred from created_at, so there
    #: is no DTE at entry and therefore no schedule (ADR 0011).
    schedule: Schedule | None
    dte: int


@dataclass(frozen=True)
class Valued:
    """Every holding's value, and the batch they were valued from, by code."""

    by_code: ByCode
    values: list[HoldingValue]


def _exit_policy(settings: Settings) -> ExitPolicy:
    """The library's `exitPolicy`, which reads Settings: the three knobs, from `.env`."""
    return ExitPolicy(
        take_fraction=settings.exit_take_fraction,
        stop_multiple=settings.exit_stop_multiple,
        manage_by_dte=settings.exit_manage_by_dte,
    )


def _js_sorted(codes: set[str]) -> list[str]:
    """`[...codes].sort()`: by UTF-16 code unit, which is how JavaScript compares two strings."""
    return sorted(codes, key=lambda code: code.encode("utf-16-be", "surrogatepass"))


def _schedule_of(row: PositionRow, cost: float | None, now: datetime, settings: Settings) -> Schedule | None:
    """The exit schedule for one holding, or None where it was never declared Opened."""
    if row["opened_at"] is None:
        return None
    opened_dte = dte_at_open(row["strike_date"], row["opened_at"])
    levels = exit_levels(
        row["entry"], opened_dte, days_to_expiry(row["strike_date"], now), _exit_policy(settings), cost
    )
    return None if levels is None else cast(Schedule, {"dte_at_open": opened_dte, **levels.model_dump()})


def _value(row: PositionRow, position: Position, by_code: ByCode, now: datetime, settings: Settings) -> HoldingValue:
    cost = cost_to_close(position, by_code)
    return HoldingValue(
        row=row,
        position=position,
        cost=cost,
        pnl=position_pnl(position, by_code),
        schedule=_schedule_of(row, cost, now, settings),
        dte=days_to_expiry(row["strike_date"], now),
    )


async def holding_values(
    db: sqlite3.Connection, fetch_quotes: QuoteFetcher, now: datetime, settings: Settings, tz: str
) -> Valued:
    """Every holding still held, valued from ONE batch.

    Raises if the batch fails: whether that is a 502 or a sentence in a Telegram reply is the caller's
    business, not this module's.
    """
    # what is HELD: a closed holding is kept with its history but valued no longer, and must not widen
    # the batch for contracts nobody holds (ADR 0022)
    rows = open_positions(db)
    if not rows:
        return Valued(by_code={}, values=[])

    positions = [to_position(r) for r in rows]
    codes = _js_sorted({code for p in positions for code in position_leg_codes(p)})
    records = (await fetch_quotes(codes)).records
    by_code = display_records(records, tz, now)

    return Valued(
        by_code=by_code,
        values=[_value(row, position, by_code, now, settings) for row, position in zip(rows, positions, strict=True)],
    )
