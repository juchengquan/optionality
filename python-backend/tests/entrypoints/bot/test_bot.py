"""The Telegram bot. Port of backend/src/entrypoints/bot/bot.test.ts.

Driven through `handle_update` with a fake API, exactly as the TypeScript's tests are — and for a
reason that is not convenience: the token allows ONE getUpdates consumer, the live service is holding
it, and a test that reached the real API would either fail or steal the owner's updates.

Replies are asserted character for character where the formatting is the point. They are read on a
phone, and a column that wraps is a table that cannot be read at all.

What only the Python can get wrong is at the end.
"""

import json
import logging
from datetime import UTC, datetime
from typing import Any

import pytest
from harness import FakeProvider, FakeSweeper, fake_fetcher
from optionality.contract import build_spx_code
from optionality.quote import Batch

from optionality_backend.db.open import create_database
from optionality_backend.db.queries.sql import row, rows
from optionality_backend.db.values import to_sqlite_json
from optionality_backend.entrypoints.bot.bot import BotDeps, TelegramBot
from optionality_backend.env import settings_for

#: Fixed, so a date-relative expectation cannot drift into a different market day overnight.
NOW = datetime(2026, 10, 2, 5, 0, tzinfo=UTC)
FUTURE = "2026-11-01"
#: 45 days before FUTURE, so a holding opened then has a schedule to speak of
OPENED = "2026-09-17"
YYMMDD = "261101"
FAR = "2026-11-11"


def echo(codes: list[str]) -> list[dict[str, Any]]:
    return [{"code": c} for c in codes]


class Telegram:
    """A fake Telegram API, and what the bot asked of it."""

    def __init__(self) -> None:
        self.sent: list[str] = []
        self.calls: list[tuple[str, dict[str, str]]] = []

    async def api(self, method: str, params: dict[str, str]) -> Any:
        self.calls.append((method, params))
        if method == "sendMessage":
            self.sent.append(params["text"])
            return {}
        return []


class Chat:
    """One test's database, Telegram and bots: `bot()` in the TypeScript, with its `last()`,
    `lastParams()` and `monitors()`."""

    def __init__(self, db) -> None:
        self.db = db
        self.telegram = Telegram()

    @property
    def sent(self) -> list[str]:
        return self.telegram.sent

    @property
    def calls(self) -> list[tuple[str, dict[str, str]]]:
        return self.telegram.calls

    def bot(self, fetch: FakeProvider = echo, settings: dict[str, Any] | None = None, **extra: Any) -> TelegramBot:
        return TelegramBot(
            BotDeps(
                db=self.db,
                settings=settings_for(telegram_bot_token="t", telegram_chat_id="42", **(settings or {})),
                api=self.telegram.api,
                fetch_quotes=fake_fetcher(fetch),
                now=lambda: NOW,
                **extra,
            )
        )

    def last(self) -> str:
        return self.sent[-1] if self.sent else ""

    def last_params(self) -> dict[str, str]:
        return self.calls[-1][1] if self.calls else {}

    def monitors(self) -> list[dict[str, Any]]:
        return rows(self.db, "select * from monitors")


def update(text: str, chat_id: int | str = 42) -> dict[str, Any]:
    return {"update_id": 1, "message": {"chat": {"id": chat_id}, "text": text}}


@pytest.fixture
def chat(tmp_path):
    db = create_database(tmp_path / "test.db")
    yield Chat(db)
    db.close()


def counting(asked: list[list[str]]) -> FakeProvider:
    def fetch(codes: list[str]) -> list[dict[str, Any]]:
        asked.append(codes)
        return echo(codes)

    return fetch


def hold(chat: Chat, id_: str, name: str, entry: float, legs: list[dict[str, Any]], strategy: str = "credit_spread"):
    """A Position, inserted as POST /positions would have stored it."""
    chat.db.execute(
        "insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at) "
        "values (?, ?, ?, ?, 1, ?, ?, '2026-10-01 00:00:00.000000')",
        (id_, name, strategy, FUTURE, entry, to_sqlite_json(legs)),
    )


class TestWhoMayCommandIt:
    async def test_ignores_a_message_from_any_other_chat_without_replying(self, chat):
        # a reply would confirm the bot exists to whoever found it
        await chat.bot().handle_update(update("/monitors", 999))
        assert chat.sent == []

    async def test_ignores_a_message_with_no_text(self, chat):
        await chat.bot().handle_update({"update_id": 1, "message": {"chat": {"id": 42}}})
        assert chat.sent == []

    async def test_answers_anything_it_does_not_recognise_with_the_help(self, chat):
        b = chat.bot()
        await b.handle_update(update("hello there"))
        assert "/watch" in chat.last()
        await b.handle_update(update("/nonsense"))
        assert "/watch" in chat.last()

    async def test_takes_a_command_addressed_to_it_by_name_as_a_group_chat_sends_them(self, chat):
        await chat.bot().handle_update(update("/monitors@optionality_bot"))
        assert "empty" in chat.last()

    async def test_takes_a_capitalised_command_which_is_what_a_phone_keyboard_sends(self, chat):
        # dispatch has lower-cased the name since it was written and nothing asked it to: a mutation
        # sweep removing the `toLowerCase()` left all 82 tests passing. On iOS the first letter of a
        # message is autocapitalised, so `/Monitors` is what actually arrives — and without this it
        # answers the help text, which reads as the bot not knowing its own command.
        b = chat.bot()
        await b.handle_update(update("/Monitors"))
        assert "empty" in chat.last()
        await b.handle_update(update("/HEALTH"))
        assert "Service is up" in chat.last()


