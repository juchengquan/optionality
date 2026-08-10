from datetime import UTC, datetime, timedelta

from tests.conftest import AUTH


def _future() -> str:
    return (datetime.now(UTC).date() + timedelta(days=30)).isoformat()


def test_monitor_crud_roundtrip(client_factory):
    client = client_factory()
    payload = {"strike_date": _future(), "option_type": "CALL", "strike": 6500, "threshold": 0.6}

    created = client.post("/monitors", json=payload, headers=AUTH)
    assert created.status_code == 201
    data = created.json()
    mid = data["id"]
    assert isinstance(mid, str)
    assert len(mid) == 32  # uuid4 hex, like run ids — not a guessable sequence
    assert data["code"].startswith("US.SPXW")
    assert data["code"].endswith("C6500000")
    assert data["field"] == "option_delta"
    assert data["enabled"] is True

    assert client.post("/monitors", json=payload, headers=AUTH).status_code == 409  # duplicate (code, field)

    listed = client.get("/monitors", headers=AUTH).json()
    assert len(listed) == 1
    assert listed[0]["last_value"] is None
    assert listed[0]["triggered"] is False

    payload["threshold"] = 0.5
    assert client.put(f"/monitors/{mid}", json=payload, headers=AUTH).status_code == 200
    assert client.get("/monitors", headers=AUTH).json()[0]["threshold"] == 0.5

    assert client.delete(f"/monitors/{mid}", headers=AUTH).status_code == 204
    assert client.get("/monitors", headers=AUTH).json() == []


def test_list_ordered_calls_then_puts_by_date(client_factory):
    client = client_factory()
    for payload in [
        {"strike_date": _future(), "option_type": "PUT", "strike": 6425, "threshold": 0.5},
        {"strike_date": _future(), "option_type": "CALL", "strike": 6500, "threshold": 0.6},
    ]:
        client.post("/monitors", json=payload, headers=AUTH)
    listed = client.get("/monitors", headers=AUTH).json()
    assert [m["option_type"] for m in listed] == ["CALL", "PUT"]


def test_compact_date_is_normalized_to_dashed(client_factory):
    client = client_factory()
    compact = _future().replace("-", "")
    payload = {"strike_date": compact, "option_type": "CALL", "strike": 6500, "threshold": 0.6}
    created = client.post("/monitors", json=payload, headers=AUTH)
    assert created.status_code == 201
    assert created.json()["strike_date"] == _future()  # stored dashed regardless of input


def test_monitor_validation(client_factory):
    client = client_factory()
    bad_date = {"strike_date": "18-12-2026", "option_type": "CALL", "strike": 6500, "threshold": 0.6}
    assert client.post("/monitors", json=bad_date, headers=AUTH).status_code == 422
    bad_type = {"strike_date": _future(), "option_type": "FOO", "strike": 6500, "threshold": 0.6}
    assert client.post("/monitors", json=bad_type, headers=AUTH).status_code == 422


def test_monitors_quotes_endpoint(client_factory):
    def fetcher(codes, opend_host=None, opend_port=None):
        return [{"code": c, "name": "X", "option_delta": 0.33} for c in codes]

    client = client_factory(snapshot_fetcher=fetcher)
    assert client.get("/quotes", headers=AUTH).json() == []

    payload = {"strike_date": _future(), "option_type": "CALL", "strike": 6500, "threshold": 0.6}
    client.post("/monitors", json=payload, headers=AUTH)
    quotes = client.get("/quotes", headers=AUTH).json()
    assert len(quotes) == 1
    assert quotes[0]["snapshot"]["option_delta"] == 0.33
    assert quotes[0]["threshold"] == 0.6


COMBO_PAYLOAD = {
    "name": "sep-condor",
    "legs": [
        {"sign": 1, "option_type": "CALL", "strike": 8100},
        {"sign": -1, "option_type": "CALL", "strike": 8150},
    ],
    "threshold": 10,
    "direction": "below",
}


def test_combo_monitor_create_and_guardrails(client_factory):
    client = client_factory()
    payload = {**COMBO_PAYLOAD, "strike_date": _future()}

    created = client.post("/monitors", json=payload, headers=AUTH)
    assert created.status_code == 201
    data = created.json()
    assert data["code"] == "sep-condor"
    assert data["field"] == "mid_price"  # combo default field
    assert len(data["legs"]) == 2

    assert client.post("/monitors", json=payload, headers=AUTH).status_code == 409  # duplicate name

    one_leg = {**payload, "name": "x", "legs": payload["legs"][:1]}
    assert client.post("/monitors", json=one_leg, headers=AUTH).status_code == 422  # min 2 legs

    single_leg_payload = {"strike_date": _future(), "option_type": "CALL", "strike": 6500, "threshold": 0.6}
    mid = data["id"]
    assert client.put(f"/monitors/{mid}", json=single_leg_payload, headers=AUTH).status_code == 422  # no in-place edit

    listed = client.get("/monitors", headers=AUTH).json()
    assert any(m["code"] == "sep-condor" for m in listed)
    assert client.delete(f"/monitors/{mid}", headers=AUTH).status_code == 204


