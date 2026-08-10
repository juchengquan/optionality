def test_health_is_open_and_reports_status(client_factory):
    client = client_factory()
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["db"] is True
    assert data["opend"] is False  # nothing listens on the test port
    assert data["queue_depth"] == 0
    assert data["last_run"] is None


def test_missing_token_is_rejected(client_factory):
    client = client_factory()
    assert client.get("/runs").status_code == 401


def test_valid_token_is_accepted(client_factory):
    from tests.conftest import AUTH

    client = client_factory()
    resp = client.get("/health", headers=AUTH)
    assert resp.status_code == 200


def test_root_path_prefixes_openapi_url_for_reverse_proxy(client_factory):
    client = client_factory(token="", root_path="/api")
    html = client.get("/docs").text
    assert "'/api/openapi.json'" in html
