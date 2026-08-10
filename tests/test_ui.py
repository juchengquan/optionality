from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from optionality.service.models import Monitor
from tests.conftest import AUTH


def _future() -> str:
    return (datetime.now(UTC).date() + timedelta(days=30)).isoformat()


def _fetcher(codes, opend_host=None, opend_port=None):
    return [{"code": c, "option_delta": 0.33, "mid_price": 26.4, "bid_price": 26.1, "ask_price": 26.7} for c in codes]


def test_dashboard_renders(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    resp = client.get("/ui", headers=AUTH)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert resp.headers["cache-control"] == "no-store"
    assert 'http-equiv="refresh" content="30"' in resp.text  # 30s auto-refresh
    assert "Add monitor" in resp.text
    assert "Add combo" in resp.text


def test_create_monitor_via_form(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    form = {
        "strike_date": _future(),
        "option_type": "CALL",
        "strike": "8100",
        "field": "option_delta",
        "threshold": "0.6",
        "direction": "above",
    }
    resp = client.post("/ui/monitors", data=form, headers=AUTH, follow_redirects=False)
    assert resp.status_code == 303
    assert resp.headers["location"].endswith("/ui")
    sf = client.app.state.session_factory
    with sf() as s:
        monitor = s.scalar(select(Monitor))
        assert monitor.code.endswith("C8100000")
        assert monitor.threshold == 0.6

    page = client.get("/ui", headers=AUTH)
    assert "C8100000" in page.text or "8100.00C" in page.text


def test_create_monitor_form_error_shows_banner(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    form = {
        "strike_date": "not-a-date",
        "option_type": "CALL",
        "strike": "8100",
        "field": "option_delta",
        "threshold": "0.6",
        "direction": "above",
    }
    resp = client.post("/ui/monitors", data=form, headers=AUTH)  # follows redirect back to /ui
    assert resp.status_code == 200
    assert "strike_date" in resp.text  # error banner mentions the problem
    sf = client.app.state.session_factory
    with sf() as s:
        assert s.scalar(select(Monitor)) is None


def test_create_combo_via_form_with_blank_rows(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    form = {
        "name": "web-condor",
        "strike_date": _future(),
        "field": "mid_price",
        "threshold": "10",
        "direction": "below",
        "sign_1": "+",
        "option_type_1": "CALL",
        "strike_1": "8100",
        "sign_2": "-",
        "option_type_2": "CALL",
        "strike_2": "8150",
        "sign_3": "+",
        "option_type_3": "PUT",
        "strike_3": "",  # blank rows are skipped
        "sign_4": "+",
        "option_type_4": "PUT",
        "strike_4": "",
        "sign_5": "+",
        "option_type_5": "CALL",
        "strike_5": "",
        "sign_6": "+",
        "option_type_6": "CALL",
        "strike_6": "",
    }
    resp = client.post("/ui/combos", data=form, headers=AUTH, follow_redirects=False)
    assert resp.status_code == 303
    sf = client.app.state.session_factory
    with sf() as s:
        combo = s.scalar(select(Monitor))
        assert combo.code == "web-condor"
        assert len(combo.legs) == 2
        assert combo.legs[1]["sign"] == -1


def test_row_actions_threshold_mute_delete(client_factory):
    client = client_factory(snapshot_fetcher=_fetcher)
    payload = {"strike_date": _future(), "option_type": "CALL", "strike": 8100, "threshold": 0.6}
    mid = client.post("/monitors", json=payload, headers=AUTH).json()["id"]

    resp = client.post(f"/ui/monitors/{mid}/threshold", data={"threshold": "0.5"}, headers=AUTH)
    assert resp.status_code == 200
    sf = client.app.state.session_factory
    with sf() as s:
        assert s.get(Monitor, mid).threshold == 0.5

    client.post(f"/ui/monitors/{mid}/toggle", data={}, headers=AUTH)
    with sf() as s:
        assert s.get(Monitor, mid).enabled is False
    page = client.get("/ui", headers=AUTH)
    assert "Muted" in page.text  # muted section appears with the disabled monitor

    client.post(f"/ui/monitors/{mid}/toggle", data={}, headers=AUTH)
    with sf() as s:
        assert s.get(Monitor, mid).enabled is True

    client.post(f"/ui/monitors/{mid}/delete", data={}, headers=AUTH)
    with sf() as s:
        assert s.get(Monitor, mid) is None
