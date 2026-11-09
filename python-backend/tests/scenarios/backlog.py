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
#: joins only in a diff like that one, and only while its door is still unported.
BACKLOG = [
    "bot/a-message-from-any-other-chat-gets-no-reply.json",
    "bot/a-word-that-is-not-a-command-gets-the-help.json",
    "bot/combo-breaks-a-combo-into-its-legs-with-the-signed-total.json",
    "bot/combo-calls-the-total-incomplete-when-a-leg-is-unpriced.json",
    "bot/combo-names-nothing-it-cannot-find.json",
    "bot/greeks-shows-delta-gamma-and-theta.json",
    "bot/health-after-a-sweep-names-when-it-ran.json",
    "bot/health-on-a-service-that-has-not-swept-yet.json",
    "bot/help-lists-the-commands.json",
    "bot/holdings-says-so-when-the-provider-is-down.json",
    "bot/holdings-values-each-holding-in-a-four-column-table.json",
    "bot/holdings-with-nothing-held.json",
    "bot/monitors-lists-the-stored-rules-without-asking-the-provider.json",
    "bot/monitors-on-an-empty-watchlist.json",
    "bot/monitors-optionality-bot-is-still-monitors.json",
    "bot/quotes-on-an-empty-watchlist-asks-the-provider-nothing.json",
    "bot/quotes-prices-the-single-leg-rules-with-the-bell-from-the-same-reading.json",
    "bot/quotes-says-so-when-the-provider-is-down.json",
    "bot/rename-refuses-a-name-already-taken.json",
    "bot/rename-renames-a-combo-and-keeps-its-alarm-state.json",
    "bot/snapshot-quotes-a-contract-nothing-watches.json",
    "bot/snapshot-says-when-there-is-no-data.json",
    "bot/threshold-moves-a-rule-named-by-its-code.json",
    "bot/threshold-refuses-a-zero-threshold.json",
    "bot/unwatch-names-nothing-it-cannot-match.json",
    "bot/unwatch-refuses-an-id-prefix-that-matches-more-than-one-rule.json",
    "bot/unwatch-removes-a-rule-named-by-its-short-contract-and-keeps-the-holding.json",
    "bot/vol-shows-iv-and-vega.json",
    "bot/watch-adds-a-rule-and-links-it-to-the-holding-of-its-contract.json",
    "bot/watch-refuses-a-contract-the-provider-does-not-know.json",
    "bot/watch-refuses-a-rule-already-there-without-asking-the-provider.json",
    "bot/watch-refuses-a-zero-threshold-in-the-bot-s-own-words.json",
    "bot/watch-takes-a-field-a-direction-and-a-signed-compare-in-any-order.json",
    "bot/watch-with-too-few-words-answers-with-its-usage.json",
    "bot/watchcombo-adds-a-combo-from-signed-legs.json",
    "bot/watchcombo-with-one-leg-answers-with-its-usage.json",
    "http/delete-monitors-id-on-a-rule-that-does-not-exist.json",
    "http/delete-monitors-id-removes-the-rule-and-its-links-and-keeps-the-holding.json",
    "http/delete-positions-id-on-a-holding-that-does-not-exist.json",
    "http/delete-positions-id-removes-the-holding-with-its-links-and-samples-and-keeps-the-rules.json",
    # /health is ported, and these wait for the sweep: the route reads the engine's health account,
    # which the engine's door hands out only as `MonitorSweeper.health` (`engine/__init__.py`), so the
    # scenario backend has none to give it until the sweeper is ported. Two replay an earlier sweep too.
    "http/get-health-after-a-sweep-that-worked.json",
    "http/get-health-after-the-provider-failed-a-sweep.json",
    "http/get-health-answers-without-a-token-on-a-service-that-has-not-swept-yet.json",
    "http/get-monitors-lists-every-rule-with-the-holdings-it-covers.json",
    "http/get-positions-id-vol-measures-vol-over-the-holding-s-own-samples.json",
    "http/get-positions-id-vol-on-a-holding-that-does-not-exist.json",
    "http/get-positions-id-vol-says-nothing-when-the-samples-do-not-reach-back-to-the-open.json",
    "http/get-positions-values-answers-502-naming-the-provider-when-it-is-down.json",
    "http/get-positions-values-values-every-holding-from-one-call.json",
    "http/get-positions-values-with-nothing-held-asks-the-provider-nothing.json",
    "http/get-quotes-answers-502-naming-the-provider-when-it-is-down.json",
    "http/get-quotes-marks-a-contract-the-provider-does-not-know.json",
    "http/get-quotes-on-an-empty-watchlist-asks-the-provider-nothing.json",
    "http/get-quotes-prices-the-whole-watchlist-in-one-call.json",
    "http/patch-monitors-id-moves-a-threshold.json",
    "http/patch-monitors-id-mutes-a-rule-by-hand.json",
    "http/patch-monitors-id-on-a-rule-that-does-not-exist.json",
    "http/patch-monitors-id-refuses-a-rename-onto-a-name-already-taken.json",
    "http/patch-monitors-id-refuses-a-zero-threshold.json",
    "http/patch-monitors-id-refuses-an-empty-change.json",
    "http/patch-monitors-id-refuses-to-rename-a-single-leg-rule.json",
    "http/patch-monitors-id-renames-a-combo-and-keeps-its-alarm-state.json",
    "http/patch-positions-id-on-a-holding-that-does-not-exist.json",
    "http/patch-positions-id-records-the-entry-and-the-day-it-was-opened.json",
    "http/patch-positions-id-refuses-an-empty-change.json",
    "http/post-monitors-creates-a-combo-from-its-legs-probing-both-in-one-call.json",
    "http/post-monitors-creates-a-rule-already-muted.json",
    "http/post-monitors-creates-a-single-leg-rule-and-links-it-to-the-holding-of-its-contract.json",
    "http/post-monitors-id-total-entry-derives-the-one-wing-with-no-rule-of-its-own.json",
    "http/post-monitors-id-total-entry-on-a-rule-that-does-not-exist.json",
    "http/post-monitors-id-total-entry-refuses-a-rule-that-covers-no-holding.json",
    "http/post-monitors-refuses-a-combo-on-a-figure-that-does-not-add-up.json",
    "http/post-monitors-refuses-a-combo-s-strike-date-it-cannot-read.json",
    "http/post-monitors-refuses-a-contract-the-provider-does-not-know.json",
    "http/post-monitors-refuses-a-duplicate-without-asking-the-provider.json",
    "http/post-monitors-refuses-a-strike-date-it-cannot-read.json",
    "http/post-monitors-refuses-a-zero-threshold-compared-as-an-absolute.json",
    "http/post-monitors-refuses-while-the-provider-cannot-confirm-the-contract.json",
    "http/post-positions-records-a-holding-and-adopts-the-rule-already-watching-it.json",
    "http/post-positions-refuses-a-holding-with-no-legs.json",
    "http/post-positions-refuses-a-leg-the-provider-does-not-know.json",
    "http/post-positions-refuses-a-name-already-held-without-asking-the-provider.json",
]


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
