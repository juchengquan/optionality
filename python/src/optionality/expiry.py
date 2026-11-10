"""DTE, counted from New York's calendar day. Mirrors typescript/src/domain/expiry.ts."""

from datetime import UTC, date, datetime
from typing import Literal, TypedDict
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
    Inside the hours the day's row is written freely; outside them `takes_sample` decides. Every day,
    weekends included, because `vol_attribution` chains samples exactly one calendar day apart — a
    Saturday's row is the Friday close carried forward, a holiday's the previous close, a half-day's
    its own close. Mirrors `expiry.ts`.
    """
    return _SAMPLE_FROM <= _since_new_york_midnight(now) <= _SAMPLE_UNTIL


def _since_new_york_midnight(now: datetime | None) -> int:
    """Milliseconds since midnight in New York at `now`."""
    ny = _aware(now).astimezone(ZoneInfo(MARKET_TZ))
    # milliseconds, truncated, because a JavaScript Date carries no finer clock than that and the
    # boundaries are compared to the millisecond on both sides
    return ((ny.hour * 60 + ny.minute) * 60 + ny.second) * 1000 + ny.microsecond // 1000


class SampleReadings(TypedDict):
    """The two vol readings of a day's row, as stored: JSON text, or None where the feed withheld one."""

    legs_iv: str | None
    legs_vega: str | None


class StoredSample(SampleReadings):
    """The day's row as stored, as far as `takes_sample` reads it. `observed_at` is UTC as the database
    spells it; None on rows written before migration 0009, which are taken as settled."""

    observed_at: str | None


#: what the sweep does with the day's row: leave it, write it only if its figures moved, or write it
#: regardless — the last so a provisional row is restamped even when nothing moved
type SampleWrite = Literal["no", "if-changed", "yes"]


def takes_sample(now: datetime, stored: StoredSample | None, observed: SampleReadings) -> SampleWrite:
    """What the sweep at `now` does with the day's row, given the row stored for that market day (None
    if none) and the two vol readings this sweep took.

    A stored row is PROVISIONAL when observed before its own day's 09:30 open, SETTLED once observed in
    the hours or after the close; a row without `observed_at` is settled. No row: written, whatever the
    hour. Before the open: only that fill. In the hours: written when the figures moved, and a
    provisional row regardless (a weekend's, restamped). After the close: a provisional row replaced (a
    missed session's evening) — a complete one only by complete readings — a settled row missing its IV or vega completed by a sweep with BOTH, a
    complete settled row never changed. Mirrors `expiry.ts`.
    """
    if stored is None:
        return "yes"
    observed_at = stored["observed_at"]
    provisional = (
        observed_at is not None
        and _since_new_york_midnight(datetime.fromisoformat(observed_at).replace(tzinfo=UTC)) < _SAMPLE_FROM
    )
    t = _since_new_york_midnight(now)
    if t < _SAMPLE_FROM:
        return "no"
    if t <= _SAMPLE_UNTIL:
        return "yes" if provisional else "if-changed"
    incomplete = stored["legs_iv"] is None or stored["legs_vega"] is None
    complete = observed["legs_iv"] is not None and observed["legs_vega"] is not None
    if provisional:
        # a complete provisional row only by complete readings, or the day could lose its Vol for good
        return "yes" if incomplete or complete else "no"
    return "yes" if incomplete and complete else "no"


def days_to_expiry(strike_date: str, now: datetime | None = None) -> int:
    """DTE: expiry day less New York's today. Zero on the day, negative after."""
    expiry = date.fromisoformat(normalize_strike_date(strike_date))
    return (expiry - date.fromisoformat(market_date(now))).days
