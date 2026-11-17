"""The sweep's interval as the page sets it, and what becomes of a knob counted in sweeps (#442).
Mirrors typescript/src/domain/cadence.ts.

The owner's decision, 2026-11-17 (ADR 0025): `DEGRADED_AFTER_FAILURES` (5) and
`QUARANTINE_AFTER_SILENT_SWEEPS` (10) were sized at the .env interval, 15s — 75s and 150s. Left as
counts, a 5s sweep would call monitoring degraded after 25s and quarantine a rule after 50s, the
faster sweep checking more often AND judging sooner. So every knob counted in sweeps keeps its TIME,
as sized at the .env interval, and its count follows the interval in force.

Rounded UP: a time that is not a whole number of sweeps becomes the next whole one, so a knob is
never judged in less time than it was sized for — at 60s, five failures at 15s (75s) are two sweeps
(120s), never one (60s). A count of 0, which turns its knob off, stays 0.
"""

import math
from typing import Literal

#: The intervals the page offers, in seconds. Nothing below 5: each sweep is one moomoo snapshot
#: call, limited to 60 per 30s and shared with every open page's polls.
SWEEP_PRESETS = (5, 10, 15, 30, 60)
type SweepSeconds = Literal[5, 10, 15, 30, 60]


def is_sweep_preset(value: object) -> bool:
    """Whether a value is one of the presets — a number, never the text of one, and never a boolean,
    which JavaScript's `typeof` does not call a number. The database is read through this, because a
    hand-edited row is the one way a value the route refuses gets in."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return value in SWEEP_PRESETS


def sweeps_for(count: float, sized_at_seconds: float, every_seconds: float) -> int:
    """A knob counted in sweeps, sized at `sized_at_seconds`, as a count at `every_seconds`: the same
    time, rounded up to a whole sweep."""
    return math.ceil((count * sized_at_seconds) / every_seconds)
