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
import re
from datetime import timedelta
from pathlib import Path
from typing import Any, ClassVar
from urllib.parse import quote

import pytest
from harness import json_body, priced_fetcher
from optionality.monitor import WATCHABLE_FIELDS
from optionality.quote import Batch

from optionality_backend.entrypoints.mcp.tools import (
    DESCRIBED,
    LIVE_FOR_MS,
    Toolbox,
    by_key,
    canonical,
    round_to,
    rounded,
)
from optionality_backend.entrypoints.mcp.writes import WRITES, allowed_write

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
        # writes are off unless the owner switched them on (ADR 0028), and the instructions say so
        assert "WRITES ARE OFF" in r["instructions"]

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
            "price_spreads",
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
        # a write tool names its method (ADR 0028), and is held by the writes' own test
        for tool in (t for t in DESCRIBED["tools"] if "method" not in t):
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
            # the body as the GET serves it, each figure rounded by its key (#454) and nothing else
            assert answer["data"] == rounded(direct.json(), _table(name)), name
            assert answer["source"] == f"GET {path}"
            assert answer["read_at"] == "2026-10-02 13:26:06+08:00"

    async def test_write_the_answer_with_its_keys_sorted_and_no_spaces_so_both_backends_write_the_same_text(self, mcp):
        m = mcp()
        answer = await m.call("health")
        assert answer["text"].startswith('{"data":{"db":true,"golden_cases":')
        assert '": ' not in answer["text"]

    async def test_refuse_an_id_or_a_name_that_is_not_one_of_the_service_s_in_words_an_agent_can_correct(self, mcp):
        m = mcp()
        missing = await m.call("holding_history", {"id": "nope"})
        assert (missing["isError"], missing["text"]) == (
            True,
            "no holding is \"nope\": tried it as a holding's id and as its name. positions lists every holding's id",
        )
        monitor = await m.call("monitor_history", {"id": "nope"})
        assert (monitor["isError"], monitor["text"]) == (
            True,
            "no rule is \"nope\": tried it as a rule's id, as its code or combo name. watchlist lists every rule's id",
        )

    async def test_refuse_arguments_that_are_not_the_tool_s_before_asking_the_api_anything(self, mcp):
        m = mcp()
        pattern = "^[^\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]{1,64}$"
        for given in ["dec\u0000condor", "dec\ncondor", "dec\u009fcondor", "x" * 65, "", "dec \U0001f985"]:
            bad = await m.call("holding_history", {"id": given})
            assert (bad["isError"], bad["text"]) == (True, f'argument "id" must be a string matching {pattern}'), given
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


PUT_RULE = {
    "strike_date": EXPIRY,
    "option_type": "PUT",
    "strike": 7100,
    "field": "option_delta",
    "threshold": 0.15,
    "direction": "above",
}
COMBO = {
    "name": "1218-6800",
    "strike_date": EXPIRY,
    "field": "mid_price",
    "threshold": 2.5,
    "direction": "above",
    "legs": [{"sign": -1, "option_type": "PUT", "strike": 7100}, {"sign": 1, "option_type": "PUT", "strike": 7075}],
}


def _box(read):
    return Toolbox(read, lambda: __import__("harness").NOW, "UTC")


class TestPriceSpreadsPricesAnyStructureThroughGetSpreadsQuote:
    """#452, ADR 0027."""

    D = EXPIRY.replace("-", "")
    PUTS: ClassVar[dict[str, Any]] = {
        "expiry": D,
        "legs": [
            {"side": "short", "option_type": "PUT", "strike": 7100},
            {"side": "long", "option_type": "PUT", "strike": 7075},
        ],
    }
    RATIO: ClassVar[dict[str, Any]] = {
        "expiry": EXPIRY,
        "entry": -1.5,
        "legs": [
            {"side": "long", "option_type": "CALL", "strike": 8050},
            {"side": "short", "option_type": "CALL", "strike": 8075, "qty": 2},
        ],
    }

    async def test_encodes_the_structures_into_the_route_s_query_and_answers_its_very_body(self, mcp):
        m = mcp()
        answer = await m.call("price_spreads", {"structures": [self.PUTS, self.RATIO]})
        assert answer["isError"] is False, answer["text"]
        path = (
            f"/spreads/quote?spread={quote(f'{self.D}:-P7100,+P7075', safe='')}"
            f"&spread={quote(f'{EXPIRY}:+C8050,-C8075x2@-1.5', safe='')}"
        )
        assert answer["source"] == f"GET {path}"
        assert len(m.asked) == 1
        assert answer["data"] == rounded((await m.h.call(path)).json(), _table("price_spreads"))
        # the harness's quotes carry a mid and no sides, which is no two-sided quote: a shape, then the entry
        assert [s["payoff_basis"] for s in answer["data"]["spreads"]] == ["shape", "entry"]

    async def test_leaves_the_sharing_to_the_route_so_a_batch_is_never_held_twice_over(self, mcp):
        m = mcp()
        await m.call("price_spreads", {"structures": [self.PUTS]})
        m.h.now = m.h.now + timedelta(milliseconds=4000)
        # the route's batch is shared, so the Provider is not asked again...
        again = await m.call("price_spreads", {"structures": [self.PUTS]})
        assert len(m.asked) == 1
        # ...but the door read it afresh, at its own instant
        assert again["read_at"] == "2026-10-02 13:26:10+08:00"
        m.h.now = m.h.now + timedelta(milliseconds=1000)
        await m.call("price_spreads", {"structures": [self.PUTS]})
        assert len(m.asked) == 2

    async def test_carries_the_route_s_refusal_as_a_tool_error_in_its_own_words_asking_nothing(self, mcp):
        m = mcp()
        legs = [{"side": "short", "option_type": "PUT", "strike": 7100, "qty": 11}]
        answer = await m.call("price_spreads", {"structures": [{**self.PUTS, "legs": legs}]})
        assert answer["isError"] is True
        assert answer["text"].endswith("answered 422: spread 1, leg 1: a quantity is 1 to 10, not 11")
        assert m.asked == []

    @pytest.mark.parametrize(
        ("args", "words"),
        [
            ({}, 'missing argument "structures"'),
            ({"structures": "20261218:-P6800"}, '"structures" must be a list of structures'),
            ({"structures": [7]}, "structures[0] must be an object"),
            ({"structures": [{"legs": []}]}, 'structures[0] is missing "expiry"'),
            (
                {"structures": [{**PUTS, "expiry": "Dec 18"}]},
                "structures[0].expiry must be a string matching ^[0-9]{4}-?[0-9]{2}-?[0-9]{2}$",
            ),
            ({"structures": [{**PUTS, "legs": "-P7100"}]}, "structures[0].legs must be a list of legs"),
            (
                {"structures": [{**PUTS, "size": 2}]},
                'structures[0] has an unexpected "size": a structure takes only "expiry", "legs", "entry"',
            ),
            ({"structures": [{**PUTS, "entry": "1.5"}]}, "structures[0].entry must be a number"),
            (
                {"structures": [{**PUTS, "legs": [{"side": "sold", "option_type": "PUT", "strike": 7100}]}]},
                'structures[0].legs[0].side must be "short" or "long"',
            ),
            (
                {"structures": [{**PUTS, "legs": [{"side": "short", "option_type": "P", "strike": 7100}]}]},
                'structures[0].legs[0].option_type must be "CALL" or "PUT"',
            ),
            (
                {"structures": [{**PUTS, "legs": [{"side": "short", "option_type": "PUT", "strike": "7100"}]}]},
                "structures[0].legs[0].strike must be a number",
            ),
            (
                {
                    "structures": [
                        {**PUTS, "legs": [{"side": "short", "option_type": "PUT", "strike": 7100, "qty": "2"}]}
                    ]
                },
                "structures[0].legs[0].qty must be a number",
            ),
            (
                {"structures": [{**PUTS, "legs": [{"side": "short", "option_type": "PUT"}]}]},
                'structures[0].legs[0] is missing "strike"',
            ),
            (
                {
                    "structures": [
                        {**PUTS, "legs": [{"side": "short", "option_type": "PUT", "strike": 7100, "sign": -1}]}
                    ]
                },
                'structures[0].legs[0] has an unexpected "sign": a leg takes only "side", "option_type", "strike", "qty"',
            ),
        ],
    )
    async def test_refuses_arguments_it_cannot_write_as_a_query_before_asking_anything(self, mcp, args, words):
        m = mcp()
        answer = await m.call("price_spreads", args)
        assert (answer["isError"], answer["text"]) == (True, words)
        assert m.asked == []


