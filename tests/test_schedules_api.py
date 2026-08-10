from tests.conftest import AUTH


def _mk_config(client, holdings_body):
    client.post("/configs", json={"name": "spx", "task_type": "holdings", "body": holdings_body}, headers=AUTH)


def test_schedule_crud_and_live_refresh(client_factory, holdings_body):
    client = client_factory()
    _mk_config(client, holdings_body)
    payload = {"cron_expr": "35 9 * * mon-fri", "task_type": "holdings", "config_name": "spx"}

    created = client.post("/schedules", json=payload, headers=AUTH)
    assert created.status_code == 201
    sid = created.json()["id"]
    assert client.app.state.scheduler.get_job(f"schedule-{sid}") is not None

    listed = client.get("/schedules", headers=AUTH).json()
    assert listed[0]["tz"] == "America/New_York"

    payload["enabled"] = False
    assert client.put(f"/schedules/{sid}", json=payload, headers=AUTH).status_code == 200
    assert client.app.state.scheduler.get_job(f"schedule-{sid}") is None

    assert client.delete(f"/schedules/{sid}", headers=AUTH).status_code == 204
    assert client.get("/schedules", headers=AUTH).json() == []


def test_bad_cron_and_unknown_config_rejected(client_factory, holdings_body):
    client = client_factory()
    _mk_config(client, holdings_body)
    bad_cron = {"cron_expr": "nope", "task_type": "holdings", "config_name": "spx"}
    assert client.post("/schedules", json=bad_cron, headers=AUTH).status_code == 422
    no_cfg = {"cron_expr": "0 9 * * *", "task_type": "holdings", "config_name": "ghost"}
    assert client.post("/schedules", json=no_cfg, headers=AUTH).status_code == 422
