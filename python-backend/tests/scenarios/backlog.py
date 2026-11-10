"""The door scenarios the Python backend does not pass yet, and the rules that make the list shrink.

ADR 0021 allows a backlog only during the first port, and only one that SHRINKS. A test cannot read
history, so the shrinking is held the other way round, with the rules and the wording of
`tools/check-module-map.mjs`'s BACKLOG, which holds the same port module for module:

* a scenario that passes while still listed fails — "take it off the backlog";
* a scenario NOT listed must pass, so a new TypeScript scenario cannot join the list without
  someone writing it in, here, in a diff. Outside the first port that is lockstep: a scenario and
  the Python that passes it land together;
* a listed scenario that no longer exists fails, and so does one listed twice;
* the list is written out, never derived from the directory (`test_scenario_runner.py` reads this
  file's syntax to hold that), because a derived list would take in every new scenario unseen.

A listed scenario is still RUN, every time, and skipped with the reason it does not pass — not
ported, or the first difference — so the skip says what is left, and a scenario that starts passing
is noticed the day it does. When the list is empty the port is done, and this file should be
deleted with it.

Each entry is a scenario's path under `testdata/scenarios/`.
"""

from pathlib import Path
from typing import Any

from .backend import NotPorted
from .compare import first_difference
from .doors import RUN, Builder

#: this file, whose syntax the runner's suite reads to keep BACKLOG written out
SOURCE = Path(__file__)

#: Not yet ported. Frozen on 2026-11-09 with all 120 scenarios the corpus had; it may only shrink.
#: Three joined the same day, written in by the fix that added them (POST /monitors' specific
#: message, FLAPPING_REPEAT_SECONDS) while no Python door existed to port them to: a new scenario
#: joins only in a diff like that one, and only while its door is still unported. Empty since
#: 2026-11-10, when the bot's last four commands were ported: every scenario passes.
BACKLOG = []


def findings(corpus: list[str], backlog: list[str]) -> list[str]:
    """What is wrong with the list itself, one line each; empty when nothing is."""
    present, seen, out = set(corpus), set(), []
    for name in backlog:
        if name not in present:
            out.append(f"the backlog names {name}, which is not in testdata/scenarios/ any more")
        if name in seen:
            out.append(f"the backlog names {name} twice")
        seen.add(name)
    return out


def judge(name: str, scenario: dict[str, Any], *, listed: bool, build: Builder | None = None) -> tuple[str, str]:
    """Replay one scenario and say what the suite should make of it: `("pass", "")`, `("skip", why)`
    or `("fail", why)`.

    A crash is only swallowed for a LISTED scenario, where it is one more way of not passing yet and
    its reason names it. Anywhere else it propagates, so a scenario that must pass shows its whole
    traceback rather than a one-line summary of it."""
    door = name.split("/")[0]
    try:
        actual = RUN[door](scenario, build)
    except NotPorted as err:
        difference: str | None = f"not ported — {err}"
    except Exception as err:
        if not listed:
            raise
        difference = f"{type(err).__name__}: {err}"
    else:
        difference = first_difference(actual, scenario["expect"])

    if listed:
        if difference is None:
            return "fail", f"{name} passes: take it off the backlog"
        return "skip", f"on the backlog: {difference}"
    if difference is None:
        return "pass", ""
    return "fail", (
        f"{name} is not on the backlog, so the Python must pass it: {difference}. Port what it needs "
        "in the same change (lockstep, ADR 0021)"
    )