class TestTheHistoryToolsTakeANameAsWellAsAnId:
    # An agent asked "how has 1218-6800 moved?" called monitor_history with the name, got a 404, and
    # recovered only by searching the watchlist for the id (2026-11-18): one call, not three.

    async def names(self, m):
        """`book`, plus a second rule on the short put (its price beside its Δ), a combo, and a closed holding."""
        ids = await m.book()
        put_delta = await m.created(await m.h.call("/monitors", **json_body(PUT_RULE)))
        put_price = await m.created(
            await m.h.call("/monitors", **json_body({**PUT_RULE, "field": "mid_price", "threshold": 9.5}))
        )
        combo_rule = await m.created(await m.h.call("/monitors", **json_body(COMBO)))
        closed = await m.created(await m.h.call("/positions", **json_body({**CONDOR, "name": "oct-condor"})))
        shut = await m.h.call(f"/positions/{closed}/close", **json_body({"exit": 1.25, "closed_on": "2026-10-01"}))
        assert shut.status_code == 200, shut.text
        m.asked.clear()
        return {**ids, "put_delta": put_delta, "put_price": put_price, "combo": combo_rule, "closed": closed}

    async def same(self, m, name, given, id):
        """The answer `given` reads, held to the GET by `id`'s own: the same data, `source` naming the id."""
        path = f"/positions/{id}/samples" if name == "holding_history" else f"/monitors/{id}/samples"
        answer = await m.call(name, {"id": given})
        assert answer["isError"] is False, f"{given}: {answer['text']}"
        assert answer["source"] == f"GET {path}", given
        assert answer["data"] == (await m.h.call(path)).json(), given

    async def test_read_a_holding_by_its_id_or_its_name_open_or_closed(self, mcp):
        m = mcp()
        ids = await self.names(m)
        await self.same(m, "holding_history", ids["position"], ids["position"])
        await self.same(m, "holding_history", "1016_IC", ids["position"])
        await self.same(m, "holding_history", "  1016_IC ", ids["position"])
        await self.same(m, "holding_history", "oct-condor", ids["closed"])
        assert m.asked == []

    async def test_read_a_rule_by_its_id_its_code_as_stored_or_its_contract_as_the_page_and_the_bot_write_it(self, mcp):
        m = mcp()
        ids = await self.names(m)
        await self.same(m, "monitor_history", ids["monitor"], ids["monitor"])
        await self.same(m, "monitor_history", "1218-6800", ids["combo"])
        await self.same(m, "monitor_history", "US.SPXW261218C8050000", ids["monitor"])
        for spelled in ["20261218 C8050", "261218 C8050", "20261218c8050", " 20261218 C8050 "]:
            await self.same(m, "monitor_history", spelled, ids["monitor"])
        assert m.asked == []

    async def test_match_a_name_exactly_case_is_the_owner_s_except_in_a_contract_written_the_page_s_way(self, mcp):
        m = mcp()
        await self.names(m)
        assert (await m.call("holding_history", {"id": "1016_ic"}))["isError"] is True
        assert (await m.call("monitor_history", {"id": "1218-6800 "}))["isError"] is False
        assert (await m.call("monitor_history", {"id": "us.spxw261218c8050000"}))["isError"] is True

    async def test_trim_as_javascript_does_not_as_python_does(self, mcp):
        # str.strip() takes U+001C–U+001F and U+0085, which `trim` does not; the first are refused as
        # control characters anyway, and U+0085 too. U+FEFF is the other way: `trim` takes it.
        m = mcp()
        ids = await self.names(m)
        await self.same(m, "holding_history", "\ufeff1016_IC\u3000", ids["position"])

    async def test_list_each_candidate_where_a_name_matches_several_rules_to_call_again_with_one_id(self, mcp):
        m = mcp()
        ids = await self.names(m)
        for given in ["20261218 P7100", "US.SPXW261218P7100000"]:
            answer = await m.call("monitor_history", {"id": given})
            assert (answer["isError"], answer["text"]) == (
                True,
                "\n".join(
                    [
                        f'"{given}" names 2 rules; call again with one of their ids:',
                        f"{ids['put_delta']} — |Δ| ≥ 0.15",
                        f"{ids['put_price']} — |value| ≥ 9.50",
                    ]
                ),
            )

    async def test_say_what_was_tried_when_nothing_matches_the_contract_included(self, mcp):
        m = mcp()
        await self.names(m)
        answer = await m.call("monitor_history", {"id": "20261218 C9999"})
        said = (
            'no rule is "20261218 C9999": tried it as a rule\'s id, as its code or combo name, and as the contract '
            "US.SPXW261218C9999000. watchlist lists every rule's id"
        )
        assert (answer["isError"], answer["text"]) == (True, said)

    async def test_never_put_what_the_caller_typed_in_a_path_a_name_like_a_path_is_looked_up_and_not_found(self, mcp):
        m = mcp()
        await self.names(m)
        for given in ["../quotes", "../../settings", "%2e%2e%2fquotes", "1016_IC/../../quotes", "?id=x"]:
            assert (await m.call("holding_history", {"id": given}))["text"].startswith("no holding is "), given
            assert (await m.call("monitor_history", {"id": given}))["text"].startswith("no rule is "), given
        assert m.asked == []

    async def test_read_only_the_list_and_the_resolved_id_s_history_both_gets_the_door_already_makes(self):
        reads = []
        rows = {
            "/monitors": [
                {
                    "id": "mon-7",
                    "code": "1218-6800",
                    "field": "mid_price",
                    "compare": "signed",
                    "direction": "above",
                    "threshold": 1,
                    "legs": [{}, {}],
                }
            ],
            "/positions": [{"id": "pos-7", "name": "../quotes"}],
        }

        async def read(path, authorization):
            reads.append(path)
            return 200, json.dumps(rows.get(path, {}))

        box = _box(read)
        assert "isError" not in await box.call("monitor_history", {"id": "1218-6800"}, None)
        assert "isError" not in await box.call("holding_history", {"id": "../quotes"}, None)
        assert reads == ["/monitors", "/monitors/mon-7/samples", "/positions", "/positions/pos-7/samples"]

    async def test_refuse_to_build_a_path_from_a_stored_id_that_is_not_an_id(self):
        reads = []

        async def read(path, authorization):
            reads.append(path)
            return 200, json.dumps([{"id": "../quotes", "name": "odd"}])

        assert await _box(read).call("holding_history", {"id": "odd"}, None) == {
            "content": [{"type": "text", "text": 'the holding "odd" has an id no path can carry'}],
            "isError": True,
        }
        assert reads == ["/positions"]

    async def test_carry_a_list_that_cannot_be_read_as_a_tool_error_in_the_service_s_own_words(self):
        async def read(path, authorization):
            return 500, json.dumps({"detail": "database is locked"})

        assert await _box(read).call("monitor_history", {"id": "mon-1"}, None) == {
            "content": [{"type": "text", "text": "GET /monitors answered 500: database is locked"}],
            "isError": True,
        }


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