class TestWatch:
    async def test_creates_a_monitor_and_says_so_if_one_already_exists(self, chat):
        b = chat.bot()
        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.6"))
        assert "watching" in chat.last().lower()
        assert len(chat.monitors()) == 1
        assert chat.monitors()[0]["code"].endswith("C6500000")
        assert chat.monitors()[0]["threshold"] == 0.6

        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.7"))
        assert "already" in chat.last().lower()
        assert chat.monitors()[0]["threshold"] == 0.6

    async def test_does_not_ask_the_provider_about_a_rule_it_already_has(self, chat):
        # The two doors onto creation ran the same five steps in a different order: the route checked
        # uniqueness and then probed, the bot probed and then checked. So /watch on something already
        # watched spent a live Provider call to be told what the database already knew — and every
        # call to the Provider in this service is meant to be a bounded, deliberate one (CLAUDE.md's
        # invariants). Both doors go through create_monitor.py now, which puts the free check first.
        asked: list[list[str]] = []
        b = chat.bot(counting(asked))
        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.6"))
        assert len(asked) == 1, "creating one must still probe the contract"

        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.7"))

        assert "already" in chat.last().lower()
        assert len(asked) == 1, "the duplicate was sent to the Provider anyway"

    async def test_refuses_an_unusable_threshold_before_asking_the_provider_anything(self, chat):
        # the same rule one step earlier, and this one already held: a threshold the engine cannot
        # evaluate is a local fact, so the call is not worth making. Pinned here because the extraction
        # fixes ONE order for both doors, and this is half of what that order has to preserve.
        asked: list[list[str]] = []
        await chat.bot(counting(asked)).handle_update(update(f"/watchcombo ic {FUTURE} -C8100 +C8150 0 mid_price"))

        assert "threshold" in chat.last().lower()
        assert len(asked) == 0, "a local refusal still cost a Provider call"
        assert len(chat.monitors()) == 0

    async def test_normalises_a_compact_date(self, chat):
        await chat.bot().handle_update(update(f"/watch {FUTURE.replace('-', '')} CALL 6500 0.6"))
        assert chat.monitors()[0]["strike_date"] == FUTURE

    async def test_takes_a_field_a_direction_and_the_signed_keyword_in_any_order(self, chat):
        b = chat.bot()
        await b.handle_update(update(f"/watch {FUTURE} CALL 8100 30 mid_price below"))
        assert "≤" in chat.last()
        assert chat.monitors()[0]["direction"] == "below"
        assert chat.monitors()[0]["field"] == "mid_price"

        await b.handle_update(update("/monitors"))
        assert "≤30.0" in chat.last()  # the threshold cell carries the direction

    async def test_replies_with_usage_for_anything_it_cannot_read(self, chat):
        b = chat.bot()
        for text in [
            "/watch nope",
            "/watch",
            f"/watch {FUTURE} SIDEWAYS 6500 0.6",
            f"/watch {FUTURE} CALL six 0.6",
            f"/watch {FUTURE} CALL 6500 lots",
            "/watch 18-12-2026 CALL 6500 0.6",
        ]:
            await b.handle_update(update(text))
            assert "usage" in chat.last().lower(), text
        assert chat.monitors() == []

    async def test_refuses_a_contract_moomoo_does_not_have_and_creates_nothing(self, chat):
        def poison(codes: list[str]) -> Batch:
            return Batch(records=[], unknown=list(codes))

        await chat.bot(poison).handle_update(update(f"/watch {FUTURE} CALL 99999 0.5"))
        assert "does not exist" in chat.last()
        assert chat.monitors() == []

    async def test_names_the_field_before_the_threshold_when_both_are_wrong(self, chat):
        # the same precedence as the route's (test_monitors.py), which is the point: this door used to
        # answer the threshold first, so the same mistake got two different replies.
        await chat.bot().handle_update(update(f"/watchcombo iv {FUTURE} -C8100 +C8150 -1 option_implied_volatility"))
        assert "not additive" in chat.last()
        assert chat.monitors() == []

    async def test_refuses_a_non_positive_threshold_with_the_advice_that_fixes_it(self, chat):
        b = chat.bot()
        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 -0.5"))
        assert "positive" in chat.last().lower()
        assert "signed" in chat.last()  # the wording tells you what to add
        assert chat.monitors() == []


def prices(values: dict[str, float]) -> FakeProvider:
    return lambda codes: [{"code": c, "mid_price": values[c]} for c in codes if c in values]


