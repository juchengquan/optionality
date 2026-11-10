"""The command table, as a table. Port of backend/src/entrypoints/bot/commands/index.test.ts — PARTLY,
as `commands/__init__.py` is: the table holds every command but the four `commands/service.py` will serve,
which is the next change, and `NOT_YET` names them.

`dispatch` was a 40-line switch that also held the column mappers for three of the replies, so the
long-poll loop's file knew every command's name and half their formatting. Now the set is data, and
these are the two things a `switch` could not be asked:

- every command the "/" menu announces is one the bot will answer, and
- every command the bot answers is announced.

Neither held before. `help` worked only by falling through `default`, so it was announced and not
registered; nothing would have caught the reverse either.

What only the Python can get wrong is at the end: the partial port's own promise, that a command not
ported yet is ABSENT rather than answered by a stand-in.
"""

import pytest

from optionality_backend.entrypoints.bot.commands import COMMANDS, NOT_YET
from optionality_backend.entrypoints.bot.format import BOT_COMMANDS


class TestTheCommandTable:
    def test_answers_exactly_what_the_menu_announces(self):
        # Telegram shows BOT_COMMANDS as autocomplete, so a name there that the bot does not answer is an
        # offer the owner taps and gets the help text for. Less what is not ported yet, which may only
        # shrink: the table is done when NOT_YET is empty, and this compares the whole menu then.
        assert sorted(COMMANDS) == sorted({c.command for c in BOT_COMMANDS} - NOT_YET)

    def test_names_every_command_in_lower_case_which_is_what_dispatch_compares(self):
        # `/Watch` and `/watch@thebot` both arrive, and dispatch lower-cases and strips before it looks
        # here — a capitalised key would simply never be found
        for name in COMMANDS:
            assert name == name.lower()


class TestWhatOnlyThePythonCanGetWrong:
    def test_names_only_announced_commands_as_not_ported_yet(self):
        # a NOT_YET that named something the menu does not announce would excuse nothing and never
        # empty, and one that named a command in the table would excuse what is already there
        assert NOT_YET <= {c.command for c in BOT_COMMANDS}
        assert NOT_YET.isdisjoint(COMMANDS)

    @pytest.mark.parametrize("name", sorted(NOT_YET))
    def test_leaves_a_command_not_ported_yet_absent_rather_than_stubbed(self, name):
        # absent, so its scenario fails rather than passing on a stand-in (README, "A partial port")
        with pytest.raises(KeyError):
            COMMANDS[name]

    def test_cannot_be_changed_by_a_caller(self):
        # `Readonly<Record<…>>` in the TypeScript: a command added at run time would answer without
        # being announced, which is the first property above broken from outside
        with pytest.raises(TypeError):
            COMMANDS["extra"] = COMMANDS["monitors"]  # type: ignore[index]
