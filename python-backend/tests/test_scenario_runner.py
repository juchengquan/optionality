"""The scenario runner's own logic, on small worlds made here (ADR 0021, phase 2).

The corpus can only show the runner passing it, or while a scenario was on the backlog skipping it —
and a runner that compared nothing would do both. These cases are what show it would catch a difference:
the comparison's strictness, the row diff, the vendors' rules, the order the doors run things in, and
the backlog's rules, each against a fake backend plugged into the seam — and, since phase 3, what the
seam builds.
"""

import ast
import json

import pytest
from scenarios import backend, backlog
from scenarios.backend import NotPorted, Response
from scenarios.compare import first_difference, same
from scenarios.doors import ScenarioError, json_text, run_bot, run_http, run_sweep
from scenarios.world import TABLES, VendorError, diff_tables, dump_tables, minted_id, open_world

# -- the comparison -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("actual", "expected"),
    [
        (1, 1.0),  # one number, as JSON has only one kind
        (7300.0, 7300),
        ({"a": 1, "b": [1, 2]}, {"b": [1, 2], "a": 1}),  # key order is not part of a value
        (None, None),
        ("", ""),
        # numbers are IEEE doubles, as the TypeScript that wrote the file reads them: these two
        # integers are one double, and JSON.parse cannot tell them apart
        (9007199254740993, 9007199254740992),
    ],
)
def test_the_same_value(actual, expected):
    assert same(actual, expected)
    assert first_difference(actual, expected) is None


@pytest.mark.parametrize(
    ("actual", "expected", "says"),
    [
        (True, 1, "boolean"),
        (0, False, "boolean"),
        (None, 0, "null"),
        (None, "", "null"),
        ("8050", 8050, "string"),
        (3.1000000000000005, 3.1, "3.1000000000000005"),  # exactly, with no tolerance
        (0.1 + 0.2, 0.3, "0.30000000000000004"),
        ([1, 2], [2, 1], "$[0]"),  # array order is part of a value
        ([1], [1, 1], "length"),
        ({"a": 1, "extra": 2}, {"a": 1}, 'unexpected key "extra"'),
        ({"a": 1}, {"a": 1, "gone": 2}, 'missing key "gone"'),
        ((1, 2), [1, 2], "tuple"),  # what is not JSON is not equal to anything
    ],
)
def test_a_different_value(actual, expected, says):
    assert not same(actual, expected)
    assert says in first_difference(actual, expected)


def test_a_difference_says_where_it_is():
    found = first_difference({"response": {"body": [{"pnl": 315}]}}, {"response": {"body": [{"pnl": 316}]}})
    assert found.startswith("at $.response.body[0].pnl:")


# -- a small world ----------------------------------------------------------------------------------


def vendor(**table):
    return {"down": None, "rejects": {}, "unknown": [], "quotes": {}, **table}


def world(**overrides):
    base = {
        "clock": "2026-11-09T15:00:00.000Z",
        "settings": {"API_TOKEN": "tok"},
        "provider": {"name": "moomoo", "reachable": True, **vendor()},
        "sources": {},
        "telegram": "up",
        "sweeps": [],
        "tables": {table: [] for table in TABLES},
    }
    return {**base, **overrides}


POSITION = {
    "id": "pos-1",
    "name": "dec-condor",
    "strategy": None,
    "strike_date": "2026-12-18",
    "contracts": 1,
    "entry": 6.4,
    "legs": [{"side": "short", "option_type": "CALL", "strike": 7300}],
    "created_at": "2026-11-02 14:30:00.000000",
    "opened_at": None,
    "manage_notified_at": None,
    "closed_on": None,
    "exit": None,
    "qty_corrected_at": None,
}


def held(*rows):
    return {**world()["tables"], "positions": list(rows)}


# -- the row diff -----------------------------------------------------------------------------------


