from datetime import UTC, datetime

from optionality.service.timefmt import display_time, display_time_short, market_time_to_display

TZ = "Asia/Singapore"


def test_display_time_converts_utc():
    dt = datetime(2026, 8, 10, 3, 35, 32, tzinfo=UTC)
    assert display_time(dt, TZ) == "2026-08-10 11:35:32+08:00"


def test_display_time_treats_naive_as_utc():
    # SQLite round-trips lose tzinfo; stored values are UTC by construction
    assert display_time(datetime(2026, 8, 10, 3, 35, 32), TZ) == "2026-08-10 11:35:32+08:00"  # noqa: DTZ001


def test_display_time_none_passthrough():
    assert display_time(None, TZ) is None


def test_display_time_short():
    dt = datetime(2026, 8, 10, 3, 35, 32, tzinfo=UTC)
    assert display_time_short(dt, TZ) == "2026-08-10 11:35 +08"


def test_market_time_parsed_as_eastern():
    # Sunday 20:15 ET (EDT, UTC-4) == Monday 08:15 SGT
    assert market_time_to_display("2026-08-09 20:15:00", TZ) == "2026-08-10 08:15:00+08:00"


def test_market_time_garbage_passthrough():
    assert market_time_to_display("N/A", TZ) == "N/A"
