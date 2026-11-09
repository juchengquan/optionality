"""The alarm engine's one door. Port of backend/src/engine/index.ts.

Three modules behind it — `sweeper.py` (the sweep), `health.py` (the account of itself that
`/health` reads) and `scheduler.py` (the loop and its watchdog) — and `__main__` is the only thing
outside that needs any of them. `tests/test_seams.py` holds that, as `check-seams` holds it for the
TypeScript, so a route or a bot command cannot start a sweep — they get the `SweeperPort` in `deps`,
which is `health.py`'s and read-only.

What is deliberately NOT exported
---------------------------------

`SweepHealth` itself. This is the one line in the file doing work, so it is worth saying why.

#230's mutation sweep left a hole open in the TypeScript: replacing `sweeper: sweeper.health` in
`main.ts` with a freshly constructed `SweepHealth` typechecked and passed all 143 route, app and boot
tests, and the service it describes is one whose `/health` reports "starting" for ever while the
sweeps run. Nothing caught it, and catching it needed a boot test that sweeps, which needs a fake
provider in production code — worse than the hole.

Not exporting the class closes it instead. A second health account cannot be built from outside,
because the only way to name the class is to reach past this door, and the seam refuses that. The
engine constructs exactly one, inside `MonitorSweeper`, and hands it out as `sweeper.health`. That is
the difference between a mistake nobody has made yet and a mistake nobody can write.

`notify.py` is not in here either, and for a duller reason: `engine/positions.py` uses it for the
manage-by notice, so it is not the engine's. Giving it a pass through this door would be the first
exception, and exceptions are how these guards rot.

**Where the Python differs, and why.** Leaving a name out of a door holds nothing by itself in Python:
`optionality_backend.engine.health.SweepHealth` is one import away, and a submodule is even handed
out through this package's own namespace. So the rule is two halves, both in `tests/test_seams.py`:
this `__all__` withholds the class (under any name), and the seam lint refuses every spelling of a
reach past it from outside the engine and its tests. `SweepWatchdog` is exported where the
TypeScript exports nothing: there `main.ts` passes an object literal the compiler checks by shape,
and here `__main__` builds the record by name. `SweeperDeps` is a record built by name for the same
reason, where the TypeScript exports it as a type.
"""

from .health import STALE_AFTER_SWEEPS
from .scheduler import Scheduler, SweepWatchdog
from .sweeper import MonitorSweeper, SweeperDeps

__all__ = ["STALE_AFTER_SWEEPS", "MonitorSweeper", "Scheduler", "SweepWatchdog", "SweeperDeps"]
