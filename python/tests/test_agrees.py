"""Whether this port still agrees with the engine that is running (ADR 0016).

The golden cases hold the port to the TypeScript at the moment it is WRITTEN. A notebook pins a tag
and keeps it for months, so the one thing it cannot otherwise see is that the engine has moved since
its port was cut — the figures would still compute, and still look right.

Against the same local HTTP server the rest of api's tests use, because the shape of `/health` and
the behaviour when nothing answers are exactly what this is about.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from optionality import api
from optionality._ported import GOLDEN_CASES


@pytest.fixture
def service():
    state = type("S", (), {"health": {"golden_cases": GOLDEN_CASES}, "status": 200, "paths": []})()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state.paths.append(self.path)
            raw = json.dumps(state.health).encode()
            self.send_response(state.status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
    state.url = f"http://127.0.0.1:{server.server_address[1]}"
    yield state
    server.shutdown()


def test_agrees_when_the_service_carries_the_same_cases(service):
    verdict = api.agrees(service.url)
    assert verdict.agrees is True
    assert verdict.mine == GOLDEN_CASES
    assert verdict.theirs == GOLDEN_CASES
    assert "agrees" in str(verdict)
    # it asks /health and nothing else: this must be cheap enough for a notebook's first cell
    assert service.paths == ["/health"]


def test_says_so_when_the_engine_has_moved_on(service):
    service.health = {"golden_cases": "0000deadbeef"}
    verdict = api.agrees(service.url)
    assert verdict.agrees is False
    assert verdict.mine == GOLDEN_CASES
    assert verdict.theirs == "0000deadbeef"
    # the words have to name the direction: "they differ" leaves you wondering which is stale
    assert "moved" in str(verdict)


def test_is_falsey_when_it_disagrees_and_truthy_when_it_does_not(service):
    assert api.agrees(service.url)
    service.health = {"golden_cases": "0000deadbeef"}
    assert not api.agrees(service.url)


def test_unknown_rather_than_an_error_when_nothing_answers():
    """ADR 0014 exists so the maths works with no service running. A package that cannot be used
    without phoning home breaks its own charter, so this reports rather than raises."""
    # port 1 on loopback: nothing listens, and connection is refused rather than hanging
    verdict = api.agrees("http://127.0.0.1:1")
    assert verdict.agrees is None
    assert verdict.theirs is None
    assert verdict.mine == GOLDEN_CASES
    assert "no service" in str(verdict)
    # and it is NOT falsey: "cannot tell" must not read as "disagrees", or a notebook offline
    # would report drift that is not there
    assert verdict


def test_unknown_when_the_service_is_too_old_to_carry_the_field(service):
    # a service from before ADR 0016 answers /health without golden_cases; that is not a drift
    service.health = {"db": True}
    verdict = api.agrees(service.url)
    assert verdict.agrees is None
    assert verdict.theirs is None
    assert verdict


def test_unknown_when_the_service_refuses(service):
    service.status = 500
    verdict = api.agrees(service.url)
    assert verdict.agrees is None
    assert verdict
