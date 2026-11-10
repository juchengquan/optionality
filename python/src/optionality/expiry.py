"""DTE, counted from New York's calendar day. Mirrors typescript/src/domain/expiry.ts."""

from datetime import UTC, date, datetime
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


# 09:30 and 16:00 in New York, as milliseconds since its midnight
_SAMPLE_FROM = (9 * 60 + 30) * 60_000
_SAMPLE_UNTIL = 16 * 60 * 60_000


def in_sample_hours(now: datetime | None = None) -> bool:
    """Whether a holding's daily sample may be taken at `now`: 09:30 to 16:00 in New York, both ends
    included, on EVERY calendar day.

    The sample is the day's CLOSE: outside these hours the day's row was rewritten by Global Trading
    Hours marks until New York's midnight. Every day, weekends included, because `vol_attribution`
    chains samples exactly one calendar day apart — a Saturday's row is the Friday close carried
    forward, a holiday's the previous close, a half-day's its own close. Mirrors `expiry.ts`.
    """
    ny = _aware(now).astimezone(ZoneInfo(MARKET_TZ))
    # milliseconds, truncated, because a JavaScript Date carries no finer clock than that and the
    # boundaries are compared to the millisecond on both sides
    since_midnight = ((ny.hour * 60 + ny.minute) * 60 + ny.second) * 1000 + ny.microsecond // 1000
    return _SAMPLE_FROM <= since_midnight <= _SAMPLE_UNTIL


def days_to_expiry(strike_date: str, now: datetime | None = None) -> int:
    """DTE: expiry day less New York's today. Zero on the day, negative after."""
    expiry = date.fromisoformat(normalize_strike_date(strike_date))
    return (expiry - date.fromisoformat(market_date(now))).days
