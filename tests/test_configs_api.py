from tests.conftest import AUTH


def test_config_crud_roundtrip(client_factory, holdings_body):
    client = client_factory()
    payload = {"name": "spx", "task_type": "holdings", "body": holdings_body}

    assert client.post("/configs", json=payload, headers=AUTH).status_code == 201
    assert client.post("/configs", json=payload, headers=AUTH).status_code == 409  # duplicate

    listed = client.get("/configs", headers=AUTH).json()
    assert [c["name"] for c in listed] == ["spx"]

    got = client.get("/configs/spx", headers=AUTH).json()
    assert got["body"]["code_information"]["name"] == "SPX"

    updated = dict(payload)
    assert client.put("/configs/spx", json=updated, headers=AUTH).status_code == 200
    assert client.delete("/configs/spx", headers=AUTH).status_code == 204
    assert client.get("/configs/spx", headers=AUTH).status_code == 404


def test_invalid_body_rejected(client_factory):
    client = client_factory()
    bad = {"name": "x", "task_type": "holdings", "body": {"nope": True}}
    assert client.post("/configs", json=bad, headers=AUTH).status_code == 422


def test_delete_referenced_by_schedule_conflicts(client_factory, holdings_body):
    client = client_factory()
    client.post("/configs", json={"name": "spx", "task_type": "holdings", "body": holdings_body}, headers=AUTH)

    from optionality.service.models import Schedule

    sf = client.app.state.session_factory
    with sf() as s:
        s.add(Schedule(cron_expr="0 9 * * *", task_type="holdings", config_name="spx"))
        s.commit()

    assert client.delete("/configs/spx", headers=AUTH).status_code == 409
