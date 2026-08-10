import time

from tests.conftest import AUTH


def _mk_config(client, holdings_body):
    client.post("/configs", json={"name": "spx", "task_type": "holdings", "body": holdings_body}, headers=AUTH)


def _wait_terminal(client, run_id, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = client.get(f"/runs/{run_id}", headers=AUTH).json()["status"]
        if status in ("succeeded", "failed"):
            return status
        time.sleep(0.05)
    raise AssertionError("run did not finish in time")


def test_trigger_run_end_to_end(client_factory, holdings_body):
    client = client_factory()  # stub runner from conftest
    _mk_config(client, holdings_body)

    resp = client.post("/runs", json={"task": "holdings", "config": "spx"}, headers=AUTH)
    assert resp.status_code == 202
    run_id = resp.json()["run_id"]

    assert _wait_terminal(client, run_id) == "succeeded"

    report = client.get(f"/runs/{run_id}/report", headers=AUTH).json()
    assert report["summary"] == [{"strike_date": "2026-12-18"}]

    html = client.get(f"/runs/{run_id}/report.html", headers=AUTH)
    assert html.status_code == 200
    assert html.headers["content-type"].startswith("text/html")
    assert "<p>stub</p>" in html.text

    runs = client.get("/runs?status=succeeded", headers=AUTH).json()
    assert runs[0]["id"] == run_id


def test_run_details_endpoint_with_code_filter(client_factory, holdings_body):
    client = client_factory()
    _mk_config(client, holdings_body)
    run_id = client.post("/runs", json={"task": "holdings", "config": "spx"}, headers=AUTH).json()["run_id"]
    assert _wait_terminal(client, run_id) == "succeeded"

    details = client.get(f"/runs/{run_id}/details", headers=AUTH).json()
    assert len(details) == 2
    assert details[0]["code"] == "US.SPXW261218C6500000"

    filtered = client.get(f"/runs/{run_id}/details?code=US.SPXW261218P6425000", headers=AUTH).json()
    assert len(filtered) == 1
    assert filtered[0]["mid_price"] == 12.4

    assert client.get(f"/runs/{run_id}/details?code=US.NOPE", headers=AUTH).json() == []


def test_unknown_config_404_and_task_mismatch_422(client_factory, holdings_body):
    client = client_factory()
    _mk_config(client, holdings_body)
    assert client.post("/runs", json={"task": "holdings", "config": "ghost"}, headers=AUTH).status_code == 404
    assert client.post("/runs", json={"task": "strategy", "config": "spx"}, headers=AUTH).status_code == 422


def test_report_404_before_completion(client_factory, holdings_body):
    client = client_factory()
    _mk_config(client, holdings_body)
    assert client.get("/runs/doesnotexist/report", headers=AUTH).status_code == 404
