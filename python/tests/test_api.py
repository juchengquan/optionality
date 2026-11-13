"""Loading Positions, Monitors and References from the live service, against a local HTTP server.

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
from pydantic import ValidationError

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


#: Two References as the LIVE service answered on 2026-11-09 — one per vendor, which is the pair
#: that matters: Yahoo states its freshness and IBKR states only that it is delayed, so a model
#: that treated `delayed_by_minutes` as always present would pass on one row and fail on the other
#: (ADR 0019).
GSPC = {
    "id": "d" * 32,
    "code": "^GSPC",
    "label": "SPX",
    "source": "yahoo",
    "name": "S&P 500",
    "figure": 7376.86,
    "field": "last_price",
    "change": 0.0031453425676493574,
    "error": None,
    "delayed": False,
    "last_known": True,
    "delayed_by_minutes": None,
}
SPX_IBKR = {
    "id": "e" * 32,
    "code": "SPX",
    "label": "SPX",
    "source": "ibkr",
    "name": None,
    "figure": 7374.85,
    "field": "last_price",
    "change": 0.002872011890564489,
    "error": None,
    "delayed": True,
    "last_known": False,
    "delayed_by_minutes": None,
}
#: a vendor that is wholly down: rows still come back, each with its own reason (ADR 0018)
DASHED = {
    **GSPC,
    "id": "f" * 32,
    "figure": None,
    "field": None,
    "change": None,
    "name": None,
    "error": "yahoo unreachable",
    "delayed": None,
    "last_known": None,
    "delayed_by_minutes": None,
}


class Service:
    """A stand-in service: what it answers, and what it was asked."""

    def __init__(self):
        self.routes: dict[str, tuple[int, object]] = {
            "/positions": (200, [CONDOR]),
            "/monitors": (200, [SINGLE, COMBO]),
            "/references": (200, [GSPC, SPX_IBKR]),
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


CLOSED = {
    **CONDOR,
    "id": "d" * 32,
    "name": "1016_IC",
    "closed_on": "2026-10-09",
    "exit": 0.4,
    "realized_points": 5.2,
}


def test_positions_are_only_what_is_still_held(service):
    # The service keeps a closed holding (ADR 0022) and `GET /positions` lists both. `positions()`
    # promises what the service HOLDS, and a notebook values what it returns against live quotes —
    # a finished trade there would be priced as though it were still on.
    service.routes = {
        "/positions": (200, [{**CONDOR, "closed_on": None, "exit": None, "realized_points": None}, CLOSED])
    }
    assert [p.name for p in api.positions(service.url)] == ["1120_IC"]


def test_closed_positions_carry_how_they_ended(service):
    service.routes = {
        "/positions": (200, [{**CONDOR, "closed_on": None, "exit": None, "realized_points": None}, CLOSED])
    }
    [closed] = api.closed_positions(service.url)
    assert isinstance(closed, api.ClosedPosition)
    assert isinstance(closed, Position), "still usable with the maths, for what it was"
    assert (closed.name, closed.closed_on, closed.exit, closed.realized_points) == ("1016_IC", "2026-10-09", 0.4, 5.2)


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


def test_refuses_a_row_whose_shape_has_moved(service):
    """A field the API always sends, renamed: the model would default it in silence.

    `Monitor.legs` is `| None = None` because the TypeScript declares it optional, so a renamed
    `legs` turned a combo into a single-leg rule whose "contract code" was the combo's name. The
    models stay faithful; the boundary refuses (review 2026-11-01).
    """
    moved = {k if k != "legs" else "combo_legs": v for k, v in COMBO.items()}
    service.routes["/monitors"] = (200, [moved])
    with pytest.raises(api.ApiError, match="missing legs"):
        api.monitors(service.url)


def test_refuses_a_holding_that_lost_its_opened_date(service):
    # exit levels and vol attribution both answer None for a holding with no opened_at, which is
    # the silent-null failure the memory note on opened_at records
    moved = {k if k != "opened_at" else "openedAt": v for k, v in CONDOR.items()}
    service.routes["/positions"] = (200, [moved])
    with pytest.raises(api.ApiError, match="missing opened_at"):
        api.positions(service.url)


def test_still_takes_a_row_that_has_every_key(service):
    assert [m.code for m in api.monitors(service.url)] == [SINGLE["code"], COMBO["code"]]
    assert [p.name for p in api.positions(service.url)] == [CONDOR["name"]]


def test_references_come_back_with_both_vendors_freshness_claims(service):
    rows = api.references(service.url)
    assert [r.source for r in rows] == ["yahoo", "ibkr"]
    assert [r.figure for r in rows] == [7376.86, 7374.85]
    # the pair that matters: Yahoo says it is live, IBKR says it is delayed, and NEITHER states
    # minutes here. `delayed` of None would mean the vendor made no claim at all (moomoo).
    assert [r.delayed for r in rows] == [False, True]
    assert [r.delayed_by_minutes for r in rows] == [None, None]
    assert rows[0].name == "S&P 500" and rows[1].name is None


def test_a_reference_with_no_figure_is_a_row_and_not_an_exception(service):
    """ADR 0018: /references is the one route that cannot fail. A vendor that is wholly down
    leaves each Reference a dash with its own sentence, so a notebook reads the reason."""
    service.routes["/references"] = (200, [DASHED])
    (row,) = api.references(service.url)
    assert row.figure is None
    assert row.field is None
    assert row.error == "yahoo unreachable"


def test_a_reference_row_missing_a_field_fails_loudly(service):
    # every field of ReadingOut is `.nullable()` and not `.optional()`, so all twelve arrive on
    # every row. A missing one is a shape that has moved, not a default to invent.
    service.routes["/references"] = (200, [{k: v for k, v in GSPC.items() if k != "figure"}])
    with pytest.raises(Exception) as err:
        api.references(service.url)
    assert "figure" in str(err.value)


def test_a_reference_is_frozen_like_the_rest_of_the_package(service):
    (row, _) = api.references(service.url)
    with pytest.raises(ValidationError):
        row.figure = 1.0


def test_a_reference_carries_when_the_service_read_it_371(service):
    """Since #371 `/references` stamps each reading with when its source answered, in DISPLAY_TZ: a
    notebook reading the strip after the close needs that time as much as the page does."""
    service.routes["/references"] = (200, [{**GSPC, "fetched_at": "2026-11-13 21:04:19+08:00"}])
    (row,) = api.references(service.url)
    assert row.fetched_at == "2026-11-13 21:04:19+08:00"


def test_a_reference_from_a_service_older_than_the_stamp_reads_none(service):
    """Optional rather than required, unlike the twelve: a service from before #371 sends none, and a
    notebook pinned to this release must still read it."""
    (row, _) = api.references(service.url)
    assert row.fetched_at is None