READS = [
    "holdings",
    "watchlist",
    "positions",
    "holding_history",
    "monitor_history",
    "monitor_closes",
    "references",
    "price_spreads",
    "health",
]
D = EXPIRY.replace("-", "")
PUT_SPREAD = {
    "expiry": D,
    "name": "1218-7100",
    "threshold": 3,
    "legs": [
        {"side": "short", "option_type": "PUT", "strike": 7100},
        {"side": "long", "option_type": "PUT", "strike": 7075},
    ],
}
TELEGRAM = {"telegram_bot_token": "t", "telegram_chat_id": "42"}
WRITES_LOG = "optionality_backend.entrypoints.mcp.writes"
WRITES_OFF = (
    "writes are off on this service: add_rule and edit_rule need MCP_WRITES=1 in its .env, which only its owner sets"
)
READ_ONLY = {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}


class Writing(Book):
    """`Book` with an agent's writes on (unless said) and Telegram configured (unless said)."""

    def __init__(self, start, settings=None, fetch=None, send=None) -> None:
        self.asked = []
        self.down = False
        self.next_id = 0

        async def counted(codes):
            self.asked.append(codes)
            return await (fetch or priced_fetcher)(codes)

        options = {} if send is None else {"send": send}
        self.h = start(settings={"mcp_writes": True, **TELEGRAM, **(settings or {})}, fetch_quotes=counted, **options)

    async def rules(self):
        return (await self.h.call("/monitors")).json()


@pytest.fixture
def writing(start):
    return lambda settings=None, fetch=None, send=None: Writing(start, settings, fetch, send)


