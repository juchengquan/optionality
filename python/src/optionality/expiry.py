"""DTE, counted from New York's calendar day. Mirrors typescript/src/domain/expiry.ts."""

from datetime import UTC, date, datetime
from typing import TypedDict
from zoneinfo import ZoneInfo

from optionality.contract import normalize_strike_date

MARKET_TZ = "America/New_York"


def _aware(now: datetime | None) -> datetime:
    if now is None:
        return datetime.now(UTC)
    # a naive datetime is read as UTC, the way a JavaScript Date is always an instant
    return now if now.tzinfo else now.replace(tzinfo=UTC)


def market_date(now: datetime | None = None) -> str:
    """The calendar day in New York at `now`, which is the day an option's life is counted from."""
    return _aware(now).astimezone(ZoneInfo(MARKET_TZ)).date().isoformat()


# 09:30 and 16:15 in New York, as milliseconds since its midnight
_SAMPLE_FROM = (9 * 60 + 30) * 60_000
_SAMPLE_UNTIL = (16 * 60 + 15) * 60_000


def in_sample_hours(now: datetime | None = None) -> bool:
    """Whether `now` is inside the sample hours: 09:30 to 16:15 in New York, both ends included, on
    EVERY calendar day.

    The sample is the day's CLOSE, and 16:15 is the OPTIONS' close, a quarter hour after the stocks'.
    Inside the hours the day's row is written freely; outside them it is only filled or completed
    (`takes_sample`). Every day, weekends included, because `vol_attribution` chains samples exactly
    one calendar day apart — a Saturday's row is the Friday close carried forward, a holiday's the
    previous close, a half-day's its own close. Mirrors `expiry.ts`.
    """
    ny = _aware(now).astimezone(ZoneInfo(MARKET_TZ))
    # milliseconds, truncated, because a JavaScript Date carries no finer clock than that and the
    # boundaries are compared to the millisecond on both sides
    since_midnight = ((ny.hour * 60 + ny.minute) * 60 + ny.second) * 1000 + ny.microsecond // 1000
    return _SAMPLE_FROM <= since_midnight <= _SAMPLE_UNTIL


class SampleReadings(TypedDict):
    """The two vol readings of a day's row, as stored: JSON text, or None where the feed withheld one."""

    legs_iv: str | None
    legs_vega: str | None


def takes_sample(now: datetime, stored: SampleReadings | None, observed: SampleReadings) -> bool:
    """Whether the sweep at `now` writes the day's row, given the row already stored for that market
    day (None if none) and what this sweep read.

    Inside the sample hours, always. Outside them the row is only FILLED or COMPLETED, never changed:
    a day with no row gets one whatever the hour (a trade recorded in New York's evening, a session
    missed whole — the vol chain needs every day); a row without its IV or vega is completed by a
    sweep that has BOTH, since the row is written whole; a complete row is left alone. Mirrors
    `expiry.ts`.
    """
    if in_sample_hours(now) or stored is None:
        return True
    incomplete = stored["legs_iv"] is None or stored["legs_vega"] is None
    return incomplete and observed["legs_iv"] is not None and observed["legs_vega"] is not None


def days_to_expiry(strike_date: str, now: datetime | None = None) -> int:
    """DTE: expiry day less New York's today. Zero on the day, negative after."""
    expiry = date.fromisoformat(normalize_strike_date(strike_date))
    return (expiry - date.fromisoformat(market_date(now))).days
