from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from optionality.service.models import Monitor
from optionality.service.settings import Settings
from optionality.service.telegram_bot import TelegramBot


def _future() -> str:
    return (datetime.now(UTC).date() + timedelta(days=30)).isoformat()


class FakeApi:
    def __init__(self):
        self.sent = []
        self.calls = []

    def __call__(self, method, params):
        self.calls.append((method, params))
        if method == "sendMessage":
            self.sent.append(params["text"])
            return {}
        return []


def _echo_fetcher(codes, opend_host=None, opend_port=None):
    return [{"code": c} for c in codes]


def _make_bot(session_factory, fetcher=None):
    api = FakeApi()
    settings = Settings(telegram_bot_token="t", telegram_chat_id="42")
    bot = TelegramBot(session_factory, settings, api=api, fetcher=fetcher or _echo_fetcher)
    return bot, api


def _update(text, chat_id=42):
    return {"update_id": 1, "message": {"chat": {"id": chat_id}, "text": text}}


def test_ignores_messages_from_other_chats(session_factory):
    bot, api = _make_bot(session_factory)
    bot.handle_update(_update("/monitors", chat_id=999))
    assert api.sent == []


def test_watch_creates_monitor_and_duplicate_is_reported(session_factory):
    bot, api = _make_bot(session_factory)
    bot.handle_update(_update(f"/watch {_future()} CALL 6500 0.6"))
    assert "watching" in api.sent[-1].lower()
    with session_factory() as s:
        monitor = s.scalar(select(Monitor))
        assert monitor.code.endswith("C6500000")
        assert monitor.threshold == 0.6

    bot.handle_update(_update(f"/watch {_future()} CALL 6500 0.7"))
    assert "already" in api.sent[-1].lower()


def test_watch_compact_date_is_normalized(session_factory):
    bot, api = _make_bot(session_factory)
    compact = _future().replace("-", "")
    bot.handle_update(_update(f"/watch {compact} CALL 6500 0.6"))
    assert "watching" in api.sent[-1].lower()
    with session_factory() as s:
        assert s.scalar(select(Monitor)).strike_date == _future()


def test_watchcombo_creates_and_combo_shows_breakdown(session_factory):
    from optionality.apis.aux import build_spx_code

    date = _future()
    c8100, c8150 = build_spx_code(date, "CALL", 8100), build_spx_code(date, "CALL", 8150)

    def fetcher(codes, opend_host=None, opend_port=None):
        prices = {c8100: 26.4, c8150: 19.25}
        return [{"code": c, "mid_price": prices[c]} for c in codes if c in prices]

    bot, api = _make_bot(session_factory, fetcher=fetcher)
    bot.handle_update(_update(f"/watchcombo sep-condor {date} +C8100 -C8150 10 below"))
    assert "sep-condor" in api.sent[-1]
    assert "≤" in api.sent[-1]
    with session_factory() as s:
        m = s.scalar(select(Monitor))
        assert m.code == "sep-condor"
        assert m.field == "mid_price"
        assert m.direction == "below"
        assert [leg["sign"] for leg in m.legs] == [1, -1]

    bot.handle_update(_update("/combo sep-condor"))
    reply = api.sent[-1]
    assert reply.startswith("<pre>")
    assert "26.4" in reply
    assert "19.25" in reply
    assert "total" in reply
    assert "7.15" in reply  # 26.4 - 19.25

    bot.handle_update(_update("/monitors"))
    assert "sep-condor" in api.sent[-1]

    bot.handle_update(_update("/unwatch sep-condor"))
    assert "removed" in api.sent[-1].lower()
    with session_factory() as s:
        assert s.scalar(select(Monitor)) is None


def test_threshold_command_updates_by_name_or_label(session_factory):
    bot, api = _make_bot(session_factory)
    bot.handle_update(_update(f"/watchcombo sep-condor {_future()} +C8100 -C8150 10 below"))
    bot.handle_update(_update("/threshold sep-condor 25"))
    assert "25" in api.sent[-1]
    with session_factory() as s:
        assert s.scalar(select(Monitor).where(Monitor.code == "sep-condor")).threshold == 25.0

    bot.handle_update(_update(f"/watch {_future()} CALL 6500 0.6"))
    bot.handle_update(_update(f"/threshold {_yymmdd()} C6500 0.5"))
    assert "0.5" in api.sent[-1]
    with session_factory() as s:
        assert s.scalar(select(Monitor).where(Monitor.code != "sep-condor")).threshold == 0.5

    bot.handle_update(_update("/threshold ghost 1"))
    assert "no monitor" in api.sent[-1].lower()