class TestAnAgentsWritesTheSwitch:
    """#456, ADR 0028: add_rule and edit_rule, behind MCP_WRITES."""

    async def test_is_off_by_default_the_writes_are_not_listed_every_tool_listed_is_a_read_and_the_instructions_say_so(
        self, mcp
    ):
        m = mcp()
        tools = (await m.result(await m.rpc("tools/list")))["tools"]
        assert [t["name"] for t in tools] == READS
        assert all(t["annotations"]["readOnlyHint"] is True for t in tools)
        instructions = (await m.result(await m.rpc("initialize", {"protocolVersion": "2025-11-25"})))["instructions"]
        assert "WRITES ARE OFF on this service" in instructions
        assert "WRITES ARE ON" not in instructions

    async def test_off_refuses_a_write_before_asking_anything_writing_nothing_and_counting_nothing(self, mcp):
        m = mcp()
        await m.book()
        before = (await m.h.call("/monitors")).json()
        for name, args in [("add_rule", PUT_SPREAD), ("edit_rule", {"id": "anything", "threshold": 1})]:
            assert await m.call(name, args) == {"isError": True, "text": WRITES_OFF}
        assert await m.call("add_rule", {"nonsense": True}) == {"isError": True, "text": WRITES_OFF}
        assert m.asked == []
        assert (await m.h.call("/monitors")).json() == before
        assert m.h.sent == []

    async def test_on_lists_the_two_writes_after_the_reads_each_annotated_and_the_instructions_say_so(self, writing):
        w = writing({"mcp_writes_per_10_min": 7})
        tools = (await w.result(await w.rpc("tools/list")))["tools"]
        assert [t["name"] for t in tools] == [*READS, "add_rule", "edit_rule"]
        annotations = {t["name"]: t["annotations"] for t in tools}
        for name in READS:
            assert annotations[name] == READ_ONLY, name
        assert annotations["add_rule"] == {
            "readOnlyHint": False,
            "destructiveHint": False,
            "idempotentHint": False,
            "openWorldHint": False,
        }
        assert annotations["edit_rule"] == {
            "readOnlyHint": False,
            "destructiveHint": True,
            "idempotentHint": True,
            "openWorldHint": False,
        }
        instructions = (await w.result(await w.rpc("initialize", {"protocolVersion": "2025-11-25"})))["instructions"]
        assert "WRITES ARE ON, for alarm rules only" in instructions
        assert "at most 7 writes may reach the service in any ten minutes" in instructions
        assert "{cap}" not in instructions


class TestTheDoorsReachForAWrite:
    async def test_lists_exactly_two_writes_post_monitors_and_patch_monitors_id_each_documented(self, mcp):
        m = mcp()
        assert [f"{w['method']} {w['path']}" for w in WRITES] == ["POST /monitors", "PATCH /monitors/{id}"]
        spec = (await m.h.call("/openapi.json")).json()
        for w in WRITES:
            assert spec["paths"].get(w["path"], {}).get(w["method"].lower()), f"{w['method']} {w['path']}"

    async def test_lets_through_only_the_pairs_server_json_lists_refusing_every_other_before_the_app_is_asked(self):
        made: list[str] = []

        async def inner(method, path, body, authorization):
            made.append(f"{method} {path}")
            return 200, "{}"

        write = allowed_write(inner)
        await write("POST", "/monitors", {}, None)
        await write("PATCH", "/monitors/mon-1", {}, None)
        await write("PATCH", "/monitors/00000000000000000000000000000001", {}, None)
        for method, path in [
            ("GET", "/monitors"),
            ("DELETE", "/monitors/mon-1"),
            ("PUT", "/monitors/mon-1"),
            ("POST", "/monitors/mon-1"),
            ("PATCH", "/monitors"),
            ("POST", "/positions"),
            ("PATCH", "/positions/pos-1"),
            ("POST", "/spreads"),
            ("PATCH", "/settings"),
            ("POST", "/monitors/mon-1/total-entry"),
            ("PATCH", "/monitors/../positions/pos-1"),
            ("PATCH", "/monitors/mon 1"),
            ("PATCH", "/monitors/mon-1?x=1"),
            ("post", "/monitors"),
            ("POST", "/monitors/"),
            ("DELETE", "/positions/pos-1"),
            ("POST", "/positions/pos-1/close"),
            ("PATCH", "/monitors/" + "x" * 65),
            ("PATCH", "/monitors/mon-1\n"),
        ]:
            with pytest.raises(PermissionError) as refused:
                await write(method, path, {}, None)
            assert str(refused.value) == (
                f"the MCP door may not {method} {path}: it writes only POST /monitors and PATCH /monitors/{{id}}"
            )
        assert made == ["POST /monitors", "PATCH /monitors/mon-1", "PATCH /monitors/00000000000000000000000000000001"]