def test_the_diff_names_only_what_moved():
    w = open_world(world(tables=held(POSITION, {**POSITION, "id": "pos-2", "name": "other"})))
    try:
        before = dump_tables(w.db)
        w.db.execute("update positions set opened_at = '2026-10-12' where id = 'pos-1'")
        w.db.execute("delete from positions where id = 'pos-2'")
        w.db.execute(
            "insert into reference_securities (id, code, label, source, created_at) "
            "values ('ref-1', 'US..SPX', null, 'moomoo', '2026-11-09 15:00:00.000000')"
        )
        diff = diff_tables(w.db, before, dump_tables(w.db))
    finally:
        w.close()
    assert diff == {
        "positions": {
            "changed": [{"key": {"id": "pos-1"}, "from": {"opened_at": None}, "to": {"opened_at": "2026-10-12"}}],
            "removed": [{"id": "pos-2"}],
        },
        "reference_securities": {
            "added": [
                {
                    "id": "ref-1",
                    "code": "US..SPX",
                    "label": None,
                    "source": "moomoo",
                    "created_at": "2026-11-09 15:00:00.000000",
                }
            ]
        },
    }


def test_the_diff_does_not_see_a_change_of_spelling():
    # `7` in the file is 7.0 in a FLOAT column, and a JSON column rewritten with its keys in another
    # order or as `7300.0` holds the same value: none of that is something the door DID
    stated = held({**POSITION, "entry": 7})
    w = open_world(world(tables=stated))
    try:
        w.db.execute("""update positions set legs = '[{"strike":7300.0,"option_type":"CALL","side":"short"}]'""")
        assert w.db.execute("select typeof(entry) from positions").fetchone() == ("real",)
        assert diff_tables(w.db, stated, dump_tables(w.db)) == {}
    finally:
        w.close()


# -- the vendors ------------------------------------------------------------------------------------


def test_a_vendor_answers_from_its_table_and_records_every_call():
    w = open_world(
        world(
            provider={
                "name": "moomoo",
                "reachable": True,
                **vendor(quotes={"A": {"mid_price": 1.5}}, unknown=["B"], rejects={"US..SPX": "not supported"}),
            },
            sources={"yahoo": vendor(down="yahoo is down")},
        )
    )
    try:
        fetch = w.provider.fetch_quotes
        batch = fetch(["A", "B", "C"])
        # C has no answer: subscribed, nothing yet — which is not the same as unknown
        assert batch.records == [{"code": "A", "mid_price": 1.5}] and batch.unknown == ["B"]
        with pytest.raises(VendorError, match="not supported"):
            fetch(["A", "US..SPX"])
        with pytest.raises(VendorError, match="yahoo is down"):
            w.sources["yahoo"](["^VIX"])
        assert w.sources["moomoo"] is fetch  # the Provider is a source under its own name
        w.outage.down = "Client connection failed!"
        with pytest.raises(VendorError, match="Client connection failed!"):
            fetch(["A"])
        assert w.calls == {"moomoo": [["A", "B", "C"], ["A", "US..SPX"], ["A"]], "yahoo": [["^VIX"]]}
        assert w.provider.reachable() is True
    finally:
        w.close()


def test_ids_are_minted_in_order_as_32_hex_characters():
    assert minted_id(1) == "00000000000000000000000000000001"
    assert minted_id(26) == "0000000000000000000000000000001a"
    w = open_world(world())
    try:
        assert [w.new_id(), w.new_id()] == [minted_id(1), minted_id(2)]
    finally:
        w.close()


def test_telegram_down_fails_every_send_and_delivers_nothing():
    w = open_world(world(telegram="down"))
    try:
        with pytest.raises(VendorError, match="telegram"):
            w.send("hello")
        assert w.sent == []
    finally:
        w.close()


# -- the doors, through a fake backend in the seam -------------------------------------------------


class Fake:
    """A backend that does what each test tells it to, built on the open world like the real one."""

    def __init__(self, world, on_request=None, on_update=None, on_sweep=None):
        self.world = world
        self.on_request, self.on_update, self.on_sweep = on_request, on_update, on_sweep
        self.seen = []
        self.closed = False

    def request(self, method, path, headers, body):
        self.seen.append((method, path, headers, body))
        return self.on_request(self.world)

    def handle_update(self, update):
        self.on_update(self.world, update)

    def sweep(self):
        self.on_sweep(self.world)

    def close(self):
        self.closed = True


