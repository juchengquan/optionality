"""Timestamps for display. Mirrors backend/src/domain/timefmt.ts.

Storage is UTC and display converts to a named zone; an empty zone means the machine's own. moomoo's
`update_time` arrives as naive US/Eastern wall time and means the LAST TRADE, not freshness.

`market_time_to_display` resolves New York wall time to an instant with the TypeScript's own
algorithm rather than zoneinfo's `fold`, so an hour that happens twice or not at all lands where the
service puts it.
"""

import calendar
import re
from datetime import UTC, datetime, timedelta, tzinfo
from zoneinfo import ZoneInfo

from optionality.expiry import MARKET_TZ


def _zone(tz_name: str) -> tzinfo | None:
    return ZoneInfo(tz_name) if tz_name else None


def _local(when: datetime, tz_name: str) -> datetime:
    when = when if when.tzinfo else when.replace(tzinfo=UTC)
    return when.astimezone(_zone(tz_name))


def _offset(local: datetime) -> str:
    minutes = round(local.utcoffset().total_seconds() / 60)
    sign = "-" if minutes < 0 else "+"
    hours, rest = divmod(abs(minutes), 60)
    return f"{sign}{hours:02d}:{rest:02d}"


def display_time(when: datetime | None, tz_name: str = "") -> str | None:
    """`2026-10-17 13:26:06+08:00`, to the second."""
    if when is None:
        return None
    local = _local(when, tz_name)
    return f"{local:%Y-%m-%d %H:%M:%S}{_offset(local)}"


def display_time_short(when: datetime | None, tz_name: str = "") -> str | None:
    """`2026-10-17 13:26 +08`, as the bot prints it.

    The zone is named with tzdata's abbreviation. The TypeScript names it with ICU's, and the two
    agree on America/New_York, UTC and every zone whose abbreviation IS an offset — Asia/Singapore
    among them — but not where only tzdata has a name (Asia/Kolkata's IST, Europe/Paris's CET). The
    TypeScript records the same divergence; there is no faithful way to drop names Python has.
    """
    if when is None:
        return None
    local = _local(when, tz_name)
    return f"{local:%Y-%m-%d %H:%M} {local.tzname()}"


_MARKET_TIME = re.compile(r"(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?")


def _naive_instant(y: str, mo: str, d: str, h: str, mi: str, s: str, frac: str) -> int | None:
    """The wall time as if it were UTC, in ms, or None if it is not a real time. 24:00 is allowed."""
    year, month, day, hour, minute, second = (int(v) for v in (y, mo, d, h, mi, s))
    if not 1 <= month <= 12:
        return None
    last_day = calendar.monthrange(year, month)[1]
    if not 1 <= day <= last_day:
        return None
    if minute > 59 or second > 59:
        return None
    if hour == 24:
        if minute != 0 or second != 0 or int(frac) != 0:
            return None
    elif hour > 23:
        return None
    # the fraction is dropped, as Date.UTC is given no milliseconds
    moment = datetime(year, month, day, tzinfo=UTC) + timedelta(hours=hour, minutes=minute, seconds=second)
    return round(moment.timestamp() * 1000)


def _offset_minutes(ms: int, tz_name: str) -> int:
    return round(datetime.fromtimestamp(ms / 1000, ZoneInfo(tz_name)).utcoffset().total_seconds() / 60)


def _instant_of_wall_time(wall_as_utc: int, tz_name: str) -> int:
    first = wall_as_utc - _offset_minutes(wall_as_utc, tz_name) * 60_000
    if _offset_minutes(first, tz_name) * 60_000 == wall_as_utc - first:
        return first
    second = wall_as_utc - _offset_minutes(first, tz_name) * 60_000
    if _offset_minutes(second, tz_name) * 60_000 == wall_as_utc - second:
        return second
    return max(first, second)


def market_time_to_display(value: str, tz_name: str = "") -> str:
    """moomoo's naive Eastern `update_time`, shown in `tz_name`. Anything that is not a real time comes
    back untouched: a quote with one odd field is still worth showing."""
    m = _MARKET_TIME.fullmatch(value)
    if not m:
        return value
    y, mo, d, h, mi, s, frac = m.groups()
    naive = _naive_instant(y, mo, d, h, mi, s or "0", frac or "0")
    if naive is None:
        return value
    instant = _instant_of_wall_time(naive, MARKET_TZ)
    return display_time(datetime.fromtimestamp(instant / 1000, UTC), tz_name)
