from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from optionality.service.models import Monitor
from optionality.service.monitor import DEGRADED_AFTER, MonitorSweeper, watchlist_quotes
from optionality.service.settings import Settings

SETTINGS = Settings(telegram_bot_token="t", telegram_chat_id="c")

CODE = "US.SPXW261218C6500000"


def _future() -> str:
    return (datetime.now(UTC).date() + timedelta(days=30)).isoformat()


def _past() -> str:
    return (datetime.now(UTC).date() - timedelta(days=1)).isoformat()


class Recorder:
    def __init__(self):
        self.messages = []

    def __call__(self, token, chat_id, text):
        self.messages.append(text)


def _mk_monitor(session_factory, **kw):
    defaults = {
        "code": CODE,
        "strike_date": _future(),
        "option_type": "CALL",
        "strike": 6500.0,
        "field": "option_delta",
        "threshold": 0.6,
    }
    defaults.update(kw)
    with session_factory() as s:
        m = Monitor(**defaults)
        s.add(m)
        s.commit()
        return m.id


def _make_sweeper(session_factory, values: dict):
    recorder = Recorder()

    def fetcher(codes, opend_host=None, opend_port=None):
        return [{"code": c, "name": c, "option_delta": values[c]} for c in codes if c in values]

    return MonitorSweeper(session_factory, SETTINGS, fetcher=fetcher, sender=recorder), recorder


def test_breach_fires_once_and_updates_state(session_factory):
    mid = _mk_monitor(session_factory)
    values = {CODE: 0.7}
    sweeper, recorder = _make_sweeper(session_factory, values)

    sweeper.sweep()
    sweeper.sweep()  # still breached: edge-triggered, no second alarm

    assert len(recorder.messages) == 1
    assert "0.7" in recorder.messages[0]
    with session_factory() as s:
        m = s.get(Monitor, mid)
        assert m.triggered is True
        assert m.last_value == 0.7
        assert m.last_checked_at is not None


def test_abs_comparison_covers_negative_put_delta(session_factory):
    _mk_monitor(session_factory, code="US.SPXW261218P6425000", option_type="PUT", strike=6425.0)
    sweeper, recorder = _make_sweeper(session_factory, {"US.SPXW261218P6425000": -0.7})
    sweeper.sweep()
    assert len(recorder.messages) == 1


def test_hysteresis_rearm_cycle(session_factory):
    _mk_monitor(session_factory, threshold=0.6)
    values = {CODE: 0.61}
    sweeper, recorder = _make_sweeper(session_factory, values)

    sweeper.sweep()  # breach -> alarm
    values[CODE] = 0.59
    sweeper.sweep()  # inside hysteresis band (>= 0.57): stays triggered, silent
    assert len(recorder.messages) == 1

    values[CODE] = 0.55
    sweeper.sweep()  # below 0.6*0.95: recovery message, re-armed
    assert len(recorder.messages) == 2
    assert "back below" in recorder.messages[1]

    values[CODE] = 0.61
    sweeper.sweep()  # re-armed: fires again
    assert len(recorder.messages) == 3


def test_expired_monitor_auto_disabled_and_not_fetched(session_factory):
    mid = _mk_monitor(session_factory, strike_date=_past())
    calls = []

    def fetcher(codes, opend_host=None, opend_port=None):
        calls.append(codes)
        return []

    recorder = Recorder()
    sweeper = MonitorSweeper(session_factory, SETTINGS, fetcher=fetcher, sender=recorder)
    sweeper.sweep()

    assert calls == []  # nothing active -> no API call
    with session_factory() as s:
        assert s.get(Monitor, mid).enabled is False


def test_watchdog_degraded_and_recovery(session_factory):
    _mk_monitor(session_factory)
    state = {"fail": True}

    def fetcher(codes, opend_host=None, opend_port=None):
        if state["fail"]:
            raise RuntimeError("Client connection failed!")
        return [{"code": CODE, "name": CODE, "option_delta": 0.1}]

    recorder = Recorder()
    sweeper = MonitorSweeper(session_factory, SETTINGS, fetcher=fetcher, sender=recorder)

    for _ in range(DEGRADED_AFTER + 1):
        sweeper.sweep()
    degraded = [m for m in recorder.messages if "degraded" in m]
    assert len(degraded) == 1  # edge-triggered, not once per failure
    assert sweeper.consecutive_failures == DEGRADED_AFTER + 1
    assert sweeper.last_sweep_ok is False

    state["fail"] = False
    sweeper.sweep()
    assert any("recovered" in m for m in recorder.messages)
    assert sweeper.consecutive_failures == 0
    assert sweeper.last_sweep_ok is True


def test_missing_field_is_skipped_not_crashed(session_factory):
    mid = _mk_monitor(session_factory, field="option_vega")

    def fetcher(codes, opend_host=None, opend_port=None):
        return [{"code": CODE, "name": CODE, "option_delta": 0.9}]  # no option_vega key

    recorder = Recorder()
    sweeper = MonitorSweeper(session_factory, SETTINGS, fetcher=fetcher, sender=recorder)
    sweeper.sweep()

    assert recorder.messages == []
    with session_factory() as s:
        assert s.get(Monitor, mid).last_value is None


def test_watchlist_quotes_merges_monitor_and_snapshot(session_factory):
    _mk_monitor(session_factory)

    def fetcher(codes, opend_host=None, opend_port=None):
        return [{"code": CODE, "name": "SPXW TEST", "option_delta": 0.91, "bid_price": 1365.6}]

    quotes = watchlist_quotes(session_factory, SETTINGS, fetcher)
    assert len(quotes) == 1
    assert quotes[0]["code"] == CODE
    assert quotes[0]["threshold"] == 0.6
    assert quotes[0]["snapshot"]["option_delta"] == 0.91


def test_watchlist_quotes_empty_without_fetch(session_factory):
    calls = []

    def fetcher(codes, opend_host=None, opend_port=None):
        calls.append(codes)
        return []

    assert watchlist_quotes(session_factory, SETTINGS, fetcher) == []
    assert calls == []  # no monitors -> no API call


def test_unconfigured_telegram_suppresses_send(session_factory):
    _mk_monitor(session_factory)
    sent = []
    sweeper = MonitorSweeper(
        session_factory,
        Settings(),  # no telegram creds
        fetcher=lambda codes, opend_host=None, opend_port=None: [{"code": CODE, "option_delta": 0.9}],
        sender=lambda *a: sent.append(a),
    )
    sweeper.sweep()
    assert sent == []  # alarm suppressed, no crash
    with session_factory() as s:
        assert s.scalar(select(Monitor)).triggered is True  # state still tracked