def build_with(**handlers):
    built = []

    def build(w):
        built.append(Fake(w, **handlers))
        return built[-1]

    return build, built


def test_http_sends_the_body_as_json_and_parses_a_json_answer():
    build, built = build_with(on_request=lambda w: Response(201, "application/json; charset=UTF-8", '{"id": 1}'))
    request = {"method": "POST", "path": "/positions", "headers": {"Authorization": "Bearer tok"}, "body": {"a": [1]}}
    out = run_http({"world": world(), "request": request}, build)
    assert out == {"response": {"status": 201, "body": {"id": 1}}, "rows": {}, "calls": {}}
    assert built[0].seen == [
        ("POST", "/positions", {"Authorization": "Bearer tok", "Content-Type": "application/json"}, '{"a":[1]}')
    ]


@pytest.mark.parametrize(
    ("answer", "body"),
    [
        (Response(404, "text/plain", "404 Not Found"), "404 Not Found"),  # not JSON: the raw text
        (Response(204, "application/json", ""), None),  # empty: null
    ],
)
def test_http_reads_an_answer_that_is_not_json(answer, body):
    build, built = build_with(on_request=lambda w: answer)
    request = {"method": "GET", "path": "/nothing", "headers": {}, "body": None}
    out = run_http({"world": world(), "request": request}, build)
    assert out["response"] == {"status": answer.status, "body": body}
    assert built[0].seen[0][2:] == ({}, None)  # no body, and no Content-Type for one


def test_a_door_reports_the_rows_it_wrote_and_the_codes_it_asked_for():
    def create(w):
        w.provider.fetch_quotes(["US..SPX"])
        w.db.execute(
            "insert into reference_securities (id, code, label, source, created_at) values (?, ?, null, ?, ?)",
            (w.new_id(), "US..SPX", "moomoo", "2026-11-09 15:00:00.000000"),
        )
        return Response(201, "application/json", "{}")

    build, _ = build_with(on_request=create)
    request = {"method": "POST", "path": "/references", "headers": {}, "body": {"code": "US..SPX"}}
    out = run_http({"world": world(), "request": request}, build)
    assert out["rows"] == {
        "reference_securities": {
            "added": [
                {
                    "id": "00000000000000000000000000000001",
                    "code": "US..SPX",
                    "label": None,
                    "source": "moomoo",
                    "created_at": "2026-11-09 15:00:00.000000",
                }
            ]
        }
    }
    assert out["calls"] == {"moomoo": [["US..SPX"]]}


def test_the_earlier_sweeps_give_memory_and_are_then_forgotten():
    seen = []

    def sweep(w):
        seen.append((w.clock.now.isoformat(), w.outage.down))
        try:
            w.provider.fetch_quotes(["A"])
        except VendorError:
            return
        w.send(f"swept at {w.clock.now:%H:%M}")

    build, _ = build_with(on_sweep=sweep)
    sweeps = [
        {"at": "2026-11-09T14:58:00.000Z", "down": "Client connection failed!"},
        {"at": "2026-11-09T14:59:00.000Z", "down": None},
    ]
    out = run_sweep({"world": world(sweeps=sweeps)}, build)
    assert seen == [
        ("2026-11-09T14:58:00+00:00", "Client connection failed!"),
        ("2026-11-09T14:59:00+00:00", None),
        ("2026-11-09T15:00:00+00:00", None),  # the event, at the world's clock, its Provider up
    ]
    # the earlier sweeps' calls and messages are not part of what the event did
    assert out == {"messages": ["swept at 15:00"], "rows": {}, "calls": {"moomoo": [["A"]]}}


def test_an_earlier_sweep_may_not_change_a_row():
    def sweep(w):
        w.db.execute("update positions set opened_at = '2026-10-12'")

    build, _ = build_with(on_sweep=sweep)
    scenario = {"world": world(tables=held(POSITION), sweeps=[{"at": "2026-11-09T14:59:00.000Z", "down": None}])}
    with pytest.raises(ScenarioError, match="an earlier sweep changed the tables"):
        run_sweep(scenario, build)


