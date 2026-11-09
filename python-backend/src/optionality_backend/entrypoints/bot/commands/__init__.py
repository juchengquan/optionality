"""Every command the bot answers, by the name the owner types. Port of
backend/src/entrypoints/bot/commands/index.ts.

A table rather than a switch, which is the point of this directory. `dispatch` held forty lines of
`case` — including the column mappers for three of the replies — so the file with the long-poll loop
in it knew every command's name and half of their formatting. Now the loop looks a name up here and
knows nothing else, and the set can be compared with the "/" menu that announces it
(`tests/entrypoints/bot/commands/test_index.py`).

`UNKNOWN` is deliberately not a member: a word that is not a command is not a failure, it is somebody
who does not know the commands, and the help text is the answer.

**Partly ported.** `commands/service.ts` serves four commands — `/health`, `/help`, `/holdings` and
`/snapshot` — and is not ported yet, so `service.py` does not exist and neither do they. `NOT_YET`
names them; they are ABSENT from the table, never stubbed, and so is
`UNKNOWN`, which is `help`. Until `service.py` lands, a name the table does not hold — theirs, or a
word that is no command at all — reaches nothing in `bot.py`'s dispatch, and the update fails there
with a raise the long poll logs: the scenarios that need them stay on the backlog, and fail loudly if
anyone takes them off it. `NOT_YET` may only shrink; it goes, with this paragraph, when the table is
whole.

**Where the Python differs, and why.** The table is a read-only mapping (`MappingProxyType`), the
TypeScript's `Readonly<Record<…>>`, and a name it does not hold is a `KeyError` rather than
`undefined` — the TypeScript's plain object would also have handed `/constructor` the `Object`
function off its prototype.
"""

from collections.abc import Mapping
from types import MappingProxyType

from .context import BotContext, Command
from .create import watch, watchcombo
from .edit import rename, threshold, unwatch
from .watchlist import combo, greeks, monitors, quotes, vol

__all__ = ["COMMANDS", "NOT_YET", "BotContext", "Command"]

COMMANDS: Mapping[str, Command] = MappingProxyType(
    {
        "combo": combo,
        "greeks": greeks,
        "monitors": monitors,
        "quotes": quotes,
        "rename": rename,
        "threshold": threshold,
        "unwatch": unwatch,
        "vol": vol,
        "watch": watch,
        "watchcombo": watchcombo,
    }
)

#: What the table does not hold yet: `commands/service.py`'s four, the next change. Written
#: out, and it may only shrink.
NOT_YET = frozenset({"health", "help", "holdings", "snapshot"})
