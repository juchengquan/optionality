"""The command table, as a table. Port of backend/src/entrypoints/bot/commands/index.test.ts.

`dispatch` was a 40-line switch that also held the column mappers for three of the replies, so the
long-poll loop's file knew every command's name and half their formatting. Now the set is data, and
these are the two things a `switch` could not be asked:

- every command the "/" menu announces is one the bot will answer, and
- every command the bot answers is announced.

Neither held before. `help` worked only by falling through `default`, so it was announced and not
registered; nothing would have caught the reverse either.

What only the Python can get wrong is at the end.
"""

import pytest

from optionality_backend.entrypoints.bot.commands import COMMANDS
from optionality_backend.entrypoints.bot.format import BOT_COMMANDS


class TestTheCommandTable:
    def test_answers_exactly_what_the_menu_announces(self):
        # Telegram shows BOT_COMMANDS as autocomplete, so a name there that the bot does not answer is an
        # offer the owner taps and gets the help text for
        assert sorted(COMMANDS) == sorted(c.command for c in BOT_COMMANDS)

    def test_names_every_command_in_lower_case_which_is_what_dispatch_compares(self):
        # `/Watch` and `/watch@thebot` both arrive, and dispatch lower-cases and strips before it looks
        # here — a capitalised key would simply never be found
        for name in COMMANDS:
            assert name == name.lower()


class TestWhatOnlyThePythonCanGetWrong:
    def test_cannot_be_changed_by_a_caller(self):
        # `Readonly<Record<…>>` in the TypeScript: a command added at run time would answer without
        # being announced, which is the first property above broken from outside
        with pytest.raises(TypeError):
            COMMANDS["extra"] = COMMANDS["monitors"]  # type: ignore[index]
