"""Telling the owner, and saying whether it got through.

backend/src/notify.ts has no test of its own. Its callers' tests lean on four things it promises,
and these hold them: the sweep's "says nothing at all when telegram is not configured" and "survives
a sender that throws", and the positions suite's "stamps the deadline when telegram is not
configured" — which needs unconfigured to count as DELIVERED — and its send that throws, which needs
the answer False. The last test is the Python's own.
"""

import asyncio
from types import SimpleNamespace

import pytest

from optionality_backend.notify import notifier

CONFIGURED = SimpleNamespace(telegram_bot_token="t", telegram_chat_id="42")


async def test_sends_and_says_it_got_through():
    sent: list[str] = []
    notify = notifier(CONFIGURED, sent.append)
    assert await notify("hello") is True
    assert sent == ["hello"]


async def test_awaits_a_sender_that_answers_with_a_promise():
    # `NotifySender` may answer `Promise<void> | void`: the bot's send is async, a test's fake is not
    sent: list[str] = []

    async def send(text: str) -> None:
        await asyncio.sleep(0)
        sent.append(text)

    assert await notifier(CONFIGURED, send)("hello") is True
    assert sent == ["hello"]


async def test_says_nothing_at_all_when_telegram_is_not_configured_and_counts_it_delivered():
    # nothing to retry, and retrying every sweep would log the same line for ever — which is also
    # what keeps `make serve` quiet, since it blanks the token on purpose
    for token, chat in [("", "42"), ("t", ""), ("", "")]:
        sent: list[str] = []
        settings = SimpleNamespace(telegram_bot_token=token, telegram_chat_id=chat)
        assert await notifier(settings, sent.append)("hello") is True, (token, chat)
        assert sent == [], (token, chat)


async def test_survives_a_sender_that_throws_and_says_it_did_not_get_through():
    # a failed send must never stop a sweep, and the manage-by notice must know it was not delivered
    def send(text: str) -> None:
        raise RuntimeError("telegram is down")

    assert await notifier(CONFIGURED, send)("hello") is False


async def test_survives_a_sender_that_rejects():
    async def send(text: str) -> None:
        raise RuntimeError("telegram is down")

    assert await notifier(CONFIGURED, send)("hello") is False


async def test_lets_cancellation_through():
    # Python's own. JavaScript's `catch` takes everything, but a cancelled asyncio task raises
    # CancelledError through whatever it was awaiting, and swallowing it here would leave the loop
    # unable to stop the sweep on the way out. It is not an Exception, so `except Exception` lets it go.
    async def send(text: str) -> None:
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await notifier(CONFIGURED, send)("hello")
