"""What a command is, and what it is given. Port of backend/src/entrypoints/bot/commands/context.ts.

A command answers with the TEXT of its reply and nothing else — no sending, no chat id, no Telegram
API. That is what lets each one be driven directly by a test, and it is why the transport in
`../bot.py` can hold the only `api` call in the package: the only thing a command may do with the
outside world is make its one bounded market-data call.

Faults come back as sentences rather than exceptions, because a chat is the error channel here: there
is nowhere else to put a usage error, and a raise would reach the long-poll loop, be logged, and leave
the owner's message unanswered.

**Where the Python differs, and why.** `BotContext` is a frozen dataclass, and `now` a field holding
the clock rather than a method. A `Command` may answer its text or an awaitable of it, as the
TypeScript's `string | Promise<string>`; the transport awaits only the second. `require_number` is
JavaScript's `Number` through `optionality.js.number` — so `0x10` is 16 and `1_000` is not a number,
where Python's `float` says the opposite of both — and refuses with a `ValueError`, a refusal of bad
input. `failed` writes `str(err)`, which is `err.message`.
"""

import math
import sqlite3
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime

from optionality.js import number

from ....create_monitor import CreateDeps
from ....env import Settings
from ....ports import QuoteFetcher, SweeperPort


@dataclass(frozen=True)
class BotContext:
    db: sqlite3.Connection
    settings: Settings
    #: the one bounded call a command may make (CLAUDE.md's invariant)
    fetch_quotes: QuoteFetcher
    #: injectable, so a test states the time rather than waiting for it; an AWARE datetime
    now: Callable[[], datetime]
    #: absent in a test that is not about the engine's own health
    sweeper: SweeperPort | None = None
    #: the id a created rule gets, injectable for the same reason; None mints a uuid
    new_id: Callable[[], str] | None = None


#: The arguments are the words after the command, already split. Parsing them is each command's own
#: business — `/watch` takes a date and a strike, `/unwatch` takes anything that might name a rule —
#: and there is no shared grammar to put above them.
type Command = Callable[[BotContext, list[str]], str | Awaitable[str]]


def require_number(text: str) -> float:
    """`float(x)` in the old Python: anything unparseable is a usage error, not NaN."""
    value = number(text)
    if not math.isfinite(value):
        raise ValueError(f"not a number: {text}")
    return value


def creating(ctx: BotContext) -> CreateDeps:
    """What create_monitor.py needs: the database, one Provider, a clock and the ids."""
    return CreateDeps(db=ctx.db, fetch_quotes=ctx.fetch_quotes, now=ctx.now, new_id=ctx.new_id)


def failed(label: str, err: Exception) -> str:
    """A failed market-data call, said the way each table says it.

    Every command that leaves the machine catches, because a Provider that is down must produce a
    sentence in the chat rather than a logged raise and a silence on the phone.
    """
    return f"{label} failed: {err}"


#: The reply every table command gives for an empty watchlist. One sentence, in one place.
EMPTY_WATCHLIST = "Watchlist is empty. Add one with /watch."