class TestAddRule:
    async def test_adds_a_put_spread_s_rule_through_post_monitors_answers_the_rule_and_tells_the_owner_once(
        self, writing
    ):
        w = writing()
        answer = await w.call("add_rule", PUT_SPREAD)
        assert answer["isError"] is False, answer["text"]
        assert answer["source"] == "POST /monitors"
        assert answer["read_at"] == "2026-10-02 13:26:06+08:00"
        [made] = await w.rules()
        assert answer["data"] == made
        assert made["code"] == "1218-7100"
        assert made["field"] == "mid_price"
        assert made["legs"] == [
            {"sign": -1, "option_type": "PUT", "strike": 7100},
            {"sign": 1, "option_type": "PUT", "strike": 7075},
        ]
        assert len(w.asked) == 1
        assert sorted(w.asked[0]) == ["US.SPXW261218P7075000", "US.SPXW261218P7100000"]
        assert w.h.sent == ["🤖 agent added 1218-7100 |value| ≥ 3.00"]

    async def test_adds_a_rule_on_one_contract_its_side_meaning_nothing_with_the_route_s_defaults(self, writing):
        w = writing()
        legs = [{"side": "short", "option_type": "CALL", "strike": 8050, "qty": 1}]
        answer = await w.call("add_rule", {"expiry": EXPIRY, "legs": legs, "threshold": 0.2})
        assert answer["isError"] is False, answer["text"]
        assert answer["data"]["code"] == "US.SPXW261218C8050000"
        assert answer["data"]["field"] == "option_delta"
        assert answer["data"]["legs"] is None
        assert w.h.sent == ["🤖 agent added 20261218 C8050 |Δ| ≥ 0.20"]

    async def test_passes_field_direction_and_compare_only_where_given(self, writing):
        w = writing()
        answer = await w.call("add_rule", {**PUT_SPREAD, "compare": "signed", "direction": "below", "threshold": -4.5})
        assert answer["data"]["compare"] == "signed"
        assert answer["data"]["direction"] == "below"
        assert w.h.sent == ["🤖 agent added 1218-7100 close ≥ 4.50"]

    async def test_refuses_a_quantity_a_combo_with_no_name_a_name_on_one_contract_and_a_wrong_shape_counting_nothing(
        self, writing
    ):
        w = writing({"mcp_writes_per_10_min": 1})
        one = {"expiry": D, "legs": [{"side": "long", "option_type": "CALL", "strike": 8050}], "threshold": 0.2}
        unnamed = {k: v for k, v in PUT_SPREAD.items() if k != "name"}
        for args, words in [
            (
                {**PUT_SPREAD, "legs": [PUT_SPREAD["legs"][0], {**PUT_SPREAD["legs"][1], "qty": 2}]},
                (
                    "legs[1].qty is 2: a rule here watches one of each contract — "
                    "a rule on a structure with quantities is made on the page"
                ),
            ),
            (
                unnamed,
                'a rule on 2 legs is a combo, and a combo needs a "name": it becomes the rule\'s code ("1218-6750")',
            ),
            ({**one, "name": "mine"}, 'a rule on one contract takes no "name": its code is the contract\'s'),
            ({**one, "legs": []}, '"legs" must hold one leg or more'),
            ({**one, "legs": "P7100"}, '"legs" must be a list of legs'),
            ({**one, "expiry": "Dec 18"}, 'argument "expiry" must be a string matching ^[0-9]{4}-?[0-9]{2}-?[0-9]{2}$'),
            (
                {**one, "legs": [{"side": "sold", "option_type": "CALL", "strike": 8050}]},
                'legs[0].side must be "short" or "long"',
            ),
            (
                {**one, "legs": [{"side": "long", "option_type": "CALL", "strike": "8050"}]},
                "legs[0].strike must be a number",
            ),
            (
                {**one, "legs": [{"side": "long", "option_type": "CALL", "strike": 8050, "entry": 1}]},
                'legs[0] has an unexpected "entry": a leg takes only "side", "option_type", "strike", "qty"',
            ),
            ({**one, "threshold": "0.2"}, '"threshold" must be a number'),
            ({**one, "threshold": True}, '"threshold" must be a number'),
            ({**one, "direction": 1}, '"direction" must be a string'),
            ({k: v for k, v in one.items() if k != "threshold"}, 'missing argument "threshold"'),
            (
                {**one, "enabled": False},
                (
                    'unexpected argument "enabled": add_rule takes only "expiry", "legs", "field", "threshold", '
                    '"direction", "compare", "name"'
                ),
            ),
        ]:
            assert await w.call("add_rule", args) == {"isError": True, "text": words}, args
        assert w.asked == []
        assert await w.rules() == []
        assert (await w.call("add_rule", PUT_SPREAD))["isError"] is False

    async def test_carries_the_route_s_refusal_in_its_own_words_and_counts_it(self, writing):
        async def unknown(codes):
            return Batch(records=[], unknown=list(codes))

        w = writing({"mcp_writes_per_10_min": 1}, unknown)
        refused = await w.call("add_rule", PUT_SPREAD)
        assert refused["isError"] is True
        assert refused["text"].startswith("POST /monitors answered 422: ")
        assert len(w.asked) == 1
        assert w.h.sent == []
        assert await w.call("add_rule", PUT_SPREAD) == {
            "isError": True,
            "text": "agent writes are capped at 1 in ten minutes: the next is allowed in 600s",
        }
        assert len(w.asked) == 1


class TestTheCap:
    async def test_refuses_the_eleventh_write_within_ten_minutes_with_the_wait_and_allows_the_next_after(self, writing):
        w = writing()
        assert (await w.call("add_rule", PUT_SPREAD))["isError"] is False
        for i in range(1, 10):
            w.h.now = w.h.now + timedelta(seconds=1)
            edited = await w.call("edit_rule", {"id": "1218-7100", "threshold": 3 + i})
            assert edited["isError"] is False, edited["text"]
        assert await w.call("edit_rule", {"id": "1218-7100", "threshold": 20}) == {
            "isError": True,
            "text": "agent writes are capped at 10 in ten minutes: the next is allowed in 591s",
        }
        assert (await w.rules())[0]["threshold"] == 12
        w.h.now = w.h.now + timedelta(seconds=591)
        assert (await w.call("edit_rule", {"id": "1218-7100", "threshold": 20}))["isError"] is False

    async def test_counts_only_the_mcp_s_writes_the_page_s_are_not_counted(self, writing):
        w = writing({"mcp_writes_per_10_min": 1})
        for _ in range(3):
            await w.h.call("/monitors", **json_body(RULE))
        assert (await w.call("add_rule", PUT_SPREAD))["isError"] is False


COMBO = {
    "name": "1218-6800",
    "strike_date": EXPIRY,
    "field": "mid_price",
    "threshold": 4.51,
    "legs": [{"sign": -1, "option_type": "PUT", "strike": 7100}, {"sign": 1, "option_type": "PUT", "strike": 7075}],
}


async def _set_up(writing, settings=None):
    w = writing(settings)
    combo = await w.created(await w.h.call("/monitors", **json_body(COMBO)))
    delta = await w.created(await w.h.call("/monitors", **json_body({**RULE, "option_type": "PUT", "strike": 7100})))
    w.asked.clear()
    return w, combo, delta


