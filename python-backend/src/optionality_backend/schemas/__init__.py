"""What the backend publishes as its request shapes (ADR 0014). Port of backend/src/schemas/index.ts.

The REQUEST shapes, which the routes validate with, so that a form cannot disagree with its route
unnoticed; and two vocabularies, lists the service writes from: the reasons the service disables a
monitor for, which the dashboard groups its muted tables by (#167); and `SOURCES`, every vendor a
Reference may name, which the dashboard's "from" box offers.

**Where the Python differs, and why.** The TypeScript's entry is a package export the frontend's suites
import; nothing imports the Python's from outside, so it is the door in name only — the routes reach
the modules behind it, as the TypeScript's do. `zod.py` is behind it and not re-exported: it is how the
schemas refuse, not something they publish.
"""

from .monitor import (
    DISABLED_REASONS,
    ComboMonitorIn,
    DisabledReason,
    MonitorCreateIn,
    MonitorIn,
    MonitorPatch,
    TotalEntryIn,
)
from .position import LegIn, PositionIn, PositionPatch
from .reference import SOURCES, ReferenceIn, Source

__all__ = [
    "DISABLED_REASONS",
    "SOURCES",
    "ComboMonitorIn",
    "DisabledReason",
    "LegIn",
    "MonitorCreateIn",
    "MonitorIn",
    "MonitorPatch",
    "PositionIn",
    "PositionPatch",
    "ReferenceIn",
    "Source",
    "TotalEntryIn",
]