class TestWatchcombo:
    async def test_creates_a_combo_and_shows_its_per_leg_breakdown(self, chat):
        a = build_spx_code(FUTURE, "CALL", 8100)
        c = build_spx_code(FUTURE, "CALL", 8150)
        b = chat.bot(prices({a: 26.4, c: 19.25}))

        await b.handle_update(update(f"/watchcombo sep-condor {FUTURE} +C8100 -C8150 10 below"))
        assert "sep-condor" in chat.last()
        assert "≤" in chat.last()
        m = chat.monitors()[0]
        assert m["code"] == "sep-condor"
        assert m["field"] == "mid_price"  # the combo default
        assert m["direction"] == "below"
        assert [leg["sign"] for leg in json.loads(m["legs"])] == [1, -1]

        await b.handle_update(update("/combo sep-condor"))
        reply = chat.last()
        assert reply.startswith("<pre>")
        assert "26.4" in reply
        assert "19.25" in reply
        assert "total" in reply
        assert "7.15" in reply  # 26.4 − 19.25

        await b.handle_update(update("/monitors"))
        assert "sep-condor" in chat.last()

        await b.handle_update(update("/unwatch sep-condor"))
        assert "removed" in chat.last().lower()
        assert chat.monitors() == []

    async def test_needs_two_legs_to_be_a_combo(self, chat):
        b = chat.bot()
        # four arguments is caught by the arity guard before the legs are even counted
        await b.handle_update(update(f"/watchcombo broken {FUTURE} +C8100 10"))
        assert "usage" in chat.last().lower()
        # five, with one leg, is what reaches the leg count — a one-leg "combo" is a single-leg monitor
        # wearing a name, and its signed sum would be the leg itself
        await b.handle_update(update(f"/watchcombo broken {FUTURE} +C8100 10 mid_price"))
        assert "usage" in chat.last().lower()
        assert chat.monitors() == []

    async def test_takes_the_signed_keyword_and_a_negative_threshold_with_it(self, chat):
        b = chat.bot()
        await b.handle_update(update(f"/watchcombo bear-cs {FUTURE} -C8100 +C8150 -4.05 signed below"))
        assert "-4.05" in chat.last()
        m = chat.monitors()[0]
        assert m["compare"] == "signed"
        assert m["threshold"] == -4.05
        assert m["direction"] == "below"

    async def test_refuses_a_negative_threshold_without_it(self, chat):
        b = chat.bot()
        await b.handle_update(update(f"/watchcombo x {FUTURE} +C8100 -C8150 -4.05"))
        assert "positive" in chat.last().lower()
        assert chat.monitors() == []

    async def test_refuses_implied_volatility_because_it_does_not_add(self, chat):
        b = chat.bot()
        await b.handle_update(update(f"/watchcombo iv-x {FUTURE} +C8100 +C8150 10 option_implied_volatility"))
        assert "option_implied_volatility" in chat.last()
        assert "not additive" in chat.last()
        assert chat.monitors() == []

    async def test_shows_an_incomplete_total_rather_than_a_part_sum(self, chat):
        # no partial sums, ever: a combo missing a leg has no value, and 26.4 alone is not one.
        # Both legs must exist at creation — the gate demands it — so one is dropped afterwards.
        a = build_spx_code(FUTURE, "CALL", 8100)
        c = build_spx_code(FUTURE, "CALL", 8150)
        complete = [True]
        b = chat.bot(
            lambda codes: [{"code": x, "mid_price": 26.4 if x == a else 19.25} for x in codes if complete[0] or x != c]
        )
        await b.handle_update(update(f"/watchcombo half {FUTURE} +C8100 -C8150 10 below"))
        assert "watching" in chat.last().lower()
        complete[0] = False
        await b.handle_update(update("/combo half"))
        assert "incomplete" in chat.last()
        assert "26.4" in chat.last()  # the priced leg still shows; only the total refuses
        assert "—" in chat.last()  # and the missing one says so

    async def test_says_so_for_a_combo_that_does_not_exist(self, chat):
        await chat.bot().handle_update(update("/combo ghost"))
        assert chat.last() == "No combo named 'ghost'."


