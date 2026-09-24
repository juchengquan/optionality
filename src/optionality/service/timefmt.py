from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

# moomoo delivers market timestamps as naive strings in US Eastern exchange time
MARKET_TZ = ZoneInfo("America/New_York")


def _resolve(tz_name: str):
    if tz_name:
        return ZoneInfo(tz_name)
    return datetime.now(UTC).astimezone().tzinfo


def display_time(dt: datetime | None, tz_name: str = "") -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)  # SQLite round-trips lose tzinfo; stored values are UTC
    return dt.astimezone(_resolve(tz_name)).isoformat(sep=" ", timespec="seconds")


def display_time_short(dt: datetime | None, tz_name: str = "") -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    local = dt.astimezone(_resolve(tz_name))
    return f"{local:%Y-%m-%d %H:%M} {local.tzname()}"


def market_time_to_display(value: str, tz_name: str = "") -> str:
    try:
        dt = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return value
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=MARKET_TZ)
    return dt.astimezone(_resolve(tz_name)).isoformat(sep=" ", timespec="seconds")


def days_to_expiry(strike_date: str) -> int:
    """Calendar days from the current MARKET date to expiry.

    Market date, not DISPLAY_TZ: at 09:40 in Singapore it is still the previous
    afternoon in New York, and an option's remaining life is counted where it trades.
    This is why the figure can differ by one from the local calendar — and why it
    agrees with moomoo's own option_expiry_date_distance.
    """
    today = datetime.now(MARKET_TZ).date()
    return (date.fromisoformat(strike_date) - today).days
