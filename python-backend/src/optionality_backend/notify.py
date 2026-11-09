"""Telling the owner, and saying whether it got through. Port of backend/src/notify.ts.

One function, extracted because three callers had grown around it: the sweep's quarantine and expiry
notices, `engine/positions`'s manage-by line, and the degraded/flapping/recovered notices in
`engine/health`.

A failed send must never stop a sweep — the sweep's job is the alarm — so this swallows the error.
That makes "did it raise" useless to a caller, and the manage-by notice needs the answer: it is
raised ONCE, so a stamp written after an undelivered notice loses it for ever. Hence a return value
rather than a re-raise.

Telegram not being configured counts as DELIVERED. There is nothing to retry, and retrying every
sweep would log the same line for ever — which is also what makes `make serve` quiet, since it
blanks the token on purpose so a local sweep cannot message the owner's phone.

**Where the Python differs, and why.**

- JavaScript's `catch` takes everything; this takes `Exception`, which is everything a failed send
  raises and not `asyncio.CancelledError`. That one means the task is being stopped — the sweep on
  the way out of the process — and swallowing it would keep the task alive.
- `NotifySender` may answer a coroutine or nothing, as the TypeScript's `Promise<void> | void` does:
  `await` takes a plain value in JavaScript, and here an awaitable is awaited and anything else is
  not.
- `settings` is typed by the two fields read from it, `TelegramSettings`, where the TypeScript names
  the whole `Settings`: any object with the two is accepted, the real one included, and the module
  holds no import of a Settings it does not otherwise need.
"""

import inspect
import logging
from collections.abc import Awaitable, Callable
from typing import Protocol

log = logging.getLogger(__name__)

#: Sending a message to the owner's phone, as the service's own modules see it.
type Notifier = Callable[[str], Awaitable[bool]]

#: The raw transport: what `telegram.telegram_sender` provides and what a test fakes.
type NotifySender = Callable[[str], Awaitable[None] | None]


class TelegramSettings(Protocol):
    """What this reads of Settings: Telegram's two credentials, blank when not configured."""

    telegram_bot_token: str
    telegram_chat_id: str


def notifier(settings: TelegramSettings, send: NotifySender) -> Notifier:
    async def notify(text: str) -> bool:
        if not settings.telegram_bot_token or not settings.telegram_chat_id:
            log.info("telegram not configured; alarm suppressed: %s", text)
            return True
        try:
            sent = send(text)
            if inspect.isawaitable(sent):
                await sent
            return True
        except Exception:
            log.exception("telegram send failed")
            return False

    return notify
