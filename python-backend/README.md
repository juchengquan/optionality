# optionality-backend

The optionality service in Python: the standby beside the TypeScript backend, able to run the whole
service — the sweep and its alarms, the database, the API the dashboard calls and the bot — so that
either can be the live one, one at a time (ADR 0021). Today it is a skeleton: the package, its suite
and the two lines it may not cross. The code arrives phase by phase.

**It is never released.** It runs from the working tree, as `backend/` does, under the launchd agent
that `make deploy` restarts — so what is checked out is what runs, and there is no version anybody
pins. The library beside it, `python/`, is the opposite: released by git tag (ADR 0016) and installed
by notebooks from its subdirectory. The two share one uv workspace, rooted at the repository's
`pyproject.toml`, with one `uv.lock`.

It depends on `optionality` only through what the library publishes, and it places no order:

- `tests/test_library_boundary.py` refuses a private `optionality._*` module or name,
  `optionality.research` (no golden case holds it, ADR 0020), and any reach into the library's
  source by path.
- `tests/test_no_trading.py` refuses any reference that places, modifies, cancels or exercises an
  order, outside a `trading/` module that does not exist until an ADR creates it (ADR 0021,
  Decision 8). The list of what it refuses is derived from `ib_async`, and the test says how.

Both run in `make lint` and in `make test`, which is part of `make check`.

It is held to the TypeScript at the service's three doors (ADR 0021, Decision 4):
`tests/test_scenarios.py` replays every scenario in `testdata/scenarios/` through
`tests/scenarios/`, the Python's half of the replay. The one place the backend plugs in is
`tests/scenarios/backend.py`'s `build`. Until a scenario passes it stays on
`tests/scenarios/backlog.py`, skipped with its reason; the suite ends by counting the port —
"door scenarios: N of 120 ported" — and the list may only shrink.
