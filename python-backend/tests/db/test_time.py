"""The stored datetime format. Port of backend/src/db/time.test.ts, test for test.

Nothing in the old Python service tested this directly — it was SQLAlchemy's business there — which
is exactly why it needs testing here, where it is ours (ADR 0009). The two tests at the end are the
Python's own: they hold the two places a `datetime` can do what a JavaScript `Date` cannot.
"""

import os
import time
from datetime import UTC, datetime, timedelta, timezone

import pytest

from optionality_backend.db.time import display_stored, from_sql_datetime, to_sql_datetime


def iso(when: datetime) -> str:
    """`Date.prototype.toISOString`, so each assertion reads as the TypeScript's does. It refuses a
    naive datetime rather than guessing a zone for it, which would hide the bug these tests hunt."""
    assert when.utcoffset() is not None, f"not an instant: {when!r}"
    return when.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def at(text: str) -> datetime:
    """`new Date("2026-09-01T15:39:11.940Z")`."""
    return datetime.fromisoformat(text)


@pytest.fixture
def zone():
    """Move the process's own zone, as the TypeScript moves `process.env.TZ`. Python reads `TZ` only
    when `time.tzset()` is called, so this calls it, and puts both back afterwards — by hand rather
    than through `monkeypatch`, which would restore the variable AFTER this re-read it."""
    before = os.environ.get("TZ")

    def move(tz: str) -> None:
        os.environ["TZ"] = tz
        time.tzset()

    yield move
    if before is None:
        os.environ.pop("TZ", None)
    else:
        os.environ["TZ"] = before
    time.tzset()


class TestWriting:
    def test_writes_utc_wall_time_in_sqlalchemys_shape(self):
        assert to_sql_datetime(at("2026-09-01T15:39:11.940Z")) == "2026-09-01 15:39:11.940000"

    def test_pads_the_fraction_to_six_digits_as_every_existing_row_has(self):
        assert to_sql_datetime(at("2026-09-01T15:39:11.000Z")) == "2026-09-01 15:39:11.000000"
        assert to_sql_datetime(at("2026-09-01T15:39:11.007Z")) == "2026-09-01 15:39:11.007000"


class TestReading:
    def test_reads_a_six_digit_fraction_as_a_real_row_has_it(self):
        # a monitor's created_at, copied from the live database
        assert iso(from_sql_datetime("2026-09-01 15:39:11.940183")) == "2026-09-01T15:39:11.940Z"

    def test_truncates_below_the_millisecond_rather_than_rounding(self):
        # 999999 microseconds is 999.999 ms; rounding would carry into the next second and make a
        # timestamp that never existed
        assert iso(from_sql_datetime("2026-09-01 15:39:11.999999")) == "2026-09-01T15:39:11.999Z"

    def test_takes_a_fraction_of_any_length_and_none_at_all(self):
        assert iso(from_sql_datetime("2026-09-01 15:39:11")) == "2026-09-01T15:39:11.000Z"
        assert iso(from_sql_datetime("2026-09-01 15:39:11.9")) == "2026-09-01T15:39:11.900Z"
        assert iso(from_sql_datetime("2026-09-01 15:39:11.94")) == "2026-09-01T15:39:11.940Z"

    def test_refuses_text_that_is_not_a_stored_datetime(self):
        for bad in ["", "2026-09-01", "01/09/2026 15:39:11", "2026-09-01 15:39:11+08:00"]:
            with pytest.raises(ValueError, match="not a stored datetime"):
                from_sql_datetime(bad)


class TestTheZoneTheTextIsIn:
    def test_is_utc_regardless_of_the_machines_own_zone(self, zone):
        # The suite pins TZ=UTC, which would HIDE a missing zone: a naive parse and a UTC parse agree
        # there. So this test moves the zone on purpose, and under Singapore a naive parse of this
        # text would land eight hours early.
        zone("Asia/Singapore")
        assert iso(from_sql_datetime("2026-09-01 15:39:11.940183")) == "2026-09-01T15:39:11.940Z"
        zone("America/New_York")
        assert iso(from_sql_datetime("2026-09-01 15:39:11.940183")) == "2026-09-01T15:39:11.940Z"

    def test_round_trips_through_both_directions_in_any_zone(self, zone):
        for tz in ["UTC", "Asia/Singapore", "America/New_York", "Pacific/Kiritimati"]:
            zone(tz)
            stored = "2026-09-01 15:39:11.940000"
            assert to_sql_datetime(from_sql_datetime(stored)) == stored, tz


#: the owner's zone, so a UTC-only result cannot pass by coincidence
DISPLAY_TZ = "Asia/Singapore"


class TestDisplayStored:
    def test_reads_stored_text_and_renders_it_in_the_display_zone(self):
        # SQLite round-trips lose tzinfo; stored values are UTC by construction (CLAUDE.md)
        assert display_stored("2026-08-10 03:35:32.000000", DISPLAY_TZ) == "2026-08-10 11:35:32+08:00"

    def test_passes_null_through(self):
        assert display_stored(None, DISPLAY_TZ) is None


class TestWhatOnlyPythonCanGetWrong:
    def test_writes_an_instant_in_utc_whatever_zone_it_carries_and_to_the_millisecond(self):
        # a JavaScript Date is an instant with milliseconds; a datetime may carry a zone and
        # microseconds. Both are taken off here, the zone by converting and the microseconds by
        # truncating, so the row is the one the TypeScript would have written for the same instant.
        singapore = timezone(timedelta(hours=8))
        when = datetime(2026, 9, 1, 23, 39, 11, 940999, tzinfo=singapore)
        assert to_sql_datetime(when) == "2026-09-01 15:39:11.940000"

    def test_refuses_a_naive_datetime_which_is_not_an_instant(self):
        # a Date cannot be naive, so a naive datetime here is always a port's bug — `datetime.now()`
        # without a zone — and reading it as UTC would store local wall time eight hours wrong
        with pytest.raises(ValueError, match="naive"):
            to_sql_datetime(datetime(2026, 9, 1, 15, 39, 11))

    def test_refuses_what_pythons_regex_would_let_through(self):
        # `$` matches before a final newline and `\d` matches every Unicode digit; JavaScript's
        # match neither, so the pattern is ASCII and matched whole
        for bad in ["2026-09-01 15:39:11\n", "٢٠٢٦-09-01 15:39:11"]:
            with pytest.raises(ValueError, match="not a stored datetime"):
                from_sql_datetime(bad)

    def test_refuses_a_time_that_never_existed(self):
        # JavaScript rolls the first two over (to 2 March, and to the next midnight) and answers an
        # Invalid Date for the last two. A datetime can hold neither an Invalid Date nor a 30th of
        # February, and no row holds one either: every row is written by to_sql_datetime.
        for bad in ["2026-02-30 00:00:00", "2026-09-01 24:00:00", "2026-13-01 00:00:00", "2026-09-01 23:60:00"]:
            with pytest.raises(ValueError, match="not a stored datetime"):
                from_sql_datetime(bad)
