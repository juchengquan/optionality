"""What the API accepts for the service's own settings (#442, ADR 0025): the sweep's interval, and
nothing else — it is the ONE behaviour knob kept in the database. Port of backend/src/schemas/settings.ts.

A preset or null, and the key REQUIRED: null is a choice ("back to .env's interval"), so a body that
forgot the key must not read as one. Anything else is zod's 422, which the page shows.

**Where the Python differs, and why.** zod's `z.literal(SWEEP_PRESETS).nullable()` is an `Enum` over
`SweepSeconds`, `.nullish()`, with no default: an absent key is checked as `undefined` and refused with
the same "Invalid option" zod gives it, and an explicit null passes.
"""

from typing import Annotated

from optionality.cadence import SweepSeconds

from .zod import Enum, Shape


class SettingsPatch(Shape):
    #: 5, 10, 15, 30 or 60 seconds, or None for `.env`'s MONITOR_INTERVAL_SECONDS
    sweep_seconds: Annotated[SweepSeconds | None, Enum().nullish()]
