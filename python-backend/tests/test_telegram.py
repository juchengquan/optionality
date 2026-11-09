"""Sending to Telegram, over a fake transport.

backend/src/telegram.ts has no test of its own: the TypeScript's callers fake what sits ABOVE it —
a `send` into the notifier, an `api` into the bot — so the one module that speaks HTTP is exercised
only live. These run it against `httpx2.MockTransport`, so no test reaches api.telegram.org; the
token allows ONE getUpdates consumer (CLAUDE.md), and a suite must never be a second.

What they hold is what the callers rely on: the request Telegram is sent, a refusal raised with
Telegram's own words, a sender that refuses unconfigured credentials without asking, and the two
deadlines — the second of which guards a hazard only Python has (`TestTelegramApi`).
"""

import asyncio
from urllib.parse import parse_qs

import httpx2
import pytest

from optionality_backend import telegram
from optionality_backend.telegram import TelegramConfig, send_message, telegram_api, telegram_sender

OK = {"ok": True, "result": {"message_id": 7}}
REFUSED = {"ok": False, "error_code": 400, "description": "Bad Request: chat not found"}


class Telegram:
    """A fake api.telegram.org: answers every request with `reply`, and keeps what it was asked."""

    def __init__(self, reply: object = OK, delay: float = 0):
        self.reply = reply
        self.delay = delay
        self.requests: list[httpx2.Request] = []
        self.transport = httpx2.MockTransport(self.handle)

    async def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if self.delay:
            await asyncio.sleep(self.delay)
        return httpx2.Response(200, json=self.reply)

    def form(self, i: int = 0) -> dict[str, list[str]]:
        return parse_qs(self.requests[i].content.decode())


class TestSendMessage:
    async def test_posts_the_chat_and_the_text_as_a_form_to_the_bots_send_message(self):
        api = Telegram()
        await send_message(TelegramConfig(token="t0k", chat_id="42"), "8100C > 0.30 & rising", transport=api.transport)
        (request,) = api.requests
        assert request.method == "POST"
        assert str(request.url) == "https://api.telegram.org/bott0k/sendMessage"
        assert request.headers["content-type"].startswith("application/x-www-form-urlencoded")
        assert api.form() == {"chat_id": ["42"], "text": ["8100C > 0.30 & rising"]}

    async def test_names_a_parse_mode_only_when_asked_for_one(self):
        # `<pre>` with HTML parse mode, only for table replies (CLAUDE.md)
        api = Telegram()
        await send_message(
            TelegramConfig(token="t", chat_id="42", parse_mode="HTML"), "<pre>x</pre>", transport=api.transport
        )
        assert api.form()["parse_mode"] == ["HTML"]

    async def test_throws_on_a_refusal_in_telegrams_own_words(self):
        # JSON.stringify's spelling, with no spaces, so the log line is the TypeScript's to the byte
        api = Telegram(REFUSED)
        with pytest.raises(RuntimeError) as refused:
            await send_message(TelegramConfig(token="t", chat_id="42"), "hello", transport=api.transport)
        assert str(refused.value) == (
            'telegram sendMessage failed: {"ok":false,"error_code":400,"description":"Bad Request: chat not found"}'
        )

    async def test_throws_on_an_answer_that_does_not_say_ok(self):
        for reply in [{}, {"ok": None}, [], "ok"]:
            with pytest.raises(RuntimeError, match="telegram sendMessage failed"):
                await send_message(
                    TelegramConfig(token="t", chat_id="42"), "hello", transport=Telegram(reply).transport
                )

    async def test_gives_up_at_its_deadline(self, monkeypatch):
        # ten seconds in the service; shortened here so the test does not wait for them
        monkeypatch.setattr(telegram, "_SEND_TIMEOUT", 0.05)
        with pytest.raises(TimeoutError):
            await send_message(TelegramConfig(token="t", chat_id="42"), "hello", transport=Telegram(delay=1).transport)


class TestTelegramSender:
    async def test_sends_with_the_credentials_it_was_bound_to(self):
        api = Telegram()
        await telegram_sender("t0k", "42", transport=api.transport)("hello")
        assert str(api.requests[0].url) == "https://api.telegram.org/bott0k/sendMessage"
        assert api.form() == {"chat_id": ["42"], "text": ["hello"]}

    async def test_refuses_when_not_configured_without_asking_telegram(self):
        for token, chat in [("", "42"), ("t", ""), ("", "")]:
            api = Telegram()
            with pytest.raises(RuntimeError, match="telegram is not configured"):
                await telegram_sender(token, chat, transport=api.transport)("hello")
            assert api.requests == [], (token, chat)


class TestTelegramApi:
    async def test_calls_the_named_method_with_its_params_and_answers_the_result(self):
        api = Telegram({"ok": True, "result": [{"update_id": 1}]})
        call = telegram_api("t0k", transport=api.transport)
        assert await call("getUpdates", {"offset": "5", "timeout": "25"}) == [{"update_id": 1}]
        assert str(api.requests[0].url) == "https://api.telegram.org/bott0k/getUpdates"
        assert api.form() == {"offset": ["5"], "timeout": ["25"]}

    async def test_answers_null_when_telegram_says_ok_with_no_result(self):
        assert await telegram_api("t", transport=Telegram({"ok": True}).transport)("deleteWebhook", {}) is None

    async def test_throws_on_a_refusal_naming_the_method(self):
        with pytest.raises(RuntimeError) as refused:
            await telegram_api("t", transport=Telegram(REFUSED).transport)("getUpdates", {})
        assert str(refused.value).startswith('telegram getUpdates failed: {"ok":false,')

    async def test_leaves_the_long_poll_to_its_own_deadline(self):
        # Python's own hazard. getUpdates is asked to wait 25 seconds, and httpx2 gives every client a
        # FIVE-second read timeout unless told otherwise — so a port that kept the default would
        # abort every healthy poll that found nothing to say. The deadline is the whole exchange's,
        # as AbortSignal.timeout's is, so the client's own per-phase timeouts are switched off.
        api = Telegram()
        await telegram_api("t", transport=api.transport)("getUpdates", {"timeout": "25"})
        assert api.requests[0].extensions["timeout"] == {"connect": None, "read": None, "write": None, "pool": None}
        assert telegram._API_TIMEOUT > 25

    async def test_gives_up_at_its_deadline(self, monkeypatch):
        monkeypatch.setattr(telegram, "_API_TIMEOUT", 0.05)
        with pytest.raises(TimeoutError):
            await telegram_api("t", transport=Telegram(delay=1).transport)("getUpdates", {})