def test_the_bot_replies_through_the_fake_api():
    def answer(w, update):
        w.api("sendChatAction", {"chat_id": "42", "action": "typing"})  # not a reply
        w.api("sendMessage", {"chat_id": "42", "text": update["message"]["text"].upper()})

    build, _ = build_with(on_update=answer)
    update = {"update_id": 1, "message": {"chat": {"id": 42}, "text": "/help"}}
    out = run_bot({"world": world(), "update": update}, build)
    assert out == {"reply": {"chat_id": "42", "text": "/HELP", "parse_mode": None}, "rows": {}, "calls": {}}


def test_the_bot_may_say_nothing_but_not_twice():
    silent, _ = build_with(on_update=lambda w, u: None)
    update = {"update_id": 1, "message": {"chat": {"id": 666}, "text": "/help"}}
    assert run_bot({"world": world(), "update": update}, silent)["reply"] is None

    def twice(w, u):
        w.api("sendMessage", {"chat_id": "42", "text": "one"})
        w.api("sendMessage", {"chat_id": "42", "text": "two"})

    loud, _ = build_with(on_update=twice)
    with pytest.raises(ScenarioError, match="twice"):
        run_bot({"world": world(), "update": update}, loud)


def test_the_seam_builds_the_python_backend_on_the_world():
    # phase 3: `build` answers with the real app, on the world's database and its `.env` lines
    w = open_world(world(settings={"API_TOKEN": "tok"}))
    service = backend.build(w)
    try:
        assert service.request("GET", "/positions", {"Authorization": "Bearer tok"}, None) == Response(
            200, "application/json", "[]"
        )
        assert service.request("GET", "/positions", {}, None).status == 401
    finally:
        service.close()
        w.close()


def test_the_seam_runs_a_tick_of_the_real_engine_on_the_world():
    # phase 4: `sweep` is one tick of `MonitorSweeper` on the world's database, at its clock, asking
    # its Provider and telling its Telegram — the held position's leg is in the batch and its sample
    # is written, which no stand-in would do
    w = open_world(
        world(
            settings={"API_TOKEN": "tok", "TELEGRAM_BOT_TOKEN": "t", "TELEGRAM_CHAT_ID": "42"},
            provider={
                "name": "moomoo",
                "reachable": True,
                **vendor(quotes={"US.SPXW261218C7300000": {"mid_price": 2}}),
            },
            tables=held(POSITION),
        )
    )
    service = backend.build(w)
    try:
        service.sweep()
        assert w.calls == {"moomoo": [["US.SPXW261218C7300000"]]}
        assert dump_tables(w.db)["position_samples"] == [
            {
                "position_id": "pos-1",
                "observed_on": "2026-11-09",
                "dte": 39,
                "cost_to_close": 2,
                "legs_iv": None,
                "legs_vega": None,
                "legs_delta": None,
                # the sweep's own instant, the world's clock as the database stores it
                "observed_at": "2026-11-09 15:00:00.000000",
                "spx": None,
            }
        ]
        assert w.sent == []
    finally:
        service.close()
        w.close()


def test_the_seam_answers_an_update_with_the_real_bot_through_the_world_s_telegram():
    # phase 4: `handle_update` is the bot's own handler on the world's database, answering through its
    # fake Telegram API — the owner check reads the world's `.env`, and an empty watchlist asks the
    # Provider nothing
    w = open_world(world(settings={"API_TOKEN": "tok", "TELEGRAM_BOT_TOKEN": "t", "TELEGRAM_CHAT_ID": "42"}))
    service = backend.build(w)
    try:
        service.handle_update({"update_id": 1, "message": {"chat": {"id": 42}, "text": "/quotes"}})
        service.handle_update({"update_id": 2, "message": {"chat": {"id": 666}, "text": "/quotes"}})
        assert w.replies == [{"chat_id": "42", "text": "Watchlist is empty. Add one with /watch."}]
        assert w.calls == {}
    finally:
        service.close()
        w.close()


