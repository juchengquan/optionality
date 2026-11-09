"""The Telegram bot's transport: the long poll, the owner check, and the reply. Port of
backend/src/entrypoints/bot/bot.ts.

Long-polls getUpdates and answers commands, from the owner chat only.

**The token allows ONE getUpdates consumer** (CLAUDE.md), so this must never run beside a second
service instance against the same token — the two backends run one at a time for that reason among
others (ADR 0021) — and no test may reach the real API. The tests drive `handle_update` directly with
a fake, exactly as the TypeScript's do.

What the commands THEMSELVES do is `commands/`, and this file knows none of their names. It held a
forty-line `switch` with three of the replies' column mappers inside it, so the file with the poll
loop in it was also where `/greeks` decided how many decimals a gamma gets. Now a command is a
function from a context and some words to the text of a reply, the set is a table, and the table can
be held to the "/" menu that announces it.

**Partly ported**, through the table: `commands/service.py` is not ported yet, so neither is
`UNKNOWN`, the help text an unrecognised word gets, and `dispatch` raises where the TypeScript falls
back to it (`commands/__init__.py` says why, and `NOT_YET` what is missing).

**Where the Python differs, and why.**

- **An update is JSON, read as JavaScript reads it.** `update.message?.chat?.id` is `_field` down a
  chain of dicts, where anything that is not a dict answers None as `?.` answers undefined; the chat
  id and the text are `String(…)` (`format.js_text`), so a numeric id 42 is "42"; and the text is
  trimmed and split on JavaScript's whitespace (`format.JS_WHITESPACE`), not `str.split`'s.
- **A command may answer its text or an awaitable of it**, and only an awaitable is awaited.
- `api` is awaited — `telegram.telegram_api` in the service — and the retry after a failed poll is
  `asyncio.sleep(5)`. Every catch is `except Exception`, never wider, so cancelling the task that
  runs the loop stops it rather than being logged and retried.
- A failure is logged with its stack (`log.exception`), as `console.error` with the error prints one.
"""

import asyncio
import inspect
import json
import logging
import re
import sqlite3
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ...env import Settings
from ...ports import QuoteFetcher, SweeperPort
from .commands import COMMANDS, BotContext
from .format import BOT_COMMANDS, JS_WHITESPACE, js_text

log = logging.getLogger(__name__)

#: One call to the Telegram API. A fake in tests; HTTPS in production (`telegram.telegram_api`).
type TelegramApi = Callable[[str, dict[str, str]], Awaitable[Any]]

_SPACES = re.compile(f"[{re.escape(JS_WHITESPACE)}]+")


@dataclass(frozen=True)
class BotDeps:
    db: sqlite3.Connection
    settings: Settings
    api: TelegramApi
    fetch_quotes: QuoteFetcher
    sweeper: SweeperPort | None = None
    #: an AWARE datetime; None means now
    now: Callable[[], datetime] | None = None
    #: the id a created rule gets; a uuid unless a door scenario states it (ADR 0021)
    new_id: Callable[[], str] | None = None


def _field(value: Any, key: str) -> Any:
    """`value?.[key]` on parsed JSON: None for anything that is not an object, or has no such key."""
    return value.get(key) if isinstance(value, dict) else None


class TelegramBot:
    def __init__(self, deps: BotDeps) -> None:
        self._deps = deps
        self._offset = 0
        self._stopped = False

    def _now(self) -> datetime:
        return self._deps.now() if self._deps.now is not None else datetime.now(UTC)

    def stop(self) -> None:
        self._stopped = True

    async def start(self) -> None:
        """Publish the "/" autocomplete menu and drain the backlog. Does NOT start polling.

        The drain matters: without it a service restart replays every command sent while it was down,
        and a `/unwatch` from an hour ago would be obeyed as if it were new.

        Separate from `run()` so that a caller — and a test — can do the setup without entering a loop.
        The real loop blocks for 25 seconds in getUpdates; a fake that answers at once turns it into a
        busy wait that starves everything else.
        """
        menu = [{"command": c.command, "description": c.description} for c in BOT_COMMANDS]
        try:
            await self._deps.api(
                "setMyCommands", {"commands": json.dumps(menu, separators=(",", ":"), ensure_ascii=False)}
            )
        except Exception:
            log.exception("telegram setMyCommands failed:")
        try:
            last = await self._deps.api("getUpdates", {"offset": "-1", "timeout": "0"})
            if isinstance(last, list) and last:
                update_id = _field(last[-1], "update_id")
                self._offset = (-1 if update_id is None else update_id) + 1
        except Exception:
            log.exception("telegram backlog drain failed:")

    async def run(self) -> None:
        """The long-poll loop. Runs until `stop()`."""
        log.info("telegram bot polling started")
        while not self._stopped:
            try:
                updates = await self._deps.api("getUpdates", {"offset": str(self._offset), "timeout": "25"})
            except Exception:
                log.exception("telegram getUpdates failed; retrying:")
                await asyncio.sleep(5)
                continue
            for update in updates if updates is not None else []:
                update_id = _field(update, "update_id")
                self._offset = (self._offset if update_id is None else update_id) + 1
                try:
                    await self.handle_update(update)
                except Exception:
                    log.exception("failed handling telegram update %s:", js_text(update_id))

    def next_offset(self) -> int:
        """What the next poll will ask for, so a test can see the backlog was drained."""
        return self._offset

    async def handle_update(self, update: Any) -> None:
        message = _field(update, "message")
        sender = _field(_field(message, "chat"), "id")
        chat_id = "" if sender is None else js_text(sender)
        # only the owner chat may command the bot; everyone else is ignored without a reply, because a
        # reply would confirm the bot exists
        if chat_id != self._deps.settings.telegram_chat_id:
            return
        typed = _field(message, "text")
        text = ("" if typed is None else js_text(typed)).strip(JS_WHITESPACE)
        if not text:
            return
        reply = await self.dispatch(text)
        if not reply:
            return
        params = {"chat_id": chat_id, "text": reply}
        # HTML parse mode ONLY for tables: a plain reply containing "<0.6" would lose it to a tag
        if reply.startswith("<pre>"):
            params["parse_mode"] = "HTML"
        await self._deps.api("sendMessage", params)

    async def dispatch(self, text: str) -> str:
        """The command, if the words name one, and the help text if they do not.

        `/watch@thebot` and `/Watch` both arrive — Telegram appends the bot's username in a group and
        the keyboard capitalises — so the name is stripped and lower-cased before the lookup.
        """
        parts = _SPACES.split(text)
        first = parts[0]
        name = first.split("@")[0][1:].lower() if first.startswith("/") else ""
        # `COMMANDS[name] ?? UNKNOWN` in the TypeScript. UNKNOWN is the help, which is
        # `commands/service.py`'s and not ported yet, so a name the table does not hold raises here
        # rather than being answered by a stand-in (`commands/__init__.py`).
        command = COMMANDS.get(name)
        if command is None:
            raise LookupError(
                f"nothing answers {first!r} yet: the help and /health, /help, /holdings and /snapshot "
                "are commands/service.py's, which is not ported yet"
            )
        reply = command(self._context(), parts[1:])
        if inspect.isawaitable(reply):
            reply = await reply
        return reply

    def _context(self) -> BotContext:
        """What a command is given: no chat id and no `api`, so a command cannot reply twice or to
        somebody else. Built per dispatch because the clock is read through it."""
        return BotContext(
            db=self._deps.db,
            settings=self._deps.settings,
            fetch_quotes=self._deps.fetch_quotes,
            sweeper=self._deps.sweeper,
            now=self._now,
            new_id=self._deps.new_id,
        )
