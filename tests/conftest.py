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