def test_watchcombo_bad_args(session_factory):
    bot, api = _make_bot(session_factory)
    bot.handle_update(_update(f"/watchcombo broken {_future()} +C8100 10"))  # only one leg
    assert "usage" in api.sent[-1].lower()
    with session_factory() as s:
        assert s.scalar(select(Monitor)) is None


def test_watch_with_direction_below(session_factory):
    bot, api = _make_bot(session_factory)
    bot.handle_update(_update(f"/watch {_future()} CALL 8100 30 mid_price below"))
    assert "watching" in api.sent[-1].lower()
    assert "≤" in api.sent[-1]
    with session_factory() as s:
        m = s.scalar(select(Monitor))
        assert m.direction == "below"
        assert m.field == "mid_price"

    bot.handle_update(_update("/monitors"))
    assert "≤30" in api.sent[-1]  # threshold cell carries the direction


def test_watch_with_bad_args_replies_usage(session_factory):
    bot, api = _make_bot(session_factory)
    bot.handle_update(_update("/watch nope"))
    assert "usage" in api.sent[-1].lower()
    with session_factory() as s:
        assert s.scalar(select(Monitor)) is None


def test_signed_keyword_in_bot(session_factory):
    bot, api = _make_bot(session_factory)
    bot.handle_update(_update(f"/watchcombo bear-cs {_future()} -C8100 +C8150 -4.05 signed below"))
    assert "-4.05" in api.sent[-1]
    with session_factory() as s:
        m = s.scalar(select(Monitor))
        assert m.compare == "signed"
        assert m.threshold == -4.05
        assert m.direction == "below"

    bot.handle_update(_update("/threshold bear-cs -5"))
    assert "-5" in api.sent[-1]
    with session_factory() as s:
        assert s.scalar(select(Monitor)).threshold == -5.0

    bot.handle_update(_update("/threshold bear-cs 0"))
    assert "0" in api.sent[-1].lower() and "signed" in api.sent[-1].lower()  # zero rejected for signed
    with session_factory() as s:
        assert s.scalar(select(Monitor)).threshold == -5.0  # unchanged


def test_negative_threshold_rejected_in_bot(session_factory):
    bot, api = _make_bot(session_factory)
    bot.handle_update(_update(f"/watch {_future()} CALL 6500 -0.5"))
    assert "positive" in api.sent[-1].lower()
    bot.handle_update(_update(f"/watchcombo x {_future()} +C8100 -C8150 -4.05"))
    assert "positive" in api.sent[-1].lower()
    with session_factory() as s:
        assert s.scalar(select(Monitor)) is None

    bot.handle_update(_update(f"/watch {_future()} CALL 6500 0.6"))
    bot.handle_update(_update(f"/threshold {_yymmdd()} C6500 0"))
    assert "positive" in api.sent[-1].lower()
    with session_factory() as s:
        assert s.scalar(select(Monitor)).threshold == 0.6  # unchanged


def _yymmdd() -> str:
    return _future().replace("-", "")[2:]


def test_monitors_lists_watchlist_as_table(session_factory):
    bot, api = _make_bot(session_factory)
    bot.handle_update(_update("/monitors"))
    assert "empty" in api.sent[-1].lower()
    bot.handle_update(_update(f"/watch {_future()} PUT 6425 0.5"))
    bot.handle_update(_update("/monitors"))
    reply = api.sent[-1]
    assert reply.startswith("<pre>")
    assert reply.endswith("</pre>")
    assert f"{_yymmdd()} P6425" in reply  # short contract label, not the full moomoo code
    assert "armed" in reply
    assert api.calls[-1][1].get("parse_mode") == "HTML"


def test_help_stays_plain_text(session_factory):
    bot, api = _make_bot(session_factory)
    bot.handle_update(_update("/help"))
    assert "parse_mode" not in api.calls[-1][1]  # plain replies must not be HTML-parsed


