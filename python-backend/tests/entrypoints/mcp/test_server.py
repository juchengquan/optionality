"""The MCP door (ADR 0026, #447), through the app as `__main__` mounts it: the protocol, the tools, the
cache in front of the live ones, and the two promises it is built on — a tool's data is exactly what its
GET serves, and nothing here can write.

Port of backend/src/entrypoints/mcp/server.test.ts. Every test comes across; the TypeScript's spy on
`console` is pytest's `caplog` on the app's logger, and its source scan of the door's imports reads the
Python's with `ast`. What only the Python can get wrong is at the end: the text written with
JavaScript's numbers, and a shared read that one caller's cancellation must not take from the rest.
"""

import ast
import asyncio
import json
import logging
from datetime import timedelta
from pathlib import Path

import pytest
from harness import json_body, priced_fetcher

from optionality_backend.entrypoints.mcp.tools import DESCRIBED, LIVE_FOR_MS, Toolbox, canonical

EXPIRY = "2026-12-18"
CONDOR = {
    "name": "1016_IC",
    "strategy": "iron_condor",
    "strike_date": EXPIRY,
    "contracts": 1,
    "entry": 3.0,
    "legs": [
        {"side": "short", "option_type": "CALL", "strike": 8050},
        {"side": "long", "option_type": "CALL", "strike": 8075},
        {"side": "short", "option_type": "PUT", "strike": 7100},
        {"side": "long", "option_type": "PUT", "strike": 7075},
    ],
}
RULE = {
    "strike_date": EXPIRY,
    "option_type": "CALL",
    "strike": 8050,
    "field": "option_delta",
    "threshold": 0.2,
    "direction": "above",
}
APP_LOG = "optionality_backend.entrypoints.http.app"


class Book:
    """The harness with a counting Provider: every code it was asked for, one batch per entry, and a
    switch that takes it down."""

    def __init__(self, start) -> None:
        self.asked: list[list[str]] = []
        self.down = False
        self.next_id = 0

        async def fetch(codes):
            self.asked.append(codes)
            if self.down:
                raise RuntimeError("connect ECONNREFUSED 127.0.0.1:33333")
            return await priced_fetcher(codes)

        self.h = start(fetch_quotes=fetch)

    async def rpc(self, method, params=None, *, headers=None, anonymous=False):
        """One JSON-RPC message to `/mcp`, as an MCP client sends it."""
        self.next_id += 1
        message = {
            "jsonrpc": "2.0",
            "id": self.next_id,
            "method": method,
            **({} if params is None else {"params": params}),
        }
        sent = json_body(message)
        return await self.h.call(
            "/mcp",
            method="POST",
            content=sent["content"],
            anonymous=anonymous,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                **(headers or {}),
            },
        )

    async def result(self, resp):
        answer = resp.json()
        assert resp.status_code == 200, answer
        assert "error" not in answer, answer
        return answer["result"]

    async def call(self, name, args=..., **kw):
        """A tool's answer, parsed: `{source, read_at, data}`, or the error text."""
        params = {"name": name, **({} if args is ... else {"arguments": args})}
        r = await self.result(await self.rpc("tools/call", params))
        assert len(r["content"]) == 1
        assert r["content"][0]["type"] == "text"
        text = r["content"][0]["text"]
        error = r.get("isError") is True
        return {"isError": error, "text": text, **({} if error else json.loads(text))}

    async def created(self, resp) -> str:
        data = resp.json()
        assert resp.status_code == 201, data
        return data["id"]

    async def book(self):
        """A held condor, a rule on its short call, and a Reference: something for every tool to read."""
        position = await self.created(await self.h.call("/positions", **json_body(CONDOR)))
        monitor = await self.created(await self.h.call("/monitors", **json_body(RULE)))
        await self.created(await self.h.call("/references", **json_body({"code": "US.SPY", "source": "moomoo"})))
        self.asked.clear()
        return {"position": position, "monitor": monitor}


@pytest.fixture
def mcp(start):
    return lambda: Book(start)


def tools_on(ids):
    """Every tool, the GET it serves and the arguments it takes on `book`'s records."""
    return [
        ("holdings", "/positions/values", ...),
        ("watchlist", "/quotes", ...),
        ("positions", "/positions", ...),
        ("holding_history", f"/positions/{ids['position']}/samples", {"id": ids["position"]}),
        ("monitor_history", f"/monitors/{ids['monitor']}/samples", {"id": ids["monitor"]}),
        ("monitor_closes", "/monitors/closes", ...),
        ("references", "/references", ...),
        ("health", "/health", ...),
    ]


