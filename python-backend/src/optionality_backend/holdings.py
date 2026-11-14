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
  `{ values }` the TypeScript returns is `Valued`.
- **A close row's stored maps are read as `JSON.parse` reads them** (`db.values.from_sqlite_json`), and
  an integer too long for a double, which JavaScript reads as Infinity, is no finite reading here either.

**Outside New York's session a holding is valued from its latest close** (#380): `values_from_close`
decides, per holding, and only the holdings valued live are asked for. `holdings.ts` says why.
**Out of the session a failed Provider call costs only the holdings that needed it** (#387): they are
dashes with the failure's message (`unpriced`), and the rest are served from their closes; in the session
the failure is still the caller's.
"""

import math
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, TypedDict, cast

from optionality.exit import ExitPolicy, captured, dte_at_open, exit_levels
from optionality.expiry import days_to_expiry, in_session, values_from_close
from optionality.position import Position, contract_size, cost_to_close, pnl_at, position_leg_codes
from optionality.quote import ByCode, DerivedSpx, derived_spx, display_records

from .correct_legs import before_correction
from .db.queries import list_position_samples, open_positions
from .db.rows import PositionRow, PositionSampleRow
from .db.values import from_sqlite_json
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
    #: what it would cost to buy back — now, or at the close it is valued from — or None where a leg
    #: cannot be read
    cost: float | None
    #: Entry less cost to close, in money. None where either is unknown, or the size is.
    pnl: float | None
    #: the share of a credit's Entry kept so far, from this same cost (`captured`): None for a debit,
    #: which has no credit to keep, and wherever either side is unknown (ADR 0023)
    captured: float | None
    #: None for a Position whose Opened nobody declared: nothing is inferred from created_at, so there
    #: is no DTE at entry and therefore no schedule (ADR 0011).
    schedule: Schedule | None
    #: today's DTE, whatever the figures are from (#380, F5)
    dte: int
    #: "live" from the Provider's batch, or "close" from the stored row `close` (#380)
    valued_from: Literal["live", "close"]
    #: why a holding valued live has no figures: out of the session, the failed Provider call's own message
    #: (#387); None wherever the call was made and answered, or not needed
    unpriced: str | None
    #: the stored row a close valuation is from; None for a live one
    close: PositionSampleRow | None
    #: the records the greeks, the legs' deltas and the strike distances are read from: the batch's, or
    #: the close row's own per-leg delta, IV and vega (no gamma, no theta)
    records: ByCode
    #: SPX's price at the instant of the figures
    spx: DerivedSpx
    #: the points-to-money multiplier: the batch's, or the close row's (migration 0013)
    contract_size: float | None
    #: the DTE the figures were taken at: today's when live, the close row's own when not (#380, F5)
    figures_dte: int


@dataclass(frozen=True)
class Valued:
    """Every holding's value."""

    values: list[HoldingValue]


#: why a close valuation has no SPX
NO_CLOSE_SPX = "no SPX price was recorded with the close it is valued from"


def close_of(db: sqlite3.Connection, row: PositionRow, now: datetime) -> PositionSampleRow | None:
    """The stored row a holding is valued from at `now`, or None to value it live (`values_from_close`).
    A row observed before a leg's quantity was last corrected is no candidate (#359)."""
    samples = [
        s
        for s in list_position_samples(db, row["id"])
        if not before_correction(s["observed_at"], row["qty_corrected_at"])
    ]
    return values_from_close(now, samples)


def _stored_map(text: str | None) -> dict[str, Any] | None:
    """A stored per-leg map, or None where it is absent or will not parse."""
    if text is None:
        return None
    try:
        parsed = from_sqlite_json(text)
    except Exception:  # noqa: BLE001 — the TypeScript's bare `catch`: a corrupt map costs its own figures
        return None
    return parsed if isinstance(parsed, dict) else None


def _finite(value: object) -> bool:
    """`typeof v === "number" && Number.isFinite(v)`, for a value `JSON.parse` read."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        # an integer too long for a double, which JSON.parse reads as Infinity
        return False


def _close_records(position: Position, close: PositionSampleRow) -> ByCode:
    """A close row's per-leg readings as records keyed by contract, in a batch's field names."""
    maps = (
        ("option_delta", _stored_map(close["legs_delta"])),
        ("option_implied_volatility", _stored_map(close["legs_iv"])),
        ("option_vega", _stored_map(close["legs_vega"])),
    )
    records: ByCode = {}
    for code in position_leg_codes(position):
        record: dict[str, Any] = {"code": code}
        for field, mapping in maps:
            v = None if mapping is None else mapping.get(code)
            if _finite(v):
                record[field] = v
        records[code] = record
    return records


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


def _schedule_of(
    row: PositionRow, cost: float | None, figures_dte: int, dte: int, settings: Settings
) -> Schedule | None:
    """The exit schedule for one holding, or None where it was never declared Opened: measured at the
    DTE the figures were taken at, with whether manage-by is due read off TODAY's (#380, F5)."""
    if row["opened_at"] is None:
        return None
    opened_dte = dte_at_open(row["strike_date"], row["opened_at"])
    policy = _exit_policy(settings)
    levels = exit_levels(row["entry"], opened_dte, figures_dte, policy, cost)
    if levels is None:
        return None
    return cast(
        Schedule,
        {"dte_at_open": opened_dte, **levels.model_dump(), "manage_by_due": dte <= policy.manage_by_dte},
    )


def _live(
    row: PositionRow,
    position: Position,
    by_code: ByCode,
    spx: DerivedSpx,
    size: float | None,
    dte: int,
    settings: Settings,
    unpriced: str | None,
) -> HoldingValue:
    cost = cost_to_close(position, by_code)
    return HoldingValue(
        row=row,
        position=position,
        cost=cost,
        pnl=pnl_at(position, cost, size),
        captured=captured(position.entry, cost),
        schedule=_schedule_of(row, cost, dte, dte, settings),
        dte=dte,
        valued_from="live",
        unpriced=unpriced,
        close=None,
        records=by_code,
        spx=spx,
        contract_size=size,
        figures_dte=dte,
    )


def _from_close(
    row: PositionRow, position: Position, close: PositionSampleRow, dte: int, settings: Settings
) -> HoldingValue:
    cost = close["cost_to_close"]
    return HoldingValue(
        row=row,
        position=position,
        cost=cost,
        pnl=pnl_at(position, cost, close["contract_size"]),
        captured=captured(position.entry, cost),
        schedule=_schedule_of(row, cost, close["dte"], dte, settings),
        dte=dte,
        valued_from="close",
        unpriced=None,
        close=close,
        records=_close_records(position, close),
        spx=DerivedSpx(price=close["spx"], reason=NO_CLOSE_SPX if close["spx"] is None else None),
        contract_size=close["contract_size"],
        figures_dte=close["dte"],
    )


async def holding_values(
    db: sqlite3.Connection, fetch_quotes: QuoteFetcher, now: datetime, settings: Settings, tz: str
) -> Valued:
    """Every holding still held, each valued live from ONE batch or from its latest close.

    Raises if the batch fails IN THE SESSION: whether that is a 502 or a sentence in a Telegram reply is
    the caller's business, not this module's. Out of it a failed batch dashes the holdings valued live,
    each with the failure's message, and serves the rest from their closes (#387). No batch is asked for
    where nothing is valued live.
    """
    # what is HELD: a closed holding is kept with its history but valued no longer, and must not widen
    # the batch for contracts nobody holds (ADR 0022)
    rows = open_positions(db)
    if not rows:
        return Valued(values=[])

    positions = [to_position(r) for r in rows]
    closes = [close_of(db, row, now) for row in rows]
    live = [p for p, c in zip(positions, closes, strict=True) if c is None]
    by_code: ByCode = {}
    unpriced: str | None = None
    if live:
        codes = _js_sorted({code for p in live for code in position_leg_codes(p)})
        # only the CALL is caught: a fault of this service's own past it is no Provider's (#387 review)
        records = None
        try:
            records = (await fetch_quotes(codes)).records
        except Exception as err:
            # in the session the batch is the price, and its failure is the whole answer's; out of it the
            # holdings it would have priced are dashes with the reason, and the closes still stand (#387)
            if in_session(now):
                raise
            unpriced = str(err)
        if records is not None:
            by_code = display_records(records, tz, now)
    batch_spx = derived_spx(list(by_code.values()))
    batch_size = contract_size(by_code)

    values: list[HoldingValue] = []
    for row, position, close in zip(rows, positions, closes, strict=True):
        dte = days_to_expiry(row["strike_date"], now)
        values.append(
            _live(row, position, by_code, batch_spx, batch_size, dte, settings, unpriced)
            if close is None
            else _from_close(row, position, close, dte, settings)
        )
    return Valued(values=values)