class TestEditRule:
    async def test_finds_a_rule_by_its_combo_name_changes_its_threshold_and_tells_the_owner(self, writing):
        w, combo, _ = await _set_up(writing)
        answer = await w.call("edit_rule", {"id": "1218-6800", "threshold": 4.8})
        assert answer["isError"] is False, answer["text"]
        assert answer["source"] == f"PATCH /monitors/{combo}"
        assert answer["data"] == next(r for r in await w.rules() if r["id"] == combo)
        assert answer["data"]["threshold"] == 4.8
        assert w.h.sent == ["🤖 agent: 1218-6800 |value| ≥ 4.51 → ≥ 4.80"]
        assert w.asked == []

    async def test_mutes_a_rule_as_the_owner_muting_it_by_hand_would_and_unmutes_it(self, writing):
        w, _, delta = await _set_up(writing)
        muted = await w.call("edit_rule", {"id": "20261218 P7100", "enabled": False})
        assert (muted["data"]["id"], muted["data"]["enabled"], muted["data"]["disabled_reason"]) == (
            delta,
            False,
            "manual",
        )
        unmuted = await w.call("edit_rule", {"id": delta, "enabled": True})
        assert (unmuted["data"]["enabled"], unmuted["data"]["disabled_reason"]) == (True, None)
        assert w.h.sent == [
            "🤖 agent muted 20261218 P7100 |Δ| ≥ 0.20",
            "🤖 agent unmuted 20261218 P7100 |Δ| ≥ 0.20",
        ]

    async def test_refuses_to_unmute_a_rule_the_service_switched_off_writing_nothing_and_counting_nothing(
        self, writing
    ):
        w, _, delta = await _set_up(writing, {"mcp_writes_per_10_min": 1})
        for reason in ["unknown-contract", "no-figure", "unreadable", "expired", "holding-closed"]:
            w.h.db.execute("update monitors set enabled = 0, disabled_reason = ? where id = ?", (reason, delta))
            w.h.db.commit()
            assert await w.call("edit_rule", {"id": delta, "enabled": True, "threshold": 0.3}) == {
                "isError": True,
                "text": f'the rule "{delta}" is off as "{reason}", not muted by hand: '
                'edit_rule unmutes only a rule muted by hand (disabled_reason "manual")',
            }, reason
        rule = next(r for r in await w.rules() if r["id"] == delta)
        assert (rule["enabled"], rule["threshold"]) == (False, 0.2)
        assert w.h.sent == []
        assert (await w.call("edit_rule", {"id": delta, "threshold": 0.3}))["isError"] is False

    async def test_refuses_to_mute_a_rule_the_service_switched_off_which_would_make_it_unmutable_here(self, writing):
        # review of #457: muting first rewrote its reason to "manual", and the unmute guard then let it on
        w, _, delta = await _set_up(writing, {"mcp_writes_per_10_min": 1})
        for reason in ["unknown-contract", "no-figure", "unreadable", "expired", "holding-closed"]:
            w.h.db.execute("update monitors set enabled = 0, disabled_reason = ? where id = ?", (reason, delta))
            w.h.db.commit()
            assert await w.call("edit_rule", {"id": delta, "enabled": False}) == {
                "isError": True,
                "text": f'the rule "{delta}" is already off as "{reason}", not muted by hand: edit_rule does not '
                'mute it again, which would make it a rule muted by hand (disabled_reason "manual")',
            }, reason
            assert (await w.call("edit_rule", {"id": delta, "enabled": True}))["isError"] is True
            rule = next(r for r in await w.rules() if r["id"] == delta)
            assert (rule["enabled"], rule["disabled_reason"]) == (False, reason)
        assert w.h.sent == []
        # an edit that leaves enabled alone keeps the service's reason, and the cap of one was never spent
        moved = await w.call("edit_rule", {"id": delta, "threshold": 0.3})
        assert moved["isError"] is False, moved["text"]
        assert (moved["data"]["enabled"], moved["data"]["disabled_reason"], moved["data"]["threshold"]) == (
            False,
            "holding-closed",
            0.3,
        )

    async def test_changes_only_a_watch_rule_a_holding_s_rule_is_refused_before_any_write_counting_nothing(
        self, writing
    ):
        # the owner, #456
        w = writing({"mcp_writes_per_10_min": 1})
        await w.created(await w.h.call("/positions", **json_body(CONDOR)))
        held = await w.created(await w.h.call("/monitors", **json_body(RULE)))
        rule = next(r for r in await w.rules() if r["id"] == held)
        assert [p["name"] for p in rule["positions"]] == ["1016_IC"]
        for change in ({"threshold": 0.3}, {"enabled": False}, {"direction": "below"}):
            assert await w.call("edit_rule", {"id": held, **change}) == {
                "isError": True,
                "text": f'the rule "{held}" watches the holding 1016_IC: a holding\'s rules are changed on the page, '
                "and edit_rule changes only a watch rule",
            }, change
        rule = next(r for r in await w.rules() if r["id"] == held)
        assert (rule["threshold"], rule["enabled"]) == (0.2, True)
        assert w.h.sent == []
        watch = await w.created(await w.h.call("/monitors", **json_body({**RULE, "strike": 9000})))
        assert (await w.call("edit_rule", {"id": watch, "threshold": 0.3}))["isError"] is False

    async def test_lets_a_rule_muted_by_hand_be_muted_again_which_changes_nothing(self, writing):
        w, _, delta = await _set_up(writing)
        await w.call("edit_rule", {"id": delta, "enabled": False})
        again = await w.call("edit_rule", {"id": delta, "enabled": False})
        assert again["isError"] is False, again["text"]
        assert (again["data"]["enabled"], again["data"]["disabled_reason"]) == (False, "manual")

    async def test_lets_a_rule_already_on_be_sent_enabled_true_which_changes_nothing(self, writing):
        w, _, _ = await _set_up(writing)
        assert (await w.call("edit_rule", {"id": "1218-6800", "enabled": True}))["isError"] is False
        assert w.h.sent == ["🤖 agent: 1218-6800 |value| ≥ 4.51, unchanged"]

    async def test_refuses_field_and_an_edit_of_nothing_before_writing_anything(self, writing):
        w, _, _ = await _set_up(writing, {"mcp_writes_per_10_min": 1})
        assert await w.call("edit_rule", {"id": "1218-6800", "field": "option_delta"}) == {
            "isError": True,
            "text": 'unexpected argument "field": edit_rule takes only "id", "threshold", "direction", "compare", '
            '"name", "enabled"',
        }
        assert await w.call("edit_rule", {"id": "1218-6800"}) == {
            "isError": True,
            "text": "edit_rule needs at least one change: threshold, direction, compare, name or enabled",
        }
        assert await w.call("edit_rule", {"id": "1218-6800", "enabled": "no"}) == {
            "isError": True,
            "text": '"enabled" must be true or false',
        }
        assert await w.call("edit_rule", {"id": "1218-6800", "enabled": 1}) == {
            "isError": True,
            "text": '"enabled" must be true or false',
        }
        assert w.h.sent == []
        assert (await w.call("edit_rule", {"id": "1218-6800", "threshold": 5}))["isError"] is False

    async def test_names_the_rules_a_name_fits_and_what_it_tried_when_none_as_monitor_history_does(self, writing):
        w, _, _ = await _set_up(writing)
        await w.created(
            await w.h.call(
                "/monitors",
                **json_body({**RULE, "option_type": "PUT", "strike": 7100, "field": "mid_price", "threshold": 3}),
            )
        )
        several = await w.call("edit_rule", {"id": "20261218 P7100", "threshold": 1})
        assert several["isError"] is True
        assert several["text"] == (await w.call("monitor_history", {"id": "20261218 P7100"}))["text"]
        none = await w.call("edit_rule", {"id": "nope", "threshold": 1})
        assert none["text"] == (await w.call("monitor_history", {"id": "nope"}))["text"]
        assert w.h.sent == []

    async def test_carries_the_route_s_refusal_in_its_own_words_and_counts_it(self, writing):
        w, _, delta = await _set_up(writing, {"mcp_writes_per_10_min": 1})
        assert await w.call("edit_rule", {"id": delta, "name": "renamed"}) == {
            "isError": True,
            "text": f"PATCH /monitors/{delta} answered 422: only combo monitors can be renamed; "
            "a single-leg code is derived from its contract",
        }
        assert (await w.call("edit_rule", {"id": delta, "threshold": 0.3}))["text"].startswith(
            "agent writes are capped at 1"
        )