class TestTheProtocol:
    async def test_initializes_at_the_version_the_client_asks_for_where_it_speaks_it(self, mcp):
        m = mcp()
        r = await m.result(
            await m.rpc(
                "initialize",
                {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}},
            )
        )
        assert r["protocolVersion"] == "2025-06-18"
        assert r["capabilities"] == {"tools": {"listChanged": False}}
        assert r["serverInfo"]["name"] == "optionality"
        assert r["serverInfo"]["version"] == "1"
        assert "read-only" in r["instructions"].lower()

    async def test_answers_its_newest_version_to_one_it_does_not_speak_and_the_client_decides(self, mcp):
        m = mcp()
        r = await m.result(await m.rpc("initialize", {"protocolVersion": "1999-01-01"}))
        assert r["protocolVersion"] == "2025-11-25"

    async def test_speaks_only_the_streamable_http_versions_whose_rules_it_follows(self, mcp):
        # 2025-03-26 allowed batches, which this server refuses; 2024-11-05 is the old HTTP+SSE transport.
        # A client asking for either is answered with the newest, and decides.
        m = mcp()
        for old in ("2025-03-26", "2024-11-05"):
            assert (await m.result(await m.rpc("initialize", {"protocolVersion": old})))[
                "protocolVersion"
            ] == "2025-11-25"

    async def test_refuses_a_request_carrying_an_mcp_protocol_version_it_does_not_speak_with_400_and_no_id(self, mcp):
        m = mcp()
        refused = await m.rpc("ping", headers={"MCP-Protocol-Version": "2025-03-26"})
        assert refused.status_code == 400
        assert refused.json() == {
            "jsonrpc": "2.0",
            "id": None,
            "error": {
                "code": -32600,
                "message": "Bad Request: unsupported MCP-Protocol-Version 2025-03-26; this server speaks 2025-11-25, 2025-06-18",
            },
        }
        for spoken in ("2025-11-25", "2025-06-18"):
            assert await m.result(await m.rpc("ping", headers={"MCP-Protocol-Version": spoken})) == {}

    async def test_echoes_an_integral_id_as_an_integer_whatever_way_it_was_written(self, mcp):
        m = mcp()
        resp = await m.h.call(
            "/mcp",
            method="POST",
            content='{"jsonrpc":"2.0","id":1.0,"method":"ping"}',
            headers={"Content-Type": "application/json"},
        )
        assert resp.text == '{"jsonrpc":"2.0","id":1,"result":{}}'

    async def test_answers_a_ping_with_nothing(self, mcp):
        m = mcp()
        assert await m.result(await m.rpc("ping")) == {}

    async def test_accepts_a_notification_with_202_and_no_body(self, mcp):
        m = mcp()
        resp = await m.h.call("/mcp", **json_body({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        assert resp.status_code == 202
        assert resp.text == ""

    async def test_says_a_method_it_does_not_have_is_not_found_with_the_request_s_id(self, mcp):
        m = mcp()
        resp = await m.rpc("resources/list")
        assert resp.status_code == 200
        assert resp.json() == {
            "jsonrpc": "2.0",
            "id": m.next_id,
            "error": {"code": -32601, "message": "Method not found: resources/list"},
        }

    async def test_refuses_a_body_that_is_not_json_a_batch_and_a_message_that_is_not_json_rpc_each_with_400(self, mcp):
        m = mcp()

        async def post(raw):
            return await m.h.call("/mcp", method="POST", content=raw, headers={"Content-Type": "application/json"})

        not_json = await post("{nope")
        assert not_json.status_code == 400
        assert not_json.json()["error"]["code"] == -32700
        batch = await post(json.dumps([{"jsonrpc": "2.0", "id": 1, "method": "ping"}]))
        assert batch.status_code == 400
        assert batch.json()["error"]["code"] == -32600
        bare = await post(json.dumps({"id": 7, "method": "ping"}))
        assert bare.status_code == 400
        assert bare.json()["id"] == 7
        assert bare.json()["error"]["code"] == -32600

    async def test_offers_no_stream_a_get_is_405_saying_it_takes_a_post(self, mcp):
        m = mcp()
        resp = await m.h.call("/mcp")
        assert resp.status_code == 405
        assert resp.headers.get("allow") == "POST"

    async def test_refuses_a_request_a_browser_page_sent_which_carries_an_origin(self, mcp):
        m = mcp()
        assert (await m.rpc("ping", headers={"Origin": "https://evil.example"})).status_code == 403

    async def test_wants_the_api_s_token_as_every_route_does(self, mcp):
        m = mcp()
        assert (await m.rpc("ping", anonymous=True)).status_code == 401
        assert (await m.rpc("tools/list", anonymous=True)).status_code == 401

    async def test_says_nothing_in_the_log_about_a_call_that_worked_which_is_the_flood_an_agent_makes(
        self, mcp, caplog
    ):
        m = mcp()
        with caplog.at_level(logging.INFO, logger=APP_LOG):
            await m.rpc("ping")
            await m.call("positions")
        assert caplog.messages == []


class TestTheTools:
    async def test_are_exactly_these_each_a_read_that_changes_nothing(self, mcp):
        # The whole list, stated: a tool added — a write least of all — is a decision, not a diff nobody
        # reads (#447, decision 4).
        m = mcp()
        tools = (await m.result(await m.rpc("tools/list")))["tools"]
        assert [t["name"] for t in tools] == [
            "holdings",
            "watchlist",
            "positions",
            "holding_history",
            "monitor_history",
            "monitor_closes",
            "references",
            "health",
        ]
        for tool in tools:
            assert tool["annotations"] == {
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            }, tool["name"]
            assert len(tool["description"]) > 200, tool["name"]
            assert tool["inputSchema"]["type"] == "object"

    async def test_each_serve_a_get_the_api_documents_and_nothing_else(self, mcp):
        # the read handed to the door is a GET by construction (`app.py`); this holds the table to paths
        # that ARE reads, so no tool can be a GET of something that is not there
        m = mcp()
        spec = (await m.h.call("/openapi.json")).json()
        for tool in DESCRIBED["tools"]:
            assert spec["paths"].get(tool["path"], {}).get("get"), (
                f"{tool['name']}: GET {tool['path']} is not documented"
            )

    async def test_answer_with_the_very_body_their_get_serves_said_with_its_source_and_when_it_was_read(self, mcp):
        m = mcp()
        ids = await m.book()
        for name, path, args in tools_on(ids):
            answer = await m.call(name, args)
            assert answer["isError"] is False, f"{name}: {answer['text']}"
            direct = await m.h.call(path)
            assert direct.status_code == 200, path
            assert answer["data"] == direct.json(), name
            assert answer["source"] == f"GET {path}"
            assert answer["read_at"] == "2026-10-02 13:26:06+08:00"

    async def test_write_the_answer_with_its_keys_sorted_and_no_spaces_so_both_backends_write_the_same_text(self, mcp):
        m = mcp()
        answer = await m.call("health")
        assert answer["text"].startswith('{"data":{"db":true,"golden_cases":')
        assert '": ' not in answer["text"]

    async def test_refuse_an_id_that_is_not_one_of_the_service_s_in_words_an_agent_can_correct(self, mcp):
        m = mcp()
        missing = await m.call("holding_history", {"id": "nope"})
        assert missing["isError"] is True
        assert missing["text"] == "GET /positions/nope/samples answered 404: position not found"
        monitor = await m.call("monitor_history", {"id": "nope"})
        assert monitor["isError"] is True
        assert monitor["text"] == "GET /monitors/nope/samples answered 404: monitor not found"

    async def test_refuse_arguments_that_are_not_the_tool_s_before_asking_the_api_anything(self, mcp):
        m = mcp()
        bad = await m.call("holding_history", {"id": "../settings"})
        assert (bad["isError"], bad["text"]) == (True, 'argument "id" must be a string matching ^[A-Za-z0-9_-]{1,64}$')
        assert (await m.call("holding_history", {"id": 7}))["isError"] is True
        assert (await m.call("holding_history"))["text"] == 'missing argument "id"'
        assert (await m.call("holding_history", {"id": "a", "at": "b"}))[
            "text"
        ] == 'unexpected argument "at": holding_history takes only "id"'
        assert (await m.call("watchlist", {"fresh": True}))[
            "text"
        ] == 'unexpected argument "fresh": watchlist takes no arguments'
        assert (await m.call("health", []))["text"] == "arguments must be an object"
        assert m.asked == []

    async def test_say_a_tool_they_do_not_have_is_unknown_as_a_protocol_error(self, mcp):
        m = mcp()
        answer = (await m.rpc("tools/call", {"name": "close_position", "arguments": {"id": "x"}})).json()
        assert answer["error"] == {"code": -32602, "message": "Unknown tool: close_position"}

    async def test_carry_a_provider_s_failure_as_a_tool_error_in_the_service_s_own_words(self, mcp):
        m = mcp()
        await m.book()
        m.down = True
        answer = await m.call("watchlist")
        assert answer["isError"] is True
        assert answer["text"].startswith("GET /quotes answered 502: ")
        assert "ECONNREFUSED" in answer["text"]


class TestTheLiveReadsSharedCache:
    async def test_asks_the_provider_once_for_an_agent_calling_in_a_tight_loop_and_again_once_the_window_has_passed(
        self, mcp
    ):
        m = mcp()
        await m.book()
        for _ in range(50):
            await m.call("watchlist")
        assert len(m.asked) == 1
        m.h.now = m.h.now + timedelta(milliseconds=LIVE_FOR_MS - 1)
        shared = await m.call("watchlist")
        assert len(m.asked) == 1
        # the answer says when it was READ, which is the first call's instant, not this one's
        assert shared["read_at"] == "2026-10-02 13:26:06+08:00"
        m.h.now = m.h.now + timedelta(milliseconds=1)
        again = await m.call("watchlist")
        assert len(m.asked) == 2
        assert again["read_at"] == "2026-10-02 13:26:11+08:00"

    async def test_shares_a_read_still_in_flight_with_everyone_who_asks_meanwhile(self, mcp):
        m = mcp()
        await m.book()
        await asyncio.gather(*(m.call("watchlist") for _ in range(20)))
        assert len(m.asked) == 1

    async def test_covers_every_live_tool_each_with_its_own_read(self, mcp):
        m = mcp()
        await m.book()
        for name in ("holdings", "watchlist", "references"):
            before = len(m.asked)
            await m.call(name)
            assert len(m.asked) == before + 1, f"{name} asked nothing at all — not a live tool any more?"
            for _ in range(10):
                await m.call(name)
            assert len(m.asked) == before + 1, f"{name} is not shared"

    async def test_shares_a_refusal_too_so_a_provider_that_is_down_is_asked_once_per_window(self, mcp):
        m = mcp()
        await m.book()
        m.down = True
        for _ in range(10):
            assert (await m.call("watchlist"))["isError"] is True
        assert len(m.asked) == 1

    async def test_leaves_the_page_and_the_reads_that_are_not_live_alone(self, mcp):
        m = mcp()
        await m.book()
        await m.call("watchlist")
        assert len(m.asked) == 1
        # the dashboard's own poll is never served from the MCP's window
        await m.h.call("/quotes")
        await m.h.call("/quotes")
        assert len(m.asked) == 3
        # and a stored read is read afresh each time: a sweep may have written since
        assert (await m.call("positions"))["data"][0]["name"] == "1016_IC"
        m.h.db.execute("update positions set name = 'renamed'")
        assert (await m.call("positions"))["data"][0]["name"] == "renamed"


DOOR = Path(__file__).resolve().parents[3] / "src" / "optionality_backend" / "entrypoints" / "mcp"


class TestTheDoorsReach:
    def test_imports_nothing_of_the_service_no_route_no_query_no_engine_no_write(self):
        # It is handed a GET of the API's own and that is all it may use (ADR 0026). Read from the
        # source, so a write path added later fails here rather than in a review.
        sources = sorted(p.name for p in DOOR.glob("*.py"))
        assert sources == ["__init__.py", "server.py", "tools.py"]
        reached = set()
        for name in sources:
            for node in ast.walk(ast.parse((DOOR / name).read_text())):
                if isinstance(node, ast.ImportFrom):
                    if node.level == 0:
                        reached.add(node.module)
                    elif node.level > 1:
                        reached.add("." * node.level + (node.module or ""))
                elif isinstance(node, ast.Import):
                    reached.update(a.name for a in node.names)
        assert reached == {
            "asyncio",
            "collections.abc",
            "dataclasses",
            "datetime",
            "json",
            "math",
            # the one type it is handed, `Read`, and nothing that runs
            "...ports",
            "optionality.js",
            "optionality.timefmt",
            "pathlib",
            "re",
            "starlette.requests",
            "starlette.responses",
            "typing",
            "urllib.parse",
        }


class TestWhatOnlyThePythonCanGetWrong:
    def test_writes_every_number_as_javascript_does(self):
        # `json.dumps` writes 1.0 and 1e-05; the scenarios compare the TEXT with the TypeScript's
        assert canonical({"b": 1.0, "a": [0.00001, 1e21, 0.49218750000000006, -0.0, 2**60, True, None]}) == (
            '{"a":[0.00001,1e+21,0.49218750000000006,0,1152921504606847000,true,null],"b":1}'
        )
        assert canonical({"é": "naïve \u001f"}) == '{"é":"naïve \\u001f"}'

    async def test_a_caller_cancelled_mid_read_does_not_cancel_the_read_the_others_share(self):
        started = asyncio.Event()
        release = asyncio.Event()
        reads = []

        async def read(path, authorization):
            reads.append(path)
            started.set()
            await release.wait()
            return 200, "[]"

        box = Toolbox(read, lambda: __import__("harness").NOW, "UTC")
        first = asyncio.create_task(box.call("watchlist", None, None))
        await started.wait()
        second = asyncio.create_task(box.call("watchlist", None, None))
        await asyncio.sleep(0)
        first.cancel()
        release.set()
        answer = await second
        assert json.loads(answer["content"][0]["text"])["data"] == []
        assert reads == ["/quotes"]