class TestMonitors:
    async def test_is_a_table_parsed_as_html_with_short_contract_labels(self, chat):
        b = chat.bot()
        await b.handle_update(update("/monitors"))
        assert "empty" in chat.last().lower()

        await b.handle_update(update(f"/watch {FUTURE} PUT 6425 0.5"))
        await b.handle_update(update("/monitors"))
        reply = chat.last()
        assert reply.startswith("<pre>")
        assert reply.endswith("</pre>")
        assert f"{YYMMDD} P6425" in reply  # not the full moomoo code
        assert "armed" in reply
        assert chat.last_params()["parse_mode"] == "HTML"

    async def test_groups_by_expiry_then_calls_before_puts(self, chat):
        # so a condor's legs stay together instead of splitting across CALL and PUT blocks
        b = chat.bot()
        await b.handle_update(update(f"/watch {FUTURE} PUT 6425 0.5"))
        await b.handle_update(update(f"/watch {FAR} CALL 8100 0.6"))
        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.6"))
        await b.handle_update(update("/monitors"))
        reply = chat.last()
        assert reply.index("C6500") < reply.index("P6425")
        assert reply.index("P6425") < reply.index("C8100")

    async def test_shows_the_bell_and_that_a_disabled_monitor_is_off(self, chat):
        b = chat.bot()
        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.6"))
        id_ = chat.monitors()[0]["id"]
        chat.db.execute("update monitors set triggered = 1, last_value = 0.7123 where id = ?", (id_,))
        await b.handle_update(update("/monitors"))
        assert "🔔" in chat.last()
        assert "0.712" in chat.last()  # three places for a delta

        chat.db.execute("update monitors set enabled = 0 where id = ?", (id_,))
        await b.handle_update(update("/monitors"))
        assert "off" in chat.last()

    async def test_shows_four_places_for_a_field_with_no_format_of_its_own(self, chat):
        b = chat.bot()
        await b.handle_update(update(f"/watch {FUTURE} CALL 8100 30 mid_price"))
        chat.db.execute("update monitors set last_value = 26.41235")
        await b.handle_update(update("/monitors"))
        # four places, rounded on the stored double exactly as JavaScript's .toFixed(4) does
        assert "26.4123" in chat.last()

    async def test_shows_an_em_dash_for_a_monitor_that_has_never_been_swept(self, chat):
        b = chat.bot()
        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.6"))
        await b.handle_update(update("/monitors"))
        assert "—" in chat.last()


def held_since_opened(chat: Chat, id_: str, name: str) -> None:
    """A one-leg credit of 2.00, Opened at 45 DTE, as the TypeScript's `/holdings` tests insert it."""
    chat.db.execute(
        "insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at, opened_at, "
        "manage_notified_at) values (?, ?, null, ?, 1, 2.0, ?, '2026-08-01 00:00:00.000000', ?, null)",
        (id_, name, FUTURE, to_sqlite_json([{"side": "short", "option_type": "CALL", "strike": 8100}]), OPENED),
    )


def quoting_all(fields: dict[str, Any]) -> FakeProvider:
    return lambda codes: [{"code": c, **fields} for c in codes]


