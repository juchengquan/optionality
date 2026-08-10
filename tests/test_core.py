import pandas as pd
import pytest

from optionality import core


class FakeClient:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


def test_load_config_dispatch(holdings_body, strategy_body):
    from optionality.datatype import OptionHoldingsConfig, OptionStrategiesConfig

    assert isinstance(core.load_config("holdings", holdings_body), OptionHoldingsConfig)
    assert isinstance(core.load_config("strategy", strategy_body), OptionStrategiesConfig)
    with pytest.raises(ValueError):
        core.load_config("nope", holdings_body)


def test_run_task_holdings_builds_report_and_closes_client(monkeypatch, holdings_body):
    df_summary = pd.DataFrame([{"strike_date": "2026-12-18", "strategy": "iron_condor", "mid_price": 1.0}])
    dt_details = {"2026-12-18": {"ab12": pd.DataFrame([{"code": "X", "mid_price": 1.0}])}}
    df_warning = pd.DataFrame([{"strike_date": "2026-12-18", "code": "X", "option_delta": 0.5}])
    monkeypatch.setattr(core, "get_option_holdings_info", lambda client, cfg: (df_summary, dt_details, df_warning))

    fake = FakeClient()
    config = core.load_config("holdings", holdings_body)
    result = core.run_task("holdings", config, client_factory=lambda host, port: fake)

    assert "Summary:" in result.html
    assert result.summary[0]["strategy"] == "iron_condor"
    assert result.warnings[0]["code"] == "X"
    assert result.details == [{"strike_date": "2026-12-18", "group": "ab12", "code": "X", "mid_price": 1.0}]
    assert fake.closed


def test_fetch_snapshot_returns_records_and_closes_client():
    class FakeSnapClient:
        def __init__(self):
            self.closed = False
            self.requested = None

        def get_market_snapshot(self, codes):
            self.requested = codes
            return 0, pd.DataFrame([{"code": codes[0], "last_price": 12.3, "bid_price": 10.0, "ask_price": 11.0}])

        def close(self):
            self.closed = True

    fake = FakeSnapClient()
    records = core.fetch_snapshot(["US.SPXW261218C6500000"], client_factory=lambda host, port: fake)
    assert records[0]["last_price"] == 12.3
    assert records[0]["mid_price"] == 10.5  # computed from bid/ask
    assert fake.requested == ["US.SPXW261218C6500000"]
    assert fake.closed


def test_fetch_snapshot_skips_mid_without_both_sides():
    class OneSidedClient:
        def get_market_snapshot(self, codes):
            return 0, pd.DataFrame([{"code": codes[0], "bid_price": 10.0, "ask_price": None}])

        def close(self):
            pass

    records = core.fetch_snapshot(["X"], client_factory=lambda host, port: OneSidedClient())
    assert "mid_price" not in records[0]


def test_fetch_snapshot_raises_on_api_error():
    class FailingClient:
        def __init__(self):
            self.closed = False

        def get_market_snapshot(self, codes):
            return -1, "quota exceeded"

        def close(self):
            self.closed = True

    fake = FailingClient()
    with pytest.raises(RuntimeError, match="quota exceeded"):
        core.fetch_snapshot(["X"], client_factory=lambda host, port: fake)
    assert fake.closed


def test_run_task_closes_client_on_error(monkeypatch, holdings_body):
    def boom(client, cfg):
        raise RuntimeError("api down")

    monkeypatch.setattr(core, "get_option_holdings_info", boom)
    fake = FakeClient()
    config = core.load_config("holdings", holdings_body)
    with pytest.raises(RuntimeError):
        core.run_task("holdings", config, client_factory=lambda host, port: fake)
    assert fake.closed


def test_send_notifications_writes_file(tmp_path, holdings_body):
    body = dict(holdings_body)
    body["notification"] = {"file": {"file_path": str(tmp_path / "r.html")}}
    config = core.load_config("holdings", body)
    core.send_notifications(config.notification, "<p>hello</p>")
    assert (tmp_path / "r.html").read_text() == "<p>hello</p>"
