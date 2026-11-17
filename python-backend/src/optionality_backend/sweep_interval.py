"""The sweep's interval in force, where it came from, and the knobs it moves (#442, ADR 0025). Port of
backend/src/sweep-interval.ts.

The ONE behaviour knob kept in the database. `.env`'s MONITOR_INTERVAL_SECONDS is the default and stays
in force until the page chooses a preset; the page's choice is a row in `sweep_interval`, and clearing
it is the way back. Paired with `routes/settings.py` the way `references.py` is with its routes: this
module does the work, the route reports it.

READ, never remembered. The engine asks at every tick, the health account at every reading and
`/health` at every request, so a choice made on the page is in force at the next sweep with no restart
— and there is no copy in memory for the routes, which may not reach the engine, to have to update.

**Where the Python differs, and why.** A refused value is described as `JSON.stringify` writes it, by
`json.dumps` with JavaScript's separators: a stored value is an integer, a float or text, and for those
the two agree (a float SQLite holds is never integral here — INTEGER affinity stores `7.0` as `7`).
"""

import dataclasses
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from optionality.cadence import SweepSeconds, is_sweep_preset, sweeps_for

from .db.queries import clear_sweep_interval, read_sweep_interval, write_sweep_interval
from .db.time import to_sql_datetime
from .env import Settings

type SweepSource = Literal["settings", "env"]


@dataclass(frozen=True)
class SweepInterval:
    #: the interval the engine sweeps at now
    seconds: int
    #: "settings" when the page chose it, "env" when it is `.env`'s
    source: SweepSource
    #: `.env`'s interval: the default, and what every counted knob was sized at
    default_seconds: int
    #: a stored value that was not used, as it was found, or None. The route writes only a preset, so
    #: this is a hand edit — or a database that could not be read at all, which sweeps at `.env`'s
    #: rather than raising: this is read at every tick, and a raise there would stop the alarms.
    refused: str | None


def _from_env(settings: Settings, refused: str | None) -> SweepInterval:
    seconds = settings.monitor_interval_seconds
    return SweepInterval(seconds=seconds, source="env", default_seconds=seconds, refused=refused)


def sweep_interval(db: sqlite3.Connection, settings: Settings) -> SweepInterval:
    try:
        found = read_sweep_interval(db)
    except Exception as err:  # noqa: BLE001 — the TypeScript's bare catch: read at every tick, never raised
        return _from_env(settings, f"unreadable: {err}")
    if found is None:
        return _from_env(settings, None)
    stored = found["seconds"]
    if not is_sweep_preset(stored):
        return _from_env(settings, json.dumps(stored, separators=(",", ":"), ensure_ascii=False))
    return SweepInterval(
        seconds=int(stored), source="settings", default_seconds=settings.monitor_interval_seconds, refused=None
    )


def refusal_words(at: SweepInterval) -> str:
    """What the log says when a stored value is refused (`MonitorSweeper.every_seconds`): once when it
    first appears, at boot or later, and not at every tick."""
    refused = at.refused or ""
    if refused.startswith("unreadable: "):
        return (
            f"sweep_interval could not be read ({refused[len('unreadable: ') :]}): "
            f"sweeping every {at.seconds}s, MONITOR_INTERVAL_SECONDS"
        )
    return (
        f"sweep_interval in the database is {refused}, not one of the presets: "
        f"sweeping every {at.seconds}s, MONITOR_INTERVAL_SECONDS, until it is set from the page"
    )


def choose_sweep_interval(
    db: sqlite3.Connection, settings: Settings, seconds: SweepSeconds | None, now: datetime
) -> SweepInterval:
    """The page's choice, or None for `.env`'s; answered with the interval now in force."""
    if seconds is None:
        clear_sweep_interval(db)
    else:
        write_sweep_interval(db, seconds, to_sql_datetime(now))
    return sweep_interval(db, settings)


def at_interval(settings: Settings, every_seconds: float) -> Settings:
    """The knobs COUNTED IN SWEEPS, at the interval in force: each keeps the time it was sized for at
    `.env`'s interval (the owner's decision; `optionality.cadence`).

    Three, and the list is the whole of it — every other knob is already a time:
    - `degraded_after_failures`: consecutive failed sweeps before the degraded notice;
    - `quarantine_after_silent_sweeps`: consecutive sweeps a figure may not arrive for;
    - `flapping_after_failures`: failed sweeps inside a WINDOW of time before the unreliable notice. Not
      a run, but still a count of sweeps: a faster sweep fails more often in the same outage, so five
      failures in fifteen minutes at 5s is 25s of failure where at 15s it was 75s. Kept as the time of
      failure, it scales like the other two.
    The fourth thing counted in sweeps, `STALE_AFTER_SWEEPS`, is the engine's own and is scaled there,
    with a floor (`engine/health.py`).
    """
    sized = settings.monitor_interval_seconds

    def scaled(count: int) -> int:
        return sweeps_for(count, sized, every_seconds)

    return dataclasses.replace(
        settings,
        degraded_after_failures=scaled(settings.degraded_after_failures),
        flapping_after_failures=scaled(settings.flapping_after_failures),
        quarantine_after_silent_sweeps=scaled(settings.quarantine_after_silent_sweeps),
    )