class TestTheLiveTables:
    async def test_quotes_is_a_pure_price_view(self, chat):
        b = chat.bot(
            quoting_all({"name": "NAME", "option_delta": 0.42, "bid_price": 1.0, "ask_price": 2.0, "mid_price": 1.5})
        )
        await b.handle_update(update("/quotes"))
        assert "empty" in chat.last().lower()

        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.6"))
        await b.handle_update(update("/quotes"))
        reply = chat.last()
        assert reply.startswith("<pre>")
        assert f"{YYMMDD} C6500" in reply
        assert "1.5" in reply
        assert "1.0/2.0" in reply  # Python's str(1.0), not "1"
        assert "0.42" not in reply  # delta lives in /greeks
        assert chat.last_params()["parse_mode"] == "HTML"

    async def test_greeks_shows_delta_gamma_and_theta_at_the_places_each_needs(self, chat):
        b = chat.bot(
            quoting_all(
                {
                    "option_delta": 0.166096,
                    "option_gamma": 0.000124194,
                    "option_theta": -1.117809,
                    "option_implied_volatility": 22.012,
                }
            )
        )
        await b.handle_update(update("/greeks"))
        assert "empty" in chat.last().lower()

        await b.handle_update(update(f"/watch {FUTURE} CALL 8100 0.6"))
        await b.handle_update(update("/greeks"))
        reply = chat.last()
        assert "0.166" in reply  # delta, three places
        assert "0.00012" in reply  # gamma, five — three would show every gamma as 0.000
        assert "-1.12" in reply  # theta, two
        assert "22.012" not in reply  # IV moved to /vol
        assert chat.last_params()["parse_mode"] == "HTML"

    async def test_vol_shows_iv_and_vega(self, chat):
        b = chat.bot(quoting_all({"option_implied_volatility": 22.012345, "option_vega": 5.89497}))
        await b.handle_update(update("/vol"))
        assert "empty" in chat.last().lower()

        await b.handle_update(update(f"/watch {FUTURE} CALL 8100 0.6"))
        await b.handle_update(update("/vol"))
        assert "22.012" in chat.last()
        assert "22.012345" not in chat.last()
        assert "5.89" in chat.last()

    async def test_holdings_says_where_each_position_stands_which_no_other_command_can(self, chat):
        # thirteen commands and every one about rules: there was no way to ask Telegram about the thing
        # with money in it. The figures come from holdings.py, the same function the dashboard's
        # /positions/values asks — not a second definition of cost, P&L and the schedule.
        b = chat.bot(quoting_all({"mid_price": 1.5, "option_contract_size": 100}))
        await b.handle_update(update("/holdings"))
        assert "no holdings" in chat.last().lower(), "and it says so rather than printing an empty table"

        held_since_opened(chat, "p" * 32, "spread")

        await b.handle_update(update("/holdings"))
        reply = chat.last()
        assert reply.startswith("<pre>"), "a table reply is <pre> + HTML"
        assert chat.last_params()["parse_mode"] == "HTML"
        assert "spread" in reply
        assert "1.50" in reply  # cost to close, from the mid
        assert "50" in reply  # P&L: (2.00 - 1.50) x 100
        assert len(reply.split("\n")[0]) <= 40, "four columns inside forty characters"

    async def test_holdings_says_a_pace_gap_in_words_never_as_a_bare_sign(self, chat):
        # CONTEXT.md's Pace gap entry: said in words wherever it is shown, "because 'behind' is bad while
        # a positive P&L is good and a bare sign beside one invites reading the other". A mutation sweep
        # found this: swapping the words for a signed number broke nothing at all.
        b = chat.bot(quoting_all({"mid_price": 1.8, "option_contract_size": 100}))
        held_since_opened(chat, "r" * 32, "pacer")

        await b.handle_update(update("/holdings"))
        # opened at 45 DTE, now 30: on-pace is 2.00 x sqrt(30/45) = 1.63, and 1.80 costs more. The word
        # and the figure asserted TOGETHER: the holding was first named "behindOne", so "behind" appeared
        # in the name column and the assertion could not fail.
        assert "behind 0.17" in chat.last()

    async def test_holdings_names_a_level_it_has_reached_in_place_of_the_pace(self, chat):
        # a Target is reached or not reached (CONTEXT.md: Level), and reaching one is the thing worth
        # saying — the pace gap is what it says when no Level has been
        b = chat.bot(quoting_all({"mid_price": 0.5, "option_contract_size": 100}))
        held_since_opened(chat, "q" * 32, "atTarget")

        await b.handle_update(update("/holdings"))
        # 0.50 is exactly half of a 2.00 credit, which is the Target
        assert "TARGET" in chat.last()

    async def test_shows_an_em_dash_per_missing_field_rather_than_failing_the_table(self, chat):
        b = chat.bot(quoting_all({}))
        await b.handle_update(update(f"/watch {FUTURE} CALL 8100 0.6"))
        for command in ["/quotes", "/greeks", "/vol"]:
            await b.handle_update(update(command))
            assert "—" in chat.last(), command
            assert chat.last().startswith("<pre>"), command

    async def test_says_what_failed_when_opend_does_rather_than_nothing(self, chat):
        def down(codes: list[str]) -> list[dict[str, Any]]:
            raise RuntimeError("Client connection failed!")

        b = chat.bot(down)
        await b.handle_update(update(f"/watch {FUTURE} CALL 8100 0.6"))  # refused, but try anyway
        chat.db.execute(
            "insert into monitors (id, code, strike_date, option_type, strike, field, threshold, direction, "
            "compare, enabled, triggered, created_at) values ('m', 'US.SPXW261101C8100000', ?, 'CALL', 8100, "
            "'option_delta', 0.6, 'above', 'abs', 1, 0, '2026-10-01 00:00:00.000000')",
            (FUTURE,),
        )
        for command, label in [("/quotes", "Quotes"), ("/greeks", "Greeks"), ("/vol", "Vol")]:
            await b.handle_update(update(command))
            assert chat.last() == f"{label} failed: Client connection failed!", command
            assert "parse_mode" not in chat.last_params(), command  # a plain reply, not HTML


class TestThreshold:
    async def test_finds_a_monitor_by_combo_name_or_by_short_contract(self, chat):
        b = chat.bot()
        await b.handle_update(update(f"/watchcombo sep-condor {FUTURE} +C8100 -C8150 10 below"))
        await b.handle_update(update("/threshold sep-condor 25"))
        assert "25" in chat.last()
        assert next(m for m in chat.monitors() if m["code"] == "sep-condor")["threshold"] == 25

        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.6"))
        await b.handle_update(update(f"/threshold {YYMMDD} C6500 0.5"))
        assert "0.5" in chat.last()
        assert next(m for m in chat.monitors() if m["code"] != "sep-condor")["threshold"] == 0.5

    async def test_says_so_when_nothing_matches_and_refuses_a_value_it_cannot_read(self, chat):
        b = chat.bot()
        await b.handle_update(update("/threshold ghost 1"))
        assert "no monitor" in chat.last().lower()
        await b.handle_update(update("/threshold ghost lots"))
        assert "usage" in chat.last().lower()
        await b.handle_update(update("/threshold"))
        assert "usage" in chat.last().lower()

    async def test_refuses_zero_for_a_signed_monitor_and_leaves_it_unchanged(self, chat):
        b = chat.bot()
        await b.handle_update(update(f"/watchcombo bear-cs {FUTURE} -C8100 +C8150 -4.05 signed below"))
        await b.handle_update(update("/threshold bear-cs -5"))
        assert chat.monitors()[0]["threshold"] == -5
        await b.handle_update(update("/threshold bear-cs 0"))
        assert "signed" in chat.last().lower()
        assert chat.monitors()[0]["threshold"] == -5

    async def test_refuses_a_non_positive_value_for_an_abs_monitor_and_leaves_it_unchanged(self, chat):
        b = chat.bot()
        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.6"))
        await b.handle_update(update(f"/threshold {YYMMDD} C6500 0"))
        assert "positive" in chat.last().lower()
        assert chat.monitors()[0]["threshold"] == 0.6

    async def test_refuses_to_guess_between_two_matches(self, chat):
        b = chat.bot()
        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.6"))
        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.7 mid_price"))
        await b.handle_update(update(f"/threshold {YYMMDD} C6500 0.5"))
        assert "Ambiguous" in chat.last()
        assert sorted(m["threshold"] for m in chat.monitors()) == [0.6, 0.7]


