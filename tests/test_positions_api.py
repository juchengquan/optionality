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


def _position(client, name, date, legs):
    r = client.post("/positions", headers=AUTH, json={"name": name, "strike_date": date, "legs": legs})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _monitor(client, **kw):
    r = client.post(
        "/monitors", headers=AUTH, json={"field": "option_delta", "threshold": 0.2, "direction": "above", **kw}
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _links(client, mid):
    from sqlalchemy import select

    from optionality.service.models import Monitor, monitor_positions

    with client.app.state.session_factory() as s:
        ids = {
            p
            for (p,) in s.execute(select(monitor_positions.c.position_id).where(monitor_positions.c.monitor_id == mid))
        }
        return ids, s.get(Monitor, mid).scope


def test_a_new_leg_monitor_finds_the_position_holding_it(client_factory):
    """Creating a monitor linked it to nothing, so everything the Position work built --
    entry, P&L, the derived total -- silently applied only to monitors that predate the
    migration which backfilled the links. The link is a lookup, not a guess: the contract
    appears in exactly one Position's legs or in none."""
    client = client_factory()
    pid = _position(
        client,
        "1016_bs_8050",
        "2026-10-16",
        [
            {"side": "sold", "option_type": "CALL", "strike": 8050},
            {"side": "bought", "option_type": "CALL", "strike": 8075},
        ],
    )
    mid = _monitor(client, strike_date="2026-10-16", option_type="CALL", strike=8050)

    # one leg of a two-leg structure, so it watches the LEG
    assert _links(client, mid) == ({pid}, "leg")


def test_a_combo_covering_a_whole_position_watches_all_of_it(client_factory):
    client = client_factory()
    pid = _position(
        client,
        "1030_bs_8100",
        "2026-10-30",
        [
            {"side": "sold", "option_type": "CALL", "strike": 8100},
            {"side": "bought", "option_type": "CALL", "strike": 8125},
        ],
    )
    mid = _monitor(
        client,
        name="1030_bs_8100",
        field="mid_price",
        strike_date="2026-10-30",
        legs=[{"sign": -1, "option_type": "CALL", "strike": 8100}, {"sign": 1, "option_type": "CALL", "strike": 8125}],
    )

    assert _links(client, mid) == ({pid}, "all")


def test_a_condor_spans_both_its_spreads(client_factory):
    """ADR 0004: a monitor may span positions. The live 1016_IC does exactly this."""
    client = client_factory()
    calls = _position(
        client,
        "1016_bs_8050",
        "2026-10-16",
        [
            {"side": "sold", "option_type": "CALL", "strike": 8050},
            {"side": "bought", "option_type": "CALL", "strike": 8075},
        ],
    )
    puts = _position(
        client,
        "1016_IC_puts",
        "2026-10-16",
        [
            {"side": "sold", "option_type": "PUT", "strike": 7100},
            {"side": "bought", "option_type": "PUT", "strike": 7075},
        ],
    )
    mid = _monitor(
        client,
        name="1016_IC",
        field="mid_price",
        strike_date="2026-10-16",
        legs=[
            {"sign": -1, "option_type": "CALL", "strike": 8050},
            {"sign": 1, "option_type": "CALL", "strike": 8075},
            {"sign": -1, "option_type": "PUT", "strike": 7100},
            {"sign": 1, "option_type": "PUT", "strike": 7075},
        ],
    )

    assert _links(client, mid) == ({calls, puts}, "all")


def test_watching_something_you_do_not_hold_links_nothing(client_factory):
    """A Monitor exists to warn, never to record what you own (CONTEXT.md). Watching a strike
    you have no position in is legitimate — it simply has no entry and no P&L."""
    client = client_factory()
    mid = _monitor(client, strike_date="2026-12-18", option_type="CALL", strike=6500)

    assert _links(client, mid) == (set(), None)


def test_a_contract_in_two_positions_links_to_neither(client_factory):
    """Rolling a spread can leave the old and the new holding the same strike for a day. The
    entry is then genuinely ambiguous, and a wrong P&L is worse than an absent one: a missing
    figure makes you look, a wrong one does not."""
    client = client_factory()
    _position(
        client,
        "old_roll",
        "2026-10-16",
        [
            {"side": "sold", "option_type": "CALL", "strike": 8050},
            {"side": "bought", "option_type": "CALL", "strike": 8075},
        ],
    )
    _position(
        client,
        "new_roll",
        "2026-10-16",
        [
            {"side": "sold", "option_type": "CALL", "strike": 8050},
            {"side": "bought", "option_type": "CALL", "strike": 8100},
        ],
    )
    mid = _monitor(client, strike_date="2026-10-16", option_type="CALL", strike=8050)

    assert _links(client, mid) == (set(), None)


def test_a_new_position_adopts_the_monitors_already_watching_it(client_factory):
    """The link is worked out when something is created, so it only ever handled one order:
    position first, then monitor. Set the alarm before recording the holding and the monitor
    stayed orphaned for ever, with no entry and no P&L.

    A Position now looks for orphans the same way a Monitor looks for Positions. Symmetry,
    rather than a job that recomputes links on a schedule — see the test below for why that
    would be worse.
    """
    client = client_factory()
    mid = _monitor(client, strike_date="2026-10-16", option_type="CALL", strike=8050)
    assert _links(client, mid) == (set(), None)

    pid = _position(client, "1016_bs_8050", "2026-10-16",
                    [{"side": "sold", "option_type": "CALL", "strike": 8050},
                     {"side": "bought", "option_type": "CALL", "strike": 8075}])

    assert _links(client, mid) == ({pid}, "leg")


def test_adopting_never_takes_a_link_away(client_factory):
    """Why this is not "recompute the links every sweep". Rolling a spread leaves the old and
    the new sharing a strike for a day; a recomputing job would find that contract in two
    Positions, call it ambiguous, and silently unlink a monitor that had worked for weeks --
    the entry and P&L vanishing mid-session with nothing to explain it.

    Only a monitor with NO link is ever looked at again, so what you already have cannot be
    taken from you by something you subsequently hold.
    """
    client = client_factory()
    first = _position(client, "old_roll", "2026-10-16",
                      [{"side": "sold", "option_type": "CALL", "strike": 8050},
                       {"side": "bought", "option_type": "CALL", "strike": 8075}])
    mid = _monitor(client, strike_date="2026-10-16", option_type="CALL", strike=8050)
    assert _links(client, mid) == ({first}, "leg")

    # the roll: now two Positions hold strike 8050
    _position(client, "new_roll", "2026-10-16",
              [{"side": "sold", "option_type": "CALL", "strike": 8050},
               {"side": "bought", "option_type": "CALL", "strike": 8100}])

    assert _links(client, mid) == ({first}, "leg")


def test_adoption_does_not_resolve_an_ambiguity_it_cannot_resolve(client_factory):
    """An orphan created while two Positions already share its strike stays an orphan, and a
    later Position does not talk adoption into guessing. The entry is ambiguous however many
    times you ask."""
    client = client_factory()
    _position(client, "old_roll", "2026-10-16",
              [{"side": "sold", "option_type": "CALL", "strike": 8050},
               {"side": "bought", "option_type": "CALL", "strike": 8075}])
    _position(client, "new_roll", "2026-10-16",
              [{"side": "sold", "option_type": "CALL", "strike": 8050},
               {"side": "bought", "option_type": "CALL", "strike": 8100}])
    mid = _monitor(client, strike_date="2026-10-16", option_type="CALL", strike=8050)
    assert _links(client, mid) == (set(), None)

    # a third holding, unrelated to the ambiguous strike, runs adoption again
    _position(client, "elsewhere", "2026-11-20",
              [{"side": "sold", "option_type": "CALL", "strike": 9000}])

    assert _links(client, mid) == (set(), None)


def test_deleting_a_position_takes_its_links_with_it(client_factory):
    """The same foreign-key fault #70 fixed on the monitor side. Every Position in the live
    database is linked, so deleting one raised the same IntegrityError.

    The Monitors survive. Nothing in this service deletes a rule as a side effect -- they
    simply stop knowing what they were watching, and would be adopted again if the holding
    came back.
    """
    from sqlalchemy import func, select

    from optionality.service.models import Monitor, monitor_positions

    client = client_factory()
    pid = _position(client, "1016_bs_8050", "2026-10-16",
                    [{"side": "sold", "option_type": "CALL", "strike": 8050},
                     {"side": "bought", "option_type": "CALL", "strike": 8075}])
    mid = _monitor(client, strike_date="2026-10-16", option_type="CALL", strike=8050)
    assert _links(client, mid) == ({pid}, "leg")

    assert client.delete(f"/positions/{pid}", headers=AUTH).status_code == 204

    with client.app.state.session_factory() as s:
        assert s.get(Monitor, mid) is not None, "the rule was deleted as a side effect"
        assert s.scalar(select(func.count()).select_from(monitor_positions)
                        .where(monitor_positions.c.position_id == pid)) == 0
