"""The API must carry everything the dashboard shows.

ADR 0002 promised a rebuild would be a frontend project rather than a backend redesign, and
that promise lapsed: scope, the Position link, cost_to_close, entry, pnl, fill and dte were
computed in routes/ui.py and rendered straight into HTML, reachable over no endpoint at all.
These tests exist so that cannot happen silently again.
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import select

from optionality.service import routes
from optionality.service.contract import CONTRACT_VERSION
from optionality.service.models import Monitor, monitor_positions
from tests.conftest import AUTH


def _future() -> str:
    return (datetime.now(UTC).date() + timedelta(days=30)).isoformat()


def _fetcher(codes, opend_host=None, opend_port=None):
    mids = {"C8050": 5.0, "C8075": 2.0, "P7100": 3.0, "P7075": 1.5}
    return [
        {
            "code": c,
            "mid_price": next((v for k, v in mids.items() if c.endswith(k + "000")), 1.0),
            "option_delta": 0.12,
            "option_contract_size": 100.0,
        }
        for c in codes
    ]


def _legged_condor(client):
    """The live shape: two credit spreads, a rule on one wing, a rule spanning both."""
    made = {}
    for name, legs in (
        ("calls_side", [("sold", "CALL", 8050), ("bought", "CALL", 8075)]),
        ("puts_side", [("sold", "PUT", 7100), ("bought", "PUT", 7075)]),
    ):
        made[name] = client.post(
            "/positions",
            json={
                "name": name,
                "strike_date": _future(),
                "entry": 1.8 if name == "calls_side" else 1.2,
                "contracts": 1,
                "legs": [{"side": s, "option_type": t, "strike": k} for s, t, k in legs],
            },
            headers=AUTH,
        ).json()
    sf = client.app.state.session_factory
    with sf() as s:
        for code, scope in (("wing_rule", "all"), ("condor_rule", "all")):
            s.add(
                Monitor(
                    code=code,
                    strike_date=_future(),
                    option_type="CMB",
                    strike=0.0,
                    field="mid_price",
                    threshold=9.0,
                    scope=scope,
                    legs=[{"sign": -1, "option_type": "CALL", "strike": 8050.0}],
                )
            )
        s.flush()
        wing = s.scalar(select(Monitor.id).where(Monitor.code == "wing_rule"))
        condor = s.scalar(select(Monitor.id).where(Monitor.code == "condor_rule"))
        s.execute(monitor_positions.insert().values(monitor_id=wing, position_id=made["calls_side"]["id"]))
        for p in made.values():
            s.execute(monitor_positions.insert().values(monitor_id=condor, position_id=p["id"]))
        s.commit()
    return made


def test_quotes_carries_what_the_dashboard_renders(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    _legged_condor(client)
    client.app.state.sweeper.sweep()

    entries = client.get("/quotes", headers=AUTH).json()
    condor = next(e for e in entries if e["code"] == "condor_rule")

    # a client must be able to learn all of this without re-deriving it
    assert condor["dte"] >= 29
    assert condor["scope"] == "all"
    assert {p["name"] for p in condor["positions"]} == {"calls_side", "puts_side"}
    assert condor["cost_to_close"] == 4.5  # (5.0 + 3.0) - (2.0 + 1.5)
    assert condor["entry"] == 3.0  # 1.8 + 1.2, summed across the wings
    assert condor["pnl"] == -150.0  # sold for 3.00, costs 4.50 to close
    assert condor["fill"] == 50  # 4.5 against a threshold of 9.0


def test_a_wing_rule_reports_only_its_own_holding(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    _legged_condor(client)
    client.app.state.sweeper.sweep()
    wing = next(e for e in client.get("/quotes", headers=AUTH).json() if e["code"] == "wing_rule")
    assert [p["name"] for p in wing["positions"]] == ["calls_side"]
    assert wing["cost_to_close"] == 3.0  # the call wing alone
    assert wing["entry"] == 1.8


def test_monitors_says_which_position_it_watches(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    _legged_condor(client)
    listed = {m["code"]: m for m in client.get("/monitors", headers=AUTH).json()}
    # the omission that made a React client impossible: no scope, no position link
    assert listed["wing_rule"]["scope"] == "all"
    assert [p["name"] for p in listed["condor_rule"]["positions"]] == ["calls_side", "puts_side"]


def test_the_api_serves_no_frontend(client_factory):
    """Successor to the _quote_rows acceptance test, which guarded the rule that every
    figure must be reachable over HTTP rather than computed while rendering. Caddy serves
    the dashboard now (ADR 0006), so the rule has a blunter form: there is no rendering
    here to hide arithmetic in, and nothing that would quietly grow one back."""
    client = client_factory(snapshot_fetcher=_fetcher)

    for path in ("/ui", "/app", "/static/app/index.html"):
        assert client.get(path, headers=AUTH).status_code == 404, f"{path} belongs to Caddy"

    package = Path(routes.__file__).resolve().parent.parent
    assert not (package / "templates").exists()
    assert not (package / "static").exists()


def test_health_carries_what_the_status_strip_shows(client_factory):
    """The alarm label and the two settings a client needs were computed in routes/ui.py."""
    client = client_factory(snapshot_fetcher=_fetcher, monitor_interval_seconds=15)
    h = client.get("/health", headers=AUTH).json()

    # "starting" is only honest before the first sweep, and one now runs at startup
    assert h["monitor"]["alarms"] == {"label": "active", "bad": False}
    # the muted table counts down to the one auto-delete in the system, and the meta line
    # names the sweep cadence; neither figure was reachable over HTTP
    assert h["settings"]["sweep_seconds"] == 15
    assert h["settings"]["expired_retention_days"] == 7

    client.app.state.sweeper.last_sweep_ok = False
    client.app.state.sweeper.consecutive_failures = 3
    assert client.get("/health", headers=AUTH).json()["monitor"]["alarms"] == {
        "label": "STALLED (3 failed sweeps)",
        "bad": True,
    }


def test_health_reports_the_contract_version(client_factory):
    """The dashboard ships separately now (ADR 0006), so it needs a way to notice it is
    older than the API it is talking to. This number is that way."""
    client = client_factory(snapshot_fetcher=_fetcher)

    assert client.get("/health", headers=AUTH).json()["contract_version"] == CONTRACT_VERSION
