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


def test_monitor_validation(client_factory):
    client = client_factory()
    bad_date = {"strike_date": "18-12-2026", "option_type": "CALL", "strike": 6500, "threshold": 0.6}
    assert client.post("/monitors", json=bad_date, headers=AUTH).status_code == 422
    bad_type = {"strike_date": _future(), "option_type": "FOO", "strike": 6500, "threshold": 0.6}
    assert client.post("/monitors", json=bad_type, headers=AUTH).status_code == 422


def test_health_exposes_monitor_sweep_state(client_factory):
    client = client_factory()
    data = client.get("/health").json()
    assert data["monitor"]["consecutive_failures"] == 0
    assert data["monitor"]["last_sweep_at"] is None
