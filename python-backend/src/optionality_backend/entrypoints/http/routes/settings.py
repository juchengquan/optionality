"""`/settings` — the service's own settings, as the page sets them (#442, ADR 0025). Port of
backend/src/entrypoints/http/routes/settings.ts.

One knob: the sweep's interval. Every other behaviour knob lives in `.env` (CLAUDE.md), and this one's
default still does — MONITOR_INTERVAL_SECONDS — so a PATCH chooses a preset or null, and null goes back
to it. Paired with `sweep_interval.py`, which does the work. No GET: what is in force is `/health`'s
`settings`, which the page already reads and which needs no token.

Applied at the next sweep with no restart, because the engine ASKS for the interval at every tick rather
than being told — a route may not reach the engine (`tests/test_seams.py`), and does not need to.

**Where the Python differs, and why.** The numbers are answered as `float`, zod's `z.number()`, as
`/health`'s are: the same double.
"""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from optionality.cadence import SWEEP_PRESETS
from pydantic import BaseModel, ConfigDict

from ....schemas.settings import SettingsPatch
from ....sweep_interval import SweepInterval, choose_sweep_interval
from ..deps import Deps
from ..validate import valid

#: zod's refusals: no coercion between types, and no number that is not finite
_AS_ZOD = ConfigDict(strict=True, allow_inf_nan=False)


class SweepSettings(BaseModel):
    """The sweep's interval as the page needs it: what is in force, where it came from, the default a
    "back to .env" choice returns to, and what may be chosen. `/health` carries the same four."""

    model_config = _AS_ZOD

    #: the interval the engine sweeps at now
    sweep_seconds: float
    #: "settings" when the page chose it, "env" when it is `.env`'s MONITOR_INTERVAL_SECONDS
    sweep_source: Literal["settings", "env"]
    #: `.env`'s interval: what null goes back to
    sweep_default_seconds: float
    #: the intervals the page may choose, from one definition (`optionality.cadence`)
    sweep_presets: list[float]


def sweep_settings(at: SweepInterval) -> dict[str, Any]:
    return {
        "sweep_seconds": at.seconds,
        "sweep_source": at.source,
        "sweep_default_seconds": at.default_seconds,
        "sweep_presets": list(SWEEP_PRESETS),
    }


def settings_routes(deps: Deps) -> APIRouter:
    router = APIRouter()

    @router.patch(
        "",
        summary="Set the sweep's interval, or null for MONITOR_INTERVAL_SECONDS; in force at the next sweep",
        response_model=SweepSettings,
    )
    async def patch(given: Annotated[SettingsPatch, Depends(valid("json", SettingsPatch))]) -> dict[str, Any]:
        at = choose_sweep_interval(deps.db, deps.settings, given.sweep_seconds, deps.now())
        return sweep_settings(at)

    return router