def test_patch_monitor_safe_fields(client_factory):
    client = client_factory()
    payload = {"strike_date": _future(), "option_type": "CALL", "strike": 6500, "threshold": 0.6}
    mid = client.post("/monitors", json=payload, headers=AUTH).json()["id"]

    patched = client.patch(f"/monitors/{mid}", json={"threshold": 0.5, "direction": "below"}, headers=AUTH)
    assert patched.status_code == 200
    assert patched.json()["threshold"] == 0.5
    assert patched.json()["direction"] == "below"

    assert client.patch(f"/monitors/{mid}", json={}, headers=AUTH).status_code == 422  # nothing to update
    assert client.patch("/monitors/nope", json={"threshold": 1}, headers=AUTH).status_code == 404

    combo = client.post("/monitors", json={**COMBO_PAYLOAD, "strike_date": _future()}, headers=AUTH).json()
    combo_patch = client.patch(f"/monitors/{combo['id']}", json={"threshold": 25}, headers=AUTH)
    assert combo_patch.status_code == 200  # combos ARE patchable for safe fields
    assert combo_patch.json()["threshold"] == 25
    assert combo_patch.json()["legs"] == combo["legs"]  # legs untouched


def test_patch_field_conflict(client_factory):
    client = client_factory()
    base = {"strike_date": _future(), "option_type": "CALL", "strike": 6500, "threshold": 0.6}
    client.post("/monitors", json=base, headers=AUTH)
    other = client.post("/monitors", json={**base, "field": "mid_price", "threshold": 30}, headers=AUTH).json()
    resp = client.patch(f"/monitors/{other['id']}", json={"field": "option_delta"}, headers=AUTH)
    assert resp.status_code == 409  # (code, option_delta) already taken


def test_direction_below_monitor(client_factory):
    client = client_factory()
    payload = {
        "strike_date": _future(),
        "option_type": "CALL",
        "strike": 8100,
        "field": "mid_price",
        "threshold": 30,
        "direction": "below",
    }
    created = client.post("/monitors", json=payload, headers=AUTH)
    assert created.status_code == 201
    assert created.json()["direction"] == "below"
    assert client.post("/monitors", json={**payload, "direction": "sideways"}, headers=AUTH).status_code == 422


def test_timestamps_rendered_in_display_tz(client_factory):
    client = client_factory()
    payload = {"strike_date": _future(), "option_type": "CALL", "strike": 6500, "threshold": 0.6}
    created = client.post("/monitors", json=payload, headers=AUTH).json()
    assert created["created_at"].endswith("+08:00")


def test_quotes_html_renders_watchlist(client_factory):
    def fetcher(codes, opend_host=None, opend_port=None):
        return [
            {"code": c, "name": "SPXW TEST", "option_delta": 0.33, "mid_price": 27.55, "bid_price": 27.2} for c in codes
        ]

    client = client_factory(snapshot_fetcher=fetcher)
    empty = client.get("/quotes.html", headers=AUTH)
    assert empty.status_code == 200
    assert "empty" in empty.text.lower()

    payload = {"strike_date": _future(), "option_type": "CALL", "strike": 8100, "threshold": 0.6}
    client.post("/monitors", json=payload, headers=AUTH)
    resp = client.get("/quotes.html", headers=AUTH)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert "SPXW TEST" in resp.text
    assert "27.55" in resp.text
    assert "option_delta ≥ 0.6" in resp.text  # monitor context alongside live data


def test_quotes_html_includes_combo_row(client_factory):
    def fetcher(codes, opend_host=None, opend_port=None):
        prices = dict.fromkeys(codes, 26.4)
        if len(codes) > 1:
            prices[max(codes)] = 19.25  # 8150 leg sorts last
        return [{"code": c, "mid_price": prices[c]} for c in codes]

    client = client_factory(snapshot_fetcher=fetcher)
    client.post("/monitors", json={**COMBO_PAYLOAD, "strike_date": _future()}, headers=AUTH)
    resp = client.get("/quotes.html", headers=AUTH)
    assert resp.status_code == 200
    assert "sep-condor" in resp.text
    assert "7.15" in resp.text  # combined mid in the mid column
    assert client.get("/quotes", headers=AUTH).json() == []  # JSON endpoint still single-leg only


def test_health_exposes_monitor_sweep_state(client_factory):
    client = client_factory()
    data = client.get("/health").json()
    assert data["monitor"]["consecutive_failures"] == 0
    assert data["monitor"]["last_sweep_at"] is None