class TestRename:
    async def test_renames_a_combo_and_keeps_its_state(self, chat):
        b = chat.bot()
        await b.handle_update(update(f"/watchcombo old-name {FUTURE} +C8100 -C8150 10 below"))
        id_ = chat.monitors()[0]["id"]
        chat.db.execute("update monitors set triggered = 1, last_value = 7.15 where id = ?", (id_,))

        await b.handle_update(update("/rename old-name new-name"))
        assert "new-name" in chat.last()
        m = row(chat.db, "select * from monitors where id = ?", id_)
        assert m is not None
        assert m["code"] == "new-name"
        assert m["triggered"] == 1  # recreating it would have lost this
        assert m["last_value"] == 7.15

    async def test_refuses_a_name_already_taken_a_combo_that_is_not_there_and_bad_arguments(self, chat):
        b = chat.bot()
        await b.handle_update(update(f"/watchcombo a {FUTURE} +C8100 -C8150 10 below"))
        await b.handle_update(update(f"/watchcombo c {FUTURE} +C8200 -C8250 10 below"))
        await b.handle_update(update("/rename c a"))
        assert chat.last() == "'a' is already taken."
        await b.handle_update(update("/rename ghost whatever"))
        assert "no combo" in chat.last().lower()
        await b.handle_update(update("/rename only-one"))
        assert "usage" in chat.last().lower()

    async def test_refuses_a_single_leg_monitor_whose_code_is_its_contract(self, chat):
        b = chat.bot()
        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.6"))
        code = chat.monitors()[0]["code"]
        await b.handle_update(update(f"/rename {code} something"))
        assert "no combo" in chat.last().lower()


class TestUnwatch:
    async def test_finds_a_monitor_by_short_label_full_code_or_id_prefix(self, chat):
        b = chat.bot()
        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.6"))
        await b.handle_update(update(f"/unwatch {YYMMDD} C6500"))
        assert "removed" in chat.last().lower()
        assert chat.monitors() == []

        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.6"))
        code = chat.monitors()[0]["code"]
        await b.handle_update(update(f"/unwatch {code}"))
        assert chat.monitors() == []

        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.6"))
        await b.handle_update(update(f"/unwatch {chat.monitors()[0]['id'][:8]}"))
        assert chat.monitors() == []

    async def test_says_so_when_nothing_matches_and_refuses_to_guess_between_two(self, chat):
        b = chat.bot()
        await b.handle_update(update("/unwatch nothere"))
        assert "no monitor" in chat.last().lower()
        await b.handle_update(update("/unwatch"))
        assert "usage" in chat.last().lower()

        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.6"))
        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.7 mid_price"))
        await b.handle_update(update(f"/unwatch {YYMMDD} C6500"))
        assert "Ambiguous" in chat.last()
        assert len(chat.monitors()) == 2

    async def test_takes_the_position_links_with_it_and_leaves_the_position(self, chat):
        # the links go first or the foreign key refuses the delete, and every monitor in the live
        # database is linked (#70). A Position is a holding — it exists whether or not anything watches it.
        b = chat.bot()
        hold(chat, "p" * 32, "held", 2.0, [{"side": "short", "option_type": "CALL", "strike": 6500}])
        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.6"))
        id_ = chat.monitors()[0]["id"]
        assert row(chat.db, "select count(*) n from monitor_positions") == {"n": 1}

        await b.handle_update(update(f"/unwatch {id_[:8]}"))
        assert "removed" in chat.last().lower()
        assert row(chat.db, "select count(*) n from monitor_positions") == {"n": 0}
        assert row(chat.db, "select name from positions") == {"name": "held"}


class TestLinkingWhichThePythonsBotDoesNotDo:
    async def test_attaches_a_monitor_created_from_the_phone_to_the_position_holding_its_contract(self, chat):
        # The old Python's /watch wrote the Monitor and nothing else, so a monitor created from the phone
        # had no entry and no P&L while the same monitor created from the dashboard had both. The linkage
        # is a lookup rather than a guess (see positions_holding), so there is no reason the two doors
        # should differ. A deliberate correction, recorded in ADR 0009.
        b = chat.bot()
        hold(
            chat,
            "p" * 32,
            "spread",
            2.5,
            [
                {"side": "short", "option_type": "CALL", "strike": 8100},
                {"side": "long", "option_type": "CALL", "strike": 8150},
            ],
        )

        await b.handle_update(update(f"/watchcombo spread {FUTURE} +C8100 -C8150 10 below"))
        assert row(chat.db, "select scope from monitors") == {"scope": "all"}  # the rule covers the holding exactly
        assert row(chat.db, "select count(*) n from monitor_positions") == {"n": 1}

    async def test_links_nothing_when_no_position_holds_the_contract(self, chat):
        b = chat.bot()
        await b.handle_update(update(f"/watch {FUTURE} CALL 6500 0.6"))
        assert row(chat.db, "select count(*) n from monitor_positions") == {"n": 0}
        assert row(chat.db, "select scope from monitors") == {"scope": None}