def test_short_code_labels():
    from optionality.service.telegram_bot import _short_code

    assert _short_code("US.SPXW260918C8100000") == "260918 C8100"
    assert _short_code("US.SPXW261218P6425000") == "261218 P6425"
    assert _short_code("US.WEIRD123") == "US.WEIRD123"  # non-SPXW codes pass through


def test_unwatch_by_short_label(session_factory):
    bot, api = _make_bot(session_factory)
    bot.handle_update(_update(f"/watch {_future()} CALL 6500 0.6"))
    bot.handle_update(_update(f"/unwatch {_yymmdd()} C6500"))
    assert "removed" in api.sent[-1].lower()
    with session_factory() as s:
        assert s.scalar(select(Monitor)) is None


def test_unwatch_by_code_and_by_id_prefix(session_factory):
    bot, api = _make_bot(session_factory)
    bot.handle_update(_update(f"/watch {_future()} CALL 6500 0.6"))
    with session_factory() as s:
        monitor = s.scalar(select(Monitor))
        code, mid = monitor.code, monitor.id

    bot.handle_update(_update(f"/unwatch {code}"))
    assert "removed" in api.sent[-1].lower()
    with session_factory() as s:
        assert s.scalar(select(Monitor)) is None

    bot.handle_update(_update(f"/watch {_future()} CALL 6500 0.6"))
    with session_factory() as s:
        mid = s.scalar(select(Monitor)).id
    bot.handle_update(_update(f"/unwatch {mid[:8]}"))
    assert "removed" in api.sent[-1].lower()

    bot.handle_update(_update("/unwatch nothere"))
    assert "no monitor" in api.sent[-1].lower()


def test_snapshot_command_uses_fetcher(session_factory):
    def fetcher(codes, opend_host=None, opend_port=None):
        return [
            {
                "code": codes[0],
                "name": "SPXW TEST",
                "option_delta": 0.512345,
                "option_implied_volatility": 21.45678,
                "bid_price": 1.0,
                "ask_price": 2.0,
            }
        ]

    bot, api = _make_bot(session_factory, fetcher=fetcher)
    bot.handle_update(_update(f"/snapshot {_future()} CALL 6500"))
    assert "option_delta: 0.512" in api.sent[-1]
    assert "0.512345" not in api.sent[-1]  # rounded to three decimals, not raw
    assert "option_implied_volatility: 21.457" in api.sent[-1]
    assert "21.45678" not in api.sent[-1]


def test_monitors_grouped_by_expiry_then_calls_before_puts(session_factory):
    bot, api = _make_bot(session_factory)
    far = (datetime.now(UTC).date() + timedelta(days=40)).isoformat()
    bot.handle_update(_update(f"/watch {_future()} PUT 6425 0.5"))
    bot.handle_update(_update(f"/watch {far} CALL 8100 0.6"))
    bot.handle_update(_update(f"/watch {_future()} CALL 6500 0.6"))
    bot.handle_update(_update("/monitors"))
    reply = api.sent[-1]
    near_call, near_put, far_call = reply.index("C6500"), reply.index("P6425"), reply.index("C8100")
    # expiry groups first, so a condor's legs stay together instead of splitting across CALL/PUT blocks
    assert near_call < near_put < far_call


def test_greeks_command_table(session_factory):
    def fetcher(codes, opend_host=None, opend_port=None):
        return [
            {
                "code": c,
                "option_delta": 0.166096,
                "option_gamma": 0.000124194,
                "option_theta": -1.117809,
                "option_implied_volatility": 22.012,
            }
            for c in codes
        ]

    bot, api = _make_bot(session_factory, fetcher=fetcher)
    bot.handle_update(_update("/greeks"))
    assert "empty" in api.sent[-1].lower()

    bot.handle_update(_update(f"/watch {_future()} CALL 8100 0.6"))
    bot.handle_update(_update("/greeks"))
    reply = api.sent[-1]
    assert reply.startswith("<pre>")
    assert f"{_yymmdd()} C8100" in reply
    assert "0.166" in reply  # delta, three decimals
    assert "0.00012" in reply  # gamma, five decimals
    assert "-1.12" in reply  # theta, two decimals
    assert "22.012" not in reply  # IV moved to /vol
    assert api.calls[-1][1].get("parse_mode") == "HTML"