class TestTheNoticeAndTheLog:
    async def test_logs_one_line_for_every_write_attempted_the_door_s_refusals_included_and_none_for_a_read(
        self, writing, caplog
    ):
        w = writing()
        unnamed = {k: v for k, v in PUT_SPREAD.items() if k != "name"}
        with caplog.at_level(logging.INFO, logger=WRITES_LOG):
            await w.call("add_rule", PUT_SPREAD)
            await w.call("add_rule", unnamed)
            await w.call("watchlist")
            await w.call("edit_rule", {"id": "1218-7100", "threshold": 4})
        lines = [r.getMessage() for r in caplog.records if r.name == WRITES_LOG]
        assert len(lines) == 3
        assert re.fullmatch(
            r'mcp add_rule \{.*"name":"1218-7100".*\}: POST /monitors answered 201: rule [0-9a-f]{32}, notice sent',
            lines[0],
        )
        assert re.match(r"mcp add_rule \{.*\}: refused by the door: a rule on 2 legs is a combo", lines[1])
        assert re.fullmatch(
            r'mcp edit_rule \{"id":"1218-7100","threshold":4\}: PATCH /monitors/[0-9a-f]{32} answered 200: '
            r"rule [0-9a-f]{32}, notice sent",
            lines[2],
        )

    async def test_logs_a_write_refused_while_writes_are_off(self, mcp, caplog):
        m = mcp()
        with caplog.at_level(logging.INFO, logger=WRITES_LOG):
            await m.call("edit_rule", {"id": "x", "threshold": 1})
        assert [r.getMessage() for r in caplog.records if r.name == WRITES_LOG] == [
            f'mcp edit_rule {{"id":"x","threshold":1}}: refused by the door: {WRITES_OFF}'
        ]

    async def test_lets_a_write_stand_with_telegram_not_configured_and_logs_that_no_notice_was_sent(
        self, writing, caplog
    ):
        w = writing({"telegram_bot_token": "", "telegram_chat_id": ""})
        with caplog.at_level(logging.INFO):
            assert (await w.call("add_rule", PUT_SPREAD))["isError"] is False
        assert len(await w.rules()) == 1
        assert w.h.sent == []
        said = [r.getMessage() for r in caplog.records]
        assert "telegram not configured; alarm suppressed: 🤖 agent added 1218-7100 |value| ≥ 3.00" in said
        assert next(m for m in said if m.startswith("mcp add_rule")).endswith(", no notice: Telegram is not configured")

    async def test_lets_a_write_stand_when_telegram_refuses_the_notice_and_logs_that_it_was_not_sent(
        self, writing, caplog
    ):
        def down(text):
            raise RuntimeError("telegram is down")

        w = writing(send=down)
        with caplog.at_level(logging.INFO):
            assert (await w.call("add_rule", PUT_SPREAD))["isError"] is False
        assert len(await w.rules()) == 1
        said = [r.getMessage() for r in caplog.records]
        assert "telegram send failed" in said
        assert next(m for m in said if m.startswith("mcp add_rule")).endswith(", its notice not sent")


DOOR = Path(__file__).resolve().parents[3] / "src" / "optionality_backend" / "entrypoints" / "mcp"


class TestTheDoorsReach:
    def test_imports_nothing_of_the_service_no_route_no_query_no_engine_no_write(self):
        # It is handed a GET of the API's own, a write it holds to two routes and a notifier, and that is
        # all it may use (ADR 0026, 0028). Read from the source, so a write path added later fails here
        # rather than in a review.
        sources = sorted(p.name for p in DOOR.glob("*.py"))
        assert sources == ["__init__.py", "server.py", "tools.py", "writes.py"]
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
            "logging",
            "math",
            # the types it is handed, `Read`, `Write` and `Notify`, and nothing that runs
            "...ports",
            # the library's pure domain for the words: a contract as the page writes it is read by
            # `/unwatch`'s own parser, and a rule is said in its short form
            "optionality.alarm",
            "optionality.contract",
            "optionality.js",
            "optionality.timefmt",
            "pathlib",
            "re",
            "starlette.requests",
            "starlette.responses",
            "typing",
            "urllib.parse",
        }