class TestSnapshot:
    async def test_shows_the_fields_that_matter_at_the_places_they_deserve(self, chat):
        b = chat.bot(
            lambda codes: [
                {
                    "code": codes[0],
                    "name": "SPXW TEST",
                    "option_delta": 0.512345,
                    "option_implied_volatility": 21.45678,
                    "bid_price": 1.0,
                    "ask_price": 2.0,
                }
            ]
        )
        await b.handle_update(update(f"/snapshot {FUTURE} CALL 6500"))
        reply = chat.last()
        assert reply.startswith("SPXW TEST\n")
        assert "option_delta: 0.512" in reply
        assert "0.512345" not in reply
        assert "option_implied_volatility: 21.457" in reply
        assert "21.45678" not in reply
        assert "bid_price: 1.0" in reply  # Python's str(1.0)
        assert "parse_mode" not in chat.last_params()

    async def test_says_so_when_there_is_no_data_and_when_the_arguments_are_wrong(self, chat):
        b = chat.bot(lambda codes: [])
        await b.handle_update(update(f"/snapshot {FUTURE} CALL 6500"))
        assert chat.last().startswith("No data for US.SPXW")
        for text in ["/snapshot", f"/snapshot {FUTURE} SIDEWAYS 6500", "/snapshot 18-12-2026 CALL 6500"]:
            await b.handle_update(update(text))
            assert "usage" in chat.last().lower(), text

    async def test_says_what_failed_when_opend_does(self, chat):
        def down(codes: list[str]) -> list[dict[str, Any]]:
            raise RuntimeError("Client connection failed!")

        await chat.bot(down).handle_update(update(f"/snapshot {FUTURE} CALL 6500"))
        assert chat.last() == "Snapshot failed: Client connection failed!"


class TestHealth:
    async def test_reports_the_sweep_in_the_display_zone(self, chat):
        sweeper = FakeSweeper()
        sweeper.sweep_at = datetime(2026, 8, 10, 3, 35, tzinfo=UTC)
        sweeper.label = "active"
        b = chat.bot(echo, {"display_tz": "Asia/Singapore"}, sweeper=sweeper)
        await b.handle_update(update("/health"))
        assert chat.last() == "Service is up.\nalarms: active — last sweep 2026-08-10 11:35 +08"

    async def test_says_only_that_it_is_up_when_nothing_else_is_wired(self, chat):
        await chat.bot().handle_update(update("/health"))
        assert chat.last() == "Service is up."

    async def test_leaves_out_the_sweep_time_before_the_first_sweep(self, chat):
        sweeper = FakeSweeper()
        sweeper.label = "starting"
        b = chat.bot(echo, {}, sweeper=sweeper)
        await b.handle_update(update("/health"))
        assert chat.last() == "Service is up.\nalarms: starting"


class TestHelp:
    async def test_is_plain_text_never_parsed_as_html(self, chat):
        # a plain reply containing "<0.6" would lose it to a tag
        await chat.bot().handle_update(update("/help"))
        assert "parse_mode" not in chat.last_params()
        assert "/watchcombo" in chat.last()


