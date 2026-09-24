from datetime import UTC, datetime, timedelta

import pytest

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


def test_entry_can_be_recorded_after_the_fact(client_factory):
    client = client_factory(snapshot_fetcher=_priced_fetcher)
    pid = client.post("/positions", json=_condor_payload(entry=None), headers=AUTH).json()["id"]
    assert client.get("/positions/values", headers=AUTH).json()[0]["pnl"] is None

    patched = client.patch(f"/positions/{pid}", json={"entry": 3.0}, headers=AUTH)
    assert patched.status_code == 200
    assert patched.json()["entry"] == 3.0
    # cost to close is 4.5, so sold at 3.00 is down 1.50 a contract
    assert client.get("/positions/values", headers=AUTH).json()[0]["pnl"] == -150.0


def test_patch_rejects_an_empty_body_and_unknown_position(client_factory):
    client = client_factory(snapshot_fetcher=_priced_fetcher)
    pid = client.post("/positions", json=_condor_payload(), headers=AUTH).json()["id"]
    assert client.patch(f"/positions/{pid}", json={}, headers=AUTH).status_code == 422
    assert client.patch("/positions/nope", json={"entry": 1.0}, headers=AUTH).status_code == 404


def _spanning_setup(client):
    """A call spread with a rule of its own, a put spread with none, and a stop over both."""
    from sqlalchemy import select

    from optionality.service.models import Monitor, monitor_positions

    made = {}
    for name, legs, entry in (
        ("calls", [("sold", "CALL", 8050), ("bought", "CALL", 8075)], 2.87),
        ("puts", [("sold", "PUT", 7100), ("bought", "PUT", 7075)], None),
    ):
        made[name] = client.post(
            "/positions",
            json={
                "name": name,
                "strike_date": _future(),
                "entry": entry,
                "contracts": 1,
                "legs": [{"side": s, "option_type": t, "strike": k} for s, t, k in legs],
            },
            headers=AUTH,
        ).json()
    sf = client.app.state.session_factory
    with sf() as s:
        for code in ("calls_rule", "span_rule"):
            s.add(
                Monitor(
                    code=code,
                    strike_date=_future(),
                    option_type="CMB",
                    strike=0.0,
                    field="mid_price",
                    threshold=9.0,
                    scope="all",
                    legs=[{"sign": -1, "option_type": "CALL", "strike": 8050.0}],
                )
            )
        s.flush()
        wing = s.scalar(select(Monitor.id).where(Monitor.code == "calls_rule"))
        span = s.scalar(select(Monitor.id).where(Monitor.code == "span_rule"))
        s.execute(monitor_positions.insert().values(monitor_id=wing, position_id=made["calls"]["id"]))
        for p in made.values():
            s.execute(monitor_positions.insert().values(monitor_id=span, position_id=p["id"]))
        s.commit()
    return made, span


def test_a_total_credit_derives_the_unreachable_wing_over_json(client_factory):
    client = client_factory(snapshot_fetcher=_priced_fetcher)
    _made, span = _spanning_setup(client)

    resp = client.post(f"/monitors/{span}/total-entry", json={"entry": 3.21}, headers=AUTH)
    assert resp.status_code == 200

    by_name = {p["name"]: p for p in client.get("/positions", headers=AUTH).json()}
    assert by_name["puts"]["entry"] == pytest.approx(0.34)  # 3.21 less the 2.87 already recorded
    assert by_name["calls"]["entry"] == 2.87  # the wing you can edit directly is untouched


def test_a_total_cannot_be_split_where_every_wing_has_its_own_rule(client_factory):
    client = client_factory(snapshot_fetcher=_priced_fetcher)
    made, span = _spanning_setup(client)
    # give the put side its own rule too, so nothing is left to derive
    from sqlalchemy import select

    from optionality.service.models import Monitor, monitor_positions

    sf = client.app.state.session_factory
    with sf() as s:
        s.add(
            Monitor(
                code="puts_rule",
                strike_date=_future(),
                option_type="CMB",
                strike=0.0,
                field="mid_price",
                threshold=9.0,
                scope="all",
                legs=[{"sign": -1, "option_type": "PUT", "strike": 7100.0}],
            )
        )
        s.flush()
        mid = s.scalar(select(Monitor.id).where(Monitor.code == "puts_rule"))
        s.execute(monitor_positions.insert().values(monitor_id=mid, position_id=made["puts"]["id"]))
        s.commit()

    resp = client.post(f"/monitors/{span}/total-entry", json={"entry": 3.21}, headers=AUTH)
    assert resp.status_code == 422
    assert "own" in resp.json()["detail"]


def test_a_total_needs_the_other_wings_recorded_first(client_factory):
    """Two unknowns and one equation cannot be solved, so it refuses rather than guessing."""
    client = client_factory(snapshot_fetcher=_priced_fetcher)
    made, span = _spanning_setup(client)
    client.patch(f"/positions/{made['calls']['id']}", json={"entry": None}, headers=AUTH)
    # entry is optional, so clearing it needs a direct write
    sf = client.app.state.session_factory
    from optionality.service.models import Position

    with sf() as s:
        s.get(Position, made["calls"]["id"]).entry = None
        s.commit()

    resp = client.post(f"/monitors/{span}/total-entry", json={"entry": 3.21}, headers=AUTH)
    assert resp.status_code == 422
    assert "first" in resp.json()["detail"]


def test_a_total_on_a_rule_watching_nothing_is_refused(client_factory):
    """A rule with no holdings attached has no wing to adjust."""
    client = client_factory(snapshot_fetcher=_priced_fetcher)
    mid = client.post(
        "/monitors",
        json={"strike_date": _future(), "option_type": "CALL", "strike": 8100, "threshold": 0.6},
        headers=AUTH,
    ).json()["id"]
    resp = client.post(f"/monitors/{mid}/total-entry", json={"entry": 3.21}, headers=AUTH)
    assert resp.status_code == 422
    assert "no holdings" in resp.json()["detail"]


def test_a_total_on_an_unknown_rule_is_a_404(client_factory):
    client = client_factory(snapshot_fetcher=_priced_fetcher)
    assert client.post("/monitors/nope/total-entry", json={"entry": 1.0}, headers=AUTH).status_code == 404