def _table(name: str) -> dict[str, Any]:
    return next(t for t in DESCRIBED["tools"] if t["name"] == name)["round"]


_REPO = Path(__file__).resolve().parents[4]


class TestFiguresAreRoundedByKeyPerTool:
    """#454: the MCP door rounds its answers' figures by key, by the table in `schema/mcp/server.json`."""

    SHARED: ClassVar[dict[str, Any]] = json.loads((_REPO / "testdata" / "mcp" / "rounding.json").read_text("utf-8"))

    def test_half_away_from_zero_on_the_stored_value_to_a_number_minus_0_written_0_the_cases_both_backends_hold(self):
        assert len(self.SHARED["cases"]) > 20
        for value, places, text in self.SHARED["cases"]:
            r = round_to(value, places)
            assert isinstance(r, float | int) and not isinstance(r, bool)
            assert canonical(r) == text, f"{value} to {places}"
            assert str(r) != "-0.0", f"{value} to {places}"

    def test_round_a_figure_by_its_key_the_numbers_of_a_list_under_it_a_map_s_every_value_and_a_rule_s_by_its_field(
        self,
    ):
        table = {
            "keys": {"value": 2, "breakevens": 2, "sigma": 4},
            "maps": {"legs_delta": 4},
            "by_field": ["watched", "threshold"],
        }
        data = {
            "value": -4.100000000000001,
            "sigma": 1.234567,
            "strike": 6800.5,
            "dte": 39,
            "error": "3.14159",
            "nothing": None,
            "flag": True,
            "breakevens": [6301.456, 6398.555],
            "legs_delta": {"US.SPXW261218P6800000": -0.234567, "US.SPXW261218P6750000": None},
            # an object in a list does not inherit its list's key
            "payoff": [{"value": 1.005, "other": 1.23456789}],
            "rows": [
                {
                    "field": "mid_price",
                    "watched": -1.1000000000000003,
                    "threshold": 4.125,
                    "distance": 3.0249999999999995,
                },
                {"field": "option_gamma", "watched": -0.0000403, "threshold": 0.00012},
                {"field": "option_delta", "watched": 0.123456789, "threshold": 0.31234},
                {"field": "something_else", "watched": 0.123456789},
                {"watched": 0.123456789},
            ],
            "constructor": 1.23456789,
            "toString": 2.3456789,
        }
        assert rounded(data, table) == {
            "value": -4.1,
            "sigma": 1.2346,
            "strike": 6800.5,
            "dte": 39,
            "error": "3.14159",
            "nothing": None,
            "flag": True,
            "breakevens": [6301.46, 6398.56],
            "legs_delta": {"US.SPXW261218P6800000": -0.2346, "US.SPXW261218P6750000": None},
            "payoff": [{"value": 1, "other": 1.23456789}],
            "rows": [
                {"field": "mid_price", "watched": -1.1, "threshold": 4.13, "distance": 3.0249999999999995},
                {"field": "option_gamma", "watched": -0.00004, "threshold": 0.00012},
                {"field": "option_delta", "watched": 0.1235, "threshold": 0.3123},
                {"field": "something_else", "watched": 0.123456789},
                {"watched": 0.123456789},
            ],
            "constructor": 1.23456789,
            "toString": 2.3456789,
        }
        # a bool is not a number, as `typeof` says, even under a key the table names
        assert rounded({"value": True}, table) == {"value": True}

    def test_place_every_field_a_rule_may_watch_and_nothing_else_in_the_by_field_table_a_number_or_none_for_never(self):
        # a rule on a field with no place would have its watched, threshold and distance left raw
        # (review of #455, the owner's decision 2)
        table = DESCRIBED["rounding"]["by_field"]
        assert sorted(table) == sorted(WATCHABLE_FIELDS)
        for field in WATCHABLE_FIELDS:
            assert table[field] in (2, 4, 6, None), field

    def test_round_a_quote_s_figure_as_a_rule_watching_that_field_is_rounded_and_every_figure_of_moomoo_s_record(self):
        # the watchlist's `quote` is moomoo's whole record (review of #455, the owner's decision 1). Its
        # fields read from the vendor corpus, which records `RECORD_FIELDS`: `optionality.opend` is a
        # client, behind the vendors' door (test_seams.py)
        corpus = json.loads((_REPO / "testdata" / "vendors" / "opend-fields.json").read_text("utf-8"))
        numbers = [f for f in corpus["constants"]["RECORD_FIELDS"] if f in WATCHABLE_FIELDS]
        assert len(numbers) > 25
        by_field = DESCRIBED["rounding"]["by_field"]
        watchlist = _table("watchlist")["keys"]
        for field in numbers:
            assert watchlist.get(field) == by_field[field], field
        for tool in DESCRIBED["tools"]:
            for key, places in tool["round"].get("keys", {}).items():
                if key in WATCHABLE_FIELDS:
                    assert places == by_field[key], f"{tool['name']}: {key}"

    def test_leave_no_figure_in_any_mcp_scenario_s_answer_under_a_key_the_table_does_not_name_nor_unrounded_under_one_it_does(
        self,
    ):
        walked = 0
        for file in sorted((_REPO / "testdata" / "scenarios" / "http").glob("post-mcp-*.json")):
            scenario = json.loads(file.read_text("utf-8"))
            body = scenario["request"].get("body") or {}
            result = (scenario["expect"]["response"].get("body") or {}).get("result")
            if body.get("method") != "tools/call" or result is None or result.get("isError"):
                continue

            def figure(value: float, places: int | None, file: Path = file) -> float:
                nonlocal walked
                walked += 1
                if places is None:
                    assert float(value).is_integer(), f"{file.name}: {value} is under no key the table names"
                else:
                    assert round_to(value, places) == value, f"{file.name}: {value} is not rounded to {places}"
                return value

            by_key(json.loads(result["content"][0]["text"])["data"], _table(body["params"]["name"]), figure)
        # what it walked, so a walk of nothing cannot pass
        assert walked > 200


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