def test_vol_command_table(session_factory):
    def fetcher(codes, opend_host=None, opend_port=None):
        return [{"code": c, "option_implied_volatility": 22.012345, "option_vega": 5.894970} for c in codes]

    bot, api = _make_bot(session_factory, fetcher=fetcher)
    bot.handle_update(_update("/vol"))
    assert "empty" in api.sent[-1].lower()

    bot.handle_update(_update(f"/watch {_future()} CALL 8100 0.6"))
    bot.handle_update(_update("/vol"))
    reply = api.sent[-1]
    assert reply.startswith("<pre>")
    assert f"{_yymmdd()} C8100" in reply
    assert "22.012" in reply  # IV, three decimals
    assert "22.012345" not in reply
    assert "5.89" in reply  # vega, two decimals
    assert api.calls[-1][1].get("parse_mode") == "HTML"


def test_health_command_shows_local_sweep_time(session_factory):
    from optionality.service.monitor import MonitorSweeper

    settings = Settings(telegram_bot_token="t", telegram_chat_id="42", display_tz="Asia/Singapore")
    sweeper = MonitorSweeper(session_factory, settings)
    sweeper.last_sweep_at = datetime(2026, 8, 10, 3, 35, tzinfo=UTC)
    sweeper.last_sweep_ok = True
    api = FakeApi()
    bot = TelegramBot(session_factory, settings, api=api, sweeper=sweeper)
    bot.handle_update(_update("/health"))
    assert "2026-08-10 11:35 +08" in api.sent[-1]


def test_non_command_text_gets_help(session_factory):
    bot, api = _make_bot(session_factory)
    bot.handle_update(_update("hello there"))
    assert "/watch" in api.sent[-1]


def test_register_commands_publishes_menu(session_factory):
    import json

    bot, api = _make_bot(session_factory)
    bot._register_commands()
    method, params = api.calls[-1]
    assert method == "setMyCommands"
    names = [c["command"] for c in json.loads(params["commands"])]
    assert names == [
        "monitors",
        "quotes",
        "greeks",
        "vol",
        "watch",
        "watchcombo",
        "unwatch",
        "combo",
        "threshold",
        "rename",
        "snapshot",
        "health",
        "help",
    ]
    descriptions = [c["description"] for c in json.loads(params["commands"])]
    assert all(descriptions)


def test_quotes_command_reports_watched_codes(session_factory):
    def fetcher(codes, opend_host=None, opend_port=None):
        return [
            {
                "code": c,
                "name": f"NAME {c[-8:]}",
                "option_delta": 0.42,
                "bid_price": 1.0,
                "ask_price": 2.0,
                "mid_price": 1.5,
            }
            for c in codes
        ]

    bot, api = _make_bot(session_factory, fetcher=fetcher)
    bot.handle_update(_update("/quotes"))
    assert "empty" in api.sent[-1].lower()

    bot.handle_update(_update(f"/watch {_future()} CALL 6500 0.6"))
    bot.handle_update(_update("/quotes"))
    reply = api.sent[-1]
    assert reply.startswith("<pre>")
    assert f"{_yymmdd()} C6500" in reply
    assert "1.5" in reply  # mid column
    assert "1.0/2.0" in reply  # bid/ask column
    assert "0.42" not in reply  # delta lives in /greeks now; /quotes is a pure price view
    assert api.calls[-1][1].get("parse_mode") == "HTML"


def test_watch_rejects_unknown_contract(session_factory):
    def fetcher(codes, opend_host=None, opend_port=None):
        raise RuntimeError("snapshot API failed: Unknown stock. " + codes[0].removeprefix("US."))

    bot, api = _make_bot(session_factory, fetcher=fetcher)
    bot.handle_update(_update(f"/watch {_future()} CALL 99999 0.5"))
    assert "does not exist" in api.sent[-1]
    with session_factory() as s:
        assert s.scalar(select(Monitor)) is None


def test_rename_command(session_factory):
    bot, api = _make_bot(session_factory)
    bot.handle_update(_update(f"/watchcombo old-name {_future()} +C8100 -C8150 10 below"))
    bot.handle_update(_update("/rename old-name new-name"))
    assert "new-name" in api.sent[-1]
    with session_factory() as s:
        assert s.scalar(select(Monitor)).code == "new-name"

    bot.handle_update(_update("/rename ghost whatever"))
    assert "no combo" in api.sent[-1].lower()

    bot.handle_update(_update("/rename new-name"))
    assert "usage" in api.sent[-1].lower()
