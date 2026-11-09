"""The one place the stored datetime format is known (ADR 0009, phase 4). Port of backend/src/db/time.ts.

Storage is SQLAlchemy's: UTC wall time as text, `2026-09-01 15:39:11.940183`, with no offset and six
fractional digits. Keeping that format is what lets either backend open the file the other wrote
(ADR 0021: one database, whichever backend is live), so it is not an implementation detail to tidy.

**Where the Python differs, and why.** A JavaScript `Date` is an instant to the millisecond. A
`datetime` may be NAIVE, and may carry microseconds. So an instant here is an AWARE datetime: a
naive one is refused rather than read as UTC — a `Date` cannot be naive, so a naive datetime is
always a port's bug, and the likeliest one is `datetime.now()`, which would store local wall time as
UTC. And both directions keep milliseconds only, truncating as the TypeScript does, so a row read
and written back by either backend is the same row.
"""

import re
from datetime import UTC, datetime

from optionality.timefmt import display_time


def to_sql_datetime(when: datetime | None = None) -> str:
    """Format an instant the way the Python wrote it — now, when none is given."""
    if when is None:
        when = datetime.now(UTC)
    elif when.utcoffset() is None:
        raise ValueError(f"a naive datetime is not an instant: {when!r}")
    # six digits with the last three zero: a Date has no finer resolution to offer, and the shape
    # stays identical to every row already in the file. `isoformat` truncates to the millisecond
    # rather than rounding, as a Date's own clock does.
    utc = when.astimezone(UTC).replace(tzinfo=None)
    return f"{utc.isoformat(sep=' ', timespec='milliseconds')}000"


# ASCII and matched whole: JavaScript's `\d` is ASCII and its `$` is the end of the text, where
# Python's `\d` takes any Unicode digit and its `$` also matches before a final newline
SQL_DATETIME = re.compile(r"(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?", re.ASCII)


def from_sql_datetime(value: str) -> datetime:
    """Read a stored datetime, as an aware datetime in UTC."""
    m = SQL_DATETIME.fullmatch(value)
    if not m:
        raise ValueError(f"not a stored datetime: {value}")
    # truncated to milliseconds, not rounded — a Date cannot hold microseconds. Everything that reads
    # these compares them in seconds (the alarm cooldown, the sweep watchdog), so the lost digits
    # cannot change a decision; it is recorded here so nobody later assumes a round trip.
    ms = (m[3] or "").ljust(3, "0")[:3]
    try:
        # the zone is the point: without it the text is naive, and anything that later converts it
        # reads it as the machine's local time
        return datetime.fromisoformat(f"{m[1]}T{m[2]}.{ms}").replace(tzinfo=UTC)
    except ValueError:
        # A time that never existed. JavaScript rolls some over (30 February is 2 March, 24:00 the
        # next midnight) and answers an Invalid Date for the rest (month 13, minute 60); a datetime
        # can hold neither. No row holds one either, since every row is written by to_sql_datetime,
        # so this refuses all of them in the words used for any other text that is not a datetime.
        raise ValueError(f"not a stored datetime: {value}") from None


def display_stored(stored: str | None, tz_name: str = "") -> str | None:
    """A stored timestamp as the API reports it. Stored text in, display string out — the two
    conversions always travel together, and splitting them is how a naive parse creeps in.

    Here rather than in the library's `timefmt`, which is pure and canonical: reading the storage
    format is the database's business, and the one thing this adds."""
    if stored is None:
        return None
    return display_time(from_sql_datetime(stored), tz_name)