class TestTheCommandMenu:
    async def test_publishes_every_command_each_with_a_description(self, chat):
        await chat.bot().start()
        call = next(params for method, params in chat.calls if method == "setMyCommands")
        published = json.loads(call["commands"])
        assert [c["command"] for c in published] == [
            # holdings leads: it is the only one about the thing with money in it, and every other
            # command here is about a rule
            "holdings",
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
        assert all(len(c["description"]) > 0 for c in published)

    async def test_drains_the_backlog_so_a_restart_does_not_replay_old_commands(self, chat):
        # an /unwatch sent while the service was down would otherwise be obeyed as if it were new
        async def api(method: str, params: dict[str, str]) -> Any:
            chat.calls.append((method, params))
            if method == "getUpdates" and params["offset"] == "-1":
                return [{"update_id": 77}]
            return []

        b = TelegramBot(
            BotDeps(
                db=chat.db,
                settings=settings_for(telegram_bot_token="t", telegram_chat_id="42"),
                api=api,
                fetch_quotes=fake_fetcher(echo),
                now=lambda: NOW,
            )
        )
        await b.start()
        assert b.next_offset() == 78  # one past the drained update

    async def test_starts_from_nothing_when_there_is_no_backlog(self, chat):
        b = chat.bot()
        await b.start()
        assert b.next_offset() == 0

    async def test_starts_anyway_when_the_menu_or_the_drain_fails(self, chat):
        # neither is worth refusing to run for: the owner can still type a command they remember
        async def api(method: str, params: dict[str, str]) -> Any:
            raise RuntimeError("telegram is down")

        b = TelegramBot(
            BotDeps(
                db=chat.db,
                settings=settings_for(telegram_bot_token="t", telegram_chat_id="42"),
                api=api,
                fetch_quotes=fake_fetcher(echo),
                now=lambda: NOW,
            )
        )
        assert await b.start() is None


class TestWhatOnlyThePythonCanGetWrong:
    async def test_publishes_the_menu_as_json_stringify_writes_it(self, chat):
        # compact, and the minus sign in /watchcombo's description as itself rather than −: the
        # menu is a form field Telegram parses, and the TypeScript sends exactly this text
        await chat.bot().start()
        call = next(params for method, params in chat.calls if method == "setMyCommands")
        assert call["commands"].startswith('[{"command":"holdings","description":"Where each Position stands')
        assert "−short +long" in call["commands"]

    async def test_reads_a_chat_id_as_javascript_s_string_does(self, chat):
        # Telegram sends the id as a JSON number; `String(42)` is "42", and so is the configured one
        await chat.bot().handle_update(update("/monitors", 42.0))
        assert "empty" in chat.last()

    async def test_splits_and_trims_on_what_javascript_calls_whitespace(self, chat):
        # a no-break space separates words for `/\s+/` and Python's `split()` alike, but \x1c separates
        # them only for Python, and the BOM is trimmed only by JavaScript
        b = chat.bot()
        await b.handle_update(update("﻿/watch " + f"{FUTURE} CALL 6500 0.6"))
        assert chat.last().startswith("Watching US.SPXW261101C6500000")
        await b.handle_update(update(f"/unwatch {YYMMDD}\x1cC6500"))
        assert chat.last() == f"No monitor matches '{YYMMDD}\x1cC6500'."
        assert len(chat.monitors()) == 1

    async def test_writes_a_holding_s_cost_and_p_and_l_as_to_fixed_and_math_round_write_them(self, chat):
        # 2.125 and 12.5 are exact ties: `toFixed` and `Math.round` take them up, where Python's format
        # and `round` take them to even — "2.12" and 12 — and `str` of a float would say "12.0"
        hold(chat, "t" * 32, "tie", 2.25, [{"side": "short", "option_type": "CALL", "strike": 8100}])
        await chat.bot(quoting_all({"mid_price": 2.125, "option_contract_size": 100})).handle_update(
            update("/holdings")
        )
        assert chat.last() == "<pre>holding  cost  P&amp;L  note\ntie      2.13  13       —</pre>"

    async def test_runs_until_stopped_answering_each_update_once_and_moving_past_it(self, chat):
        b: TelegramBot

        async def api(method: str, params: dict[str, str]) -> Any:
            chat.calls.append((method, params))
            if method == "getUpdates":
                if params["offset"] == "0":
                    return [update("/monitors") | {"update_id": 5}]
                b.stop()
                return []
            chat.sent.append(params["text"])
            return {}

        b = TelegramBot(
            BotDeps(
                db=chat.db,
                settings=settings_for(telegram_bot_token="t", telegram_chat_id="42"),
                api=api,
                fetch_quotes=fake_fetcher(echo),
                now=lambda: NOW,
            )
        )
        await b.run()
        assert [p["offset"] for m, p in chat.calls if m == "getUpdates"] == ["0", "6"]
        assert [p["timeout"] for m, p in chat.calls if m == "getUpdates"] == ["25", "25"]
        assert chat.sent == ["Watchlist is empty. Add one with /watch."]
        assert b.next_offset() == 6

    async def test_logs_an_update_it_could_not_answer_and_goes_on_to_the_next(self, chat, caplog):
        # `catch (err)` is `except Exception`: a reply Telegram refused is logged with its stack, and the
        # loop reads on rather than dying with the owner's next command unread
        b: TelegramBot
        polls = []

        async def api(method: str, params: dict[str, str]) -> Any:
            if method == "getUpdates":
                polls.append(params["offset"])
                if len(polls) == 1:
                    return [update("/monitors") | {"update_id": 9}, update("/monitors") | {"update_id": 10}]
                b.stop()
                return []
            raise RuntimeError("telegram sendMessage failed: {}")

        b = TelegramBot(
            BotDeps(
                db=chat.db,
                settings=settings_for(telegram_bot_token="t", telegram_chat_id="42"),
                api=api,
                fetch_quotes=fake_fetcher(echo),
                now=lambda: NOW,
            )
        )
        with caplog.at_level(logging.ERROR):
            await b.run()
        assert polls == ["0", "11"]
        failures = [r for r in caplog.records if r.getMessage().startswith("failed handling telegram update")]
        assert [r.getMessage() for r in failures] == [
            "failed handling telegram update 9:",
            "failed handling telegram update 10:",
        ]
        assert all(r.exc_info for r in failures)
