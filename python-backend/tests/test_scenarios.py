"""Every scenario under `testdata/scenarios/`, replayed against the Python backend (ADR 0021).

The Python's half of `backend/testing/scenarios/replay.test.ts`, kept to the same one idea: read a
file, run its event through its door on its world, and expect exactly what the file says. The
difference is the backlog (`scenarios/backlog.py`): while the first port is under way, a scenario
listed there is SKIPPED, visibly and with its reason, and one that passes while still listed FAILS
until it is taken off. Every scenario not listed must pass. The suite's last line says how far the
port has come: "door scenarios: N of 120 ported".
"""

import pytest
from scenarios import backlog
from scenarios.corpus import DOORS, all_scenarios, read_scenario, scenario_files

CORPUS = all_scenarios()
LISTED = set(backlog.BACKLOG)


@pytest.mark.parametrize("door", DOORS)
def test_the_door_has_scenarios_to_replay(door):
    # an empty directory replays nothing and passes, which is the one way this suite could lie
    assert scenario_files(door), f"testdata/scenarios/{door}/ is empty — run 'make scenarios'"


def test_the_backlog_names_only_scenarios_that_exist():
    found = backlog.findings(CORPUS, backlog.BACKLOG)
    assert not found, "\n".join(found)


@pytest.mark.parametrize("name", CORPUS)
def test_replays(name):
    outcome, why = backlog.judge(name, read_scenario(name), listed=name in LISTED)
    if outcome == "skip":
        pytest.skip(why)
    if outcome == "fail":
        pytest.fail(why, pytrace=False)