def test_the_backend_is_closed_with_its_world_even_when_its_door_fails():
    def broken(w):
        raise RuntimeError("the door broke")

    build, built = build_with(on_request=broken)
    request = {"method": "GET", "path": "/positions", "headers": {}, "body": None}
    with pytest.raises(RuntimeError, match="the door broke"):
        run_http({"world": world(), "request": request}, build)
    assert built[0].closed


# -- the backlog's rules ------------------------------------------------------------------------------


def passes(w, update):
    """The whole of what the bot scenario below expects: no reply, no row, no call."""


TINY = {"world": world(), "update": {"update_id": 1, "message": {"chat": {"id": 666}, "text": "/help"}}}
TINY["expect"] = {"reply": None, "rows": {}, "calls": {}}


def judge(listed, **handlers):
    build, _ = build_with(**handlers)
    return backlog.judge("bot/tiny.json", TINY, listed=listed, build=build)


def test_a_listed_scenario_that_passes_must_come_off_the_backlog():
    outcome, why = judge(listed=True, on_update=passes)
    assert outcome == "fail" and why == "bot/tiny.json passes: take it off the backlog"


def test_a_listed_scenario_that_fails_is_skipped_and_says_why():
    def wrong(w, u):
        w.api("sendMessage", {"chat_id": "666", "text": "hello"})

    outcome, why = judge(listed=True, on_update=wrong)
    assert outcome == "skip" and why.startswith("on the backlog: at $.reply:")


def not_ported(w, update):
    """A backend whose door is not there yet — every door of the real one is, since the bot landed."""
    raise NotPorted("the bot is not ported yet")


def test_a_listed_scenario_that_is_not_ported_is_skipped_and_says_so():
    outcome, why = judge(listed=True, on_update=not_ported)
    assert outcome == "skip" and why == "on the backlog: not ported — the bot is not ported yet"


def test_an_unlisted_scenario_must_pass():
    assert judge(listed=False, on_update=passes) == ("pass", "")
    outcome, why = judge(listed=False, on_update=not_ported)
    assert outcome == "fail"
    assert why.startswith("bot/tiny.json is not on the backlog, so the Python must pass it")
    assert "not ported" in why


def test_an_unlisted_scenario_that_crashes_is_not_swallowed():
    def crash(w, u):
        raise KeyError("chat")

    with pytest.raises(KeyError):
        judge(listed=False, on_update=crash)
    # on the backlog a crash is one more way of not passing yet, and the reason names it
    assert judge(listed=True, on_update=crash) == ("skip", "on the backlog: KeyError: 'chat'")


def test_the_backlog_may_name_only_scenarios_that_exist_and_each_once():
    corpus = ["bot/a.json", "http/b.json"]
    assert backlog.findings(corpus, ["bot/a.json"]) == []
    assert backlog.findings(corpus, ["bot/a.json", "sweep/gone.json", "bot/a.json"]) == [
        "the backlog names sweep/gone.json, which is not in testdata/scenarios/ any more",
        "the backlog names bot/a.json twice",
    ]


def test_the_backlog_is_written_out_so_a_scenario_joins_it_only_in_a_diff():
    # derived from the directory, it would take in every new scenario unseen — the opposite of
    # lockstep, where a TypeScript scenario and the Python that passes it land together
    tree = ast.parse(backlog.SOURCE.read_text())
    assigned = [
        n
        for n in tree.body
        if isinstance(n, ast.Assign) and any(getattr(t, "id", None) == "BACKLOG" for t in n.targets)
    ]
    assert len(assigned) == 1, "BACKLOG must be assigned once, at the top of backlog.py"
    value = assigned[0].value
    assert isinstance(value, ast.List), "BACKLOG must be a list written out, not computed"
    assert all(isinstance(e, ast.Constant) and isinstance(e.value, str) for e in value.elts)
    assert [e.value for e in value.elts] == backlog.BACKLOG


def test_scenario_text_round_trips_through_the_runner_unchanged():
    # what the runner sends is what the file says, as JSON.stringify would write it
    assert json_text({"label": "é", "n": [1, 2.5]}) == '{"label":"é","n":[1,2.5]}'
    assert json.loads(json_text({"a": None})) == {"a": None}
