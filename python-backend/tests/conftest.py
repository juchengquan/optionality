"""The suite's account of the port, printed last: how many door scenarios the Python passes.

The backlog's scenarios are skipped one by one with their reasons (`pytest -rs` lists them), but a
column of 120 `s` says nothing about progress. This line does, counted from what actually ran — a
scenario counts as ported only if its replay PASSED here — and it is printed only when the replay
did run, so `make check-py-backend`, which runs two lint files, does not claim anything about it.
"""

REPLAY = "test_scenarios.py::test_replays["


def pytest_terminal_summary(terminalreporter):
    outcomes = {}
    for key in ("passed", "failed", "skipped"):
        for report in terminalreporter.stats.get(key, []):
            if REPLAY in report.nodeid and report.when in ("call", "setup"):
                outcomes[report.nodeid] = key
    if not outcomes:
        return
    from scenarios.corpus import all_scenarios

    total = len(all_scenarios())
    ported, skipped, failed = (sum(1 for o in outcomes.values() if o == k) for k in ("passed", "skipped", "failed"))
    line = f"door scenarios: {ported} of {total} ported, {skipped} on the backlog"
    terminalreporter.write_line(line + (f", {failed} FAILING" if failed else ""), bold=True)
