from datetime import UTC, datetime, timedelta

from tests.conftest import AUTH


def _future() -> str:
    return (datetime.now(UTC).date() + timedelta(days=30)).isoformat()


def _condor_payload(name: str = "1016_IC", **kw) -> dict:
    payload = {
        "name": name,
        "strategy": "iron_condor",
        "strike_date": _future(),
        "contracts": 1,
        "entry": 3.0,
        "legs": [
            {"side": "sold", "option_type": "CALL", "strike": 8050},
            {"side": "bought", "option_type": "CALL", "strike": 8075},
            {"side": "sold", "option_type": "PUT", "strike": 7100},
            {"side": "bought", "option_type": "PUT", "strike": 7075},
        ],
    }
    payload.update(kw)
    return payload


def _priced_fetcher(codes, opend_host=None, opend_port=None):
    mids = {"C8050": 5.0, "C8075": 2.0, "P7100": 3.0, "P7075": 1.5}
    out = []
    for c in codes:
        mid = next((v for k, v in mids.items() if c.endswith(k + "000")), 1.0)
        out.append(
            {
                "code": c,
                "mid_price": mid,
                "option_delta": 0.2,
                "option_contract_size": 100.0,
            }
        )
    return out


def test_position_crud_roundtrip(client_factory):
    client = client_factory(snapshot_fetcher=_priced_fetcher)
    created = client.post("/positions", json=_condor_payload(), headers=AUTH)
    assert created.status_code == 201
    data = created.json()
    assert len(data["id"]) == 32
    assert data["name"] == "1016_IC"
    assert data["strategy"] == "iron_condor"
    assert len(data["legs"]) == 4

    assert client.post("/positions", json=_condor_payload(), headers=AUTH).status_code == 409  # name taken

    listed = client.get("/positions", headers=AUTH).json()
    assert [p["name"] for p in listed] == ["1016_IC"]

    assert client.delete(f"/positions/{data['id']}", headers=AUTH).status_code == 204
    assert client.get("/positions", headers=AUTH).json() == []


def test_creation_is_gated_on_the_contracts_existing(client_factory):
    def fetcher(codes, opend_host=None, opend_port=None):
        # moomoo rejects the whole batch naming one culprit, then succeeds without it.
        # the culprit is taken from the batch so it tracks the payload's real expiry.
        bad = [c for c in codes if c.endswith("C8050000")]
        if bad:
            raise RuntimeError(f"snapshot API failed: Unknown stock. {bad[0].removeprefix('US.')}")
        return _priced_fetcher(codes)

    client = client_factory(snapshot_fetcher=fetcher)
    resp = client.post("/positions", json=_condor_payload(), headers=AUTH)
    # same strict gate as monitors: nothing enters the table unverified
    assert resp.status_code == 422
    assert "does not exist" in resp.json()["detail"]
    assert client.get("/positions", headers=AUTH).json() == []


def test_side_must_be_sold_or_bought(client_factory):
    client = client_factory(snapshot_fetcher=_priced_fetcher)
    bad = _condor_payload(legs=[{"side": "long", "option_type": "CALL", "strike": 8050}])
    assert client.post("/positions", json=bad, headers=AUTH).status_code == 422


def test_values_endpoint_reports_cost_to_close_and_pnl(client_factory):
    client = client_factory(snapshot_fetcher=_priced_fetcher)
    client.post("/positions", json=_condor_payload(entry=3.0, contracts=2), headers=AUTH)

    values = client.get("/positions/values", headers=AUTH).json()
    assert len(values) == 1
    v = values[0]
    assert v["cost_to_close"] == 4.5  # (5.0 + 3.0) - (2.0 + 1.5)
    assert v["pnl"] == (3.0 - 4.5) * 2 * 100  # sold at 3.00, costs 4.50 to close
    assert v["contract_size"] == 100.0
    # exposure-signed, not cost-signed: two sold legs against two bought at 0.2 each
    assert v["greeks"]["option_delta"] == 0.0
    assert v["fetched_at"]


def test_values_are_none_rather_than_wrong_when_a_leg_is_unpriced(client_factory):
    # full quotes while creating (the gate demands every leg exists), one dropped afterwards
    complete = {"yes": True}

    def fetcher(codes, opend_host=None, opend_port=None):
        priced = _priced_fetcher(codes)
        return priced if complete["yes"] else priced[:-1]

    client = client_factory(snapshot_fetcher=fetcher)
    assert client.post("/positions", json=_condor_payload(), headers=AUTH).status_code == 201
    complete["yes"] = False
    v = client.get("/positions/values", headers=AUTH).json()[0]
    assert v["cost_to_close"] is None
    assert v["pnl"] is None
