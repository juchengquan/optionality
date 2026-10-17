"""Loading Positions and Monitors from the live service, against a local HTTP server.

The server answers with the service's real response shapes (every field `GET /positions` and
`GET /monitors` send), but synthetic contents — a notebook's watchlist does not belong in a
public repository. It is a real socket, so URL joining, headers and error bodies are exercised
rather than mocked.
"""

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from optionality import api
from optionality.position import Position, cost_to_close

CONDOR = {
    "id": "a" * 32,
    "name": "1120_IC",
    "strategy": "iron condor",
    "strike_date": "2026-11-20",
    "contracts": 2,
    "entry": 3.0,
    "created_at": "2026-10-06 12:15:51+08:00",
    "opened_at": "2026-10-06",
    "legs": [
        {"side": "long", "option_type": "PUT", "strike": 6450},
        {"side": "short", "option_type": "PUT", "strike": 6500},
        {"side": "short", "option_type": "CALL", "strike": 7100},
        {"side": "long", "option_type": "CALL", "strike": 7150},
    ],
}
MONITOR_FIELDS = {
    "enabled": True,
    "scope": None,
    "positions": [],
    "disabled_reason": None,
    "triggered": False,
    "last_value": 0.12,
    "last_checked_at": "2026-10-17 21:00:00+08:00",
    "created_at": None,
}
SINGLE = {
    "id": "b" * 32,
    "code": "US.SPXW261120C7100000",
    "strike_date": "2026-11-20",
    "option_type": "CALL",
    "strike": 7100,
    "field": "option_delta",
    "threshold": 0.3,
    "direction": "above",
    "compare": "abs",
    "legs": None,
    **MONITOR_FIELDS,
}
COMBO = {
    "id": "c" * 32,
    "code": "1120_IC",
    "strike_date": "2026-11-20",
    "option_type": "CMB",
    "strike": 0,
    "field": "mid_price",
    "threshold": 2.5,
    "direction": "above",
    "compare": "abs",
    "legs": [{"sign": -1, "option_type": "PUT", "strike": 6500}, {"sign": 1, "option_type": "PUT", "strike": 6450}],
    **MONITOR_FIELDS,
}


class Service:
    """A stand-in service: what it answers, and what it was asked."""

    def __init__(self):
        self.routes: dict[str, tuple[int, object]] = {
            "/positions": (200, [CONDOR]),
            "/monitors": (200, [SINGLE, COMBO]),
        }
        self.requests: list[tuple[str, str | None]] = []


@pytest.fixture
def service():
    state = Service()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # the name http.server calls
            state.requests.append((self.path, self.headers.get("Authorization")))
            status, body = state.routes.get(self.path, (404, {"detail": "not found"}))
            html = isinstance(body, str)
            raw = body.encode() if html else json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/html" if html else "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    # a short poll, or every test waits half a second for the server to notice it should stop
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
    state.url = f"http://127.0.0.1:{server.server_address[1]}"
    yield state
    server.shutdown()


def test_positions_come_back_as_the_package_s_own_type(service):
    held = api.positions(service.url)
    assert [p.name for p in held] == ["1120_IC"]
    assert isinstance(held[0], Position)
    assert [leg.side for leg in held[0].legs] == ["long", "short", "short", "long"]
    # and they are usable with the maths straight away
    quotes = {
        c: {"mid_price": m}
        for c, m in zip(
            ["US.SPXW261120P6450000", "US.SPXW261120P6500000", "US.SPXW261120C7100000", "US.SPXW261120C7150000"],
            [1.5, 3.0, 5.0, 2.0],
            strict=True,
        )
    }
    assert cost_to_close(held[0], quotes) == 4.5


def test_monitors_come_back_single_and_combo(service):
    single, combo = api.monitors(service.url)
    assert single.legs is None and single.code == "US.SPXW261120C7100000"
    assert [leg.sign for leg in combo.legs] == [-1, 1]


def test_a_base_url_with_a_path_prefix_keeps_it(service):
    # the tailnet serves the API under /opt/api, and a URL join that drops the prefix asks Caddy instead
    service.routes = {"/opt/api/monitors": (200, [SINGLE])}
    assert len(api.monitors(f"{service.url}/opt/api/")) == 1
    assert len(api.monitors(f"{service.url}/opt/api")) == 1


def test_the_address_and_token_can_come_from_the_environment(service, monkeypatch):
    monkeypatch.setenv("OPTIONALITY_API", service.url)
    monkeypatch.setenv("OPTIONALITY_API_TOKEN", "tok")
    api.positions()
    assert service.requests[-1] == ("/positions", "Bearer tok")


def test_no_token_sends_no_authorization_header(service, monkeypatch):
    monkeypatch.delenv("OPTIONALITY_API_TOKEN", raising=False)
    api.positions(service.url)
    assert service.requests[-1] == ("/positions", None)


def test_a_refusal_raises_with_the_service_s_own_words(service):
    service.routes["/positions"] = (401, {"detail": "unauthorized"})
    with pytest.raises(api.ApiError, match="401.*unauthorized") as caught:
        api.positions(service.url)
    assert caught.value.status == 401


def test_an_unreachable_service_says_where_it_looked():
    with socket.socket() as s:  # a port nothing listens on
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    with pytest.raises(api.ApiError, match=f"127.0.0.1:{port}/positions"):
        api.positions(f"http://127.0.0.1:{port}")


def test_a_shape_it_does_not_know_fails_loudly(service):
    # the old vocabulary (ADR 0013): read quietly, every figure would take this short leg for long
    old = {**CONDOR, "legs": [{"side": "sold", "option_type": "PUT", "strike": 6500}]}
    service.routes["/positions"] = (200, [old])
    with pytest.raises(ValueError, match="side"):
        api.positions(service.url)


def test_the_dashboard_s_address_says_it_is_not_the_api(service):
    # Caddy answers any unknown path under /opt with the dashboard's page, 200: found by pointing
    # this at https://<host>/opt instead of /opt/api, which gave a bare JSONDecodeError
    service.routes["/positions"] = (200, "<!doctype html><html><body>dashboard</body></html>")
    with pytest.raises(api.ApiError, match=r"not JSON.*/opt/api"):
        api.positions(service.url)
