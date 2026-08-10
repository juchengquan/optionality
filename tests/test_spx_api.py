from tests.conftest import AUTH


def test_build_spx_code():
    from optionality.apis.aux import build_spx_code

    assert build_spx_code("2026-12-18", "CALL", 6500) == "US.SPXW261218C6500000"
    assert build_spx_code("2026-12-18", "PUT", 6425.0) == "US.SPXW261218P6425000"


def test_snapshot_endpoint_builds_code_and_returns_data(client_factory, monkeypatch):
    import optionality.service.routes.spx as spx_mod

    monkeypatch.setattr(
        spx_mod,
        "fetch_snapshot",
        lambda codes, opend_host=None, opend_port=None: [
            {"code": codes[0], "last_price": 12.3, "update_time": "2026-08-09 20:15:00"}
        ],
    )
    client = client_factory()
    resp = client.get("/spx/quote?strike_date=2026-12-18&option_type=CALL&strike=6500", headers=AUTH)
    assert resp.status_code == 200
    data = resp.json()
    assert data["code"] == "US.SPXW261218C6500000"
    assert data["snapshot"]["last_price"] == 12.3
    assert data["snapshot"]["update_time"] == "2026-08-10 08:15:00+08:00"  # ET parsed, SGT emitted


def test_snapshot_endpoint_validates_params(client_factory):
    client = client_factory()
    assert client.get("/spx/quote?strike_date=2026-12-18&option_type=FOO&strike=6500", headers=AUTH).status_code == 422
    assert client.get("/spx/quote?strike_date=18-12-2026&option_type=CALL&strike=6500", headers=AUTH).status_code == 422


def test_snapshot_endpoint_404_when_no_data(client_factory, monkeypatch):
    import optionality.service.routes.spx as spx_mod

    monkeypatch.setattr(spx_mod, "fetch_snapshot", lambda codes, opend_host=None, opend_port=None: [])
    client = client_factory()
    resp = client.get("/spx/quote?strike_date=2026-12-18&option_type=CALL&strike=6500", headers=AUTH)
    assert resp.status_code == 404
