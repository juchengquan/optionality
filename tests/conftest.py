import pytest

HOLDINGS_BODY = {
    "notification": {"file": {"file_path": "./out.html"}},
    "code_information": {"type": "index", "name": "SPX", "market": "US"},
    "option_holdings": [
        {
            "strategy": "iron_condor",
            "strike_date": "2026-12-18",
            "volume": 1,
            "entry_price": 1.25,
            "warning_threshold": {"delta": 0.3},
            "options": [{"type": "CALL", "direction": "short", "strike_price": 6500.0}],
        }
    ],
}

STRATEGY_BODY = {
    "notification": {"file": {"file_path": "./out.html"}},
    "code_information": {"type": "index", "name": "SPX", "market": "US"},
    "option_strategy": {
        "strategy": "iron_condor",
        "expiry_date_distance": {"min": 5, "max": 20},
        "options": [
            {"option_type": "PUT", "filter": {"delta_min": -0.15, "delta_max": -0.05}, "stride": 25},
            {"option_type": "CALL", "filter": {"delta_min": 0.05, "delta_max": 0.15}, "stride": 25},
        ],
    },
}


@pytest.fixture
def holdings_body():
    return HOLDINGS_BODY


@pytest.fixture
def strategy_body():
    return STRATEGY_BODY


@pytest.fixture
def engine(tmp_path):
    from optionality.service.db import init_db, make_engine

    eng = make_engine(str(tmp_path / "test.db"))
    init_db(eng)
    return eng


@pytest.fixture
def session_factory(engine):
    from optionality.service.db import make_session_factory

    return make_session_factory(engine)


AUTH = {"Authorization": "Bearer tok"}


def _stub_runner(task, config, client_factory=None, opend_host=None, opend_port=None):
    from optionality.core import RunResult

    return RunResult(
        html="<p>stub</p>",
        summary=[{"strike_date": "2026-12-18"}],
        warnings=None,
        details=[
            {"strike_date": "2026-12-18", "group": "ab12", "code": "US.SPXW261218C6500000", "mid_price": 1377.6},
            {"strike_date": "2026-12-18", "group": "ab12", "code": "US.SPXW261218P6425000", "mid_price": 12.4},
        ],
    )


def _echo_fetcher(codes, opend_host=None, opend_port=None):
    # permissive default: every requested contract "exists"
    return [{"code": c} for c in codes]


@pytest.fixture
def client_factory(tmp_path):
    from fastapi.testclient import TestClient

    from optionality.service.app import create_app
    from optionality.service.settings import Settings

    clients = []

    def make(
        token="tok",
        runner=_stub_runner,
        opend_port=1,
        root_path="",
        snapshot_fetcher=None,
        ui_refresh_seconds=30,
        monitor_interval_seconds=5,  # the dashboard refresh floor; low so tests can pick any interval
    ):
        snapshot_fetcher = snapshot_fetcher or _echo_fetcher  # never let tests touch the real moomoo SDK
        settings = Settings(
            db_path=str(tmp_path / "app.db"),
            api_token=token,
            opend_port=opend_port,
            root_path=root_path,
            display_tz="Asia/Singapore",
            ui_refresh_seconds=ui_refresh_seconds,
            monitor_interval_seconds=monitor_interval_seconds,
        )
        client = TestClient(create_app(settings=settings, runner=runner, snapshot_fetcher=snapshot_fetcher))
        client.__enter__()  # run lifespan (starts worker + scheduler)
        clients.append(client)
        return client

    yield make
    for c in clients:
        c.__exit__(None, None, None)
