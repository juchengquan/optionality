"""Every command the bot answers, by the name the owner types. Port of
backend/src/entrypoints/bot/commands/index.ts.

A table rather than a switch, which is the point of this directory. `dispatch` held forty lines of
`case` — including the column mappers for three of the replies — so the file with the long-poll loop
in it knew every command's name and half of their formatting. Now the loop looks a name up here and
knows nothing else, and the set can be compared with the "/" menu that announces it
(`tests/entrypoints/bot/commands/test_index.py`).

`UNKNOWN` is deliberately not a member: a word that is not a command is not a failure, it is somebody
who does not know the commands, and the help text is the answer.

**Where the Python differs, and why.** The table is a read-only mapping (`MappingProxyType`), the
TypeScript's `Readonly<Record<…>>`, and it holds only what is written in it. The TypeScript's is a
plain object, so a name off `Object.prototype` is found there too: `/constructor` reaches the `Object`
function and `/__proto__` the prototype itself, neither answers a string, and the update fails in the
long poll with no reply. Here both are words that are no command, and get `UNKNOWN`'s help.
"""

from collections.abc import Mapping
from types import MappingProxyType

from .context import BotContext, Command
from .create import watch, watchcombo
from .edit import rename, threshold, unwatch
from .service import health, help, holdings, snapshot
from .watchlist import combo, greeks, monitors, quotes, vol

__all__ = ["COMMANDS", "UNKNOWN", "BotContext", "Command"]

COMMANDS: Mapping[str, Command] = MappingProxyType(
    {
        "combo": combo,
        "greeks": greeks,
        "health": health,
        "help": help,
        "holdings": holdings,
        "monitors": monitors,
        "quotes": quotes,
        "rename": rename,
        "snapshot": snapshot,
        "threshold": threshold,
        "unwatch": unwatch,
        "vol": vol,
        "watch": watch,
        "watchcombo": watchcombo,
    }
)

#: What an unrecognised word gets.
UNKNOWN: Command = help
