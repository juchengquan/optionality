"""DTE, counted from New York's calendar day. Mirrors backend/src/domain/expiry.ts."""

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


def days_to_expiry(strike_date: str, now: datetime | None = None) -> int:
    """DTE: expiry day less New York's today. Zero on the day, negative after."""
    expiry = date.fromisoformat(normalize_strike_date(strike_date))
    return (expiry - date.fromisoformat(market_date(now))).days
