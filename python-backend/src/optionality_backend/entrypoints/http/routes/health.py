"""`/health`, the one route that needs no token (ADR 0009, phase 5). Port of
backend/src/entrypoints/http/routes/health.ts.

It is what the dashboard's Service panel reads: the database, the Provider and the sweep's state. The
queue and the last run went with the run pipeline in phase 10 (ADR 0014). It carries no
`contract_version` — that and the skew banner it fed went in ADR 0009 phase 8, when the frontend started
taking its types FROM the API (`hc<AppType>`).

Every branch reports rather than raises. A health endpoint that 500s when the database is gone tells you
less than one that says `db: false`.

**Where the Python differs, and why.**

- **The fingerprint is the library's.** The TypeScript reports `GOLDEN_CASES` from its library's
  `golden.ts`; this reports `optionality.GOLDEN_CASES`, the fingerprint of the golden cases the Python
  library was cut against — the maths this backend runs on is that library, so those are the cases it IS.
  `make check-cases` holds the two stamps to one corpus, so they are the same string whenever the gate is
  green. Read through the package's published name at every request, never `optionality._ported`, which
  is private to the library (`tests/test_library_boundary.py`).
- The numbers in `settings` are answered as `float`, zod's `z.number()`, so `21` is spelled `21.0`: the
  same double.
- `alarms` is `ports.AlarmState`, a dataclass, turned into the object the TypeScript answers.
"""

from dataclasses import asdict
from typing import Any

import optionality
from fastapi import APIRouter
from optionality.timefmt import display_time
from pydantic import BaseModel, ConfigDict

from ....db.queries import database_responds
from ..deps import Deps

#: zod's refusals: no coercion between types, and no number that is not finite
_AS_ZOD = ConfigDict(strict=True, allow_inf_nan=False)


class ProviderOut(BaseModel):
    model_config = _AS_ZOD

    name: str
    ok: bool


class AlarmsOut(BaseModel):
    model_config = _AS_ZOD

    label: str
    bad: bool


class MonitorOut(BaseModel):
    model_config = _AS_ZOD

    last_sweep_at: str | None
    last_sweep_ok: bool
    consecutive_failures: float
    alarms: AlarmsOut
    fetched_at: str | None


class SettingsOut(BaseModel):
    model_config = _AS_ZOD

    #: the horizon the dashboard weighs a fill against when it is reading pressure rather than distance —
    #: one definition, because a second copy of 21 in the frontend drifts the first time
    #: EXIT_MANAGE_BY_DTE moves
    manage_by_dte: float
    sweep_seconds: float
    expired_retention_days: float
    display_tz: str


class HealthResponse(BaseModel):
    model_config = _AS_ZOD

    db: bool
    #: Which Provider this deployment reads, and whether it is answering. It was `opend: boolean` until
    #: #169 — the vendor's name on the API contract, which the dashboard then printed whatever was
    #: actually behind the port (ADR 0015).
    provider: ProviderOut
    #: Which golden cases this service IS (ADR 0016). Not for the dashboard: it is for `python/`, whose
    #: port is held to the TypeScript only at the moment it is written. A notebook pins a tag for months;
    #: this is the one thing that tells it the engine has moved since.
    golden_cases: str
    monitor: MonitorOut
    settings: SettingsOut


def health_routes(deps: Deps) -> APIRouter:
    router = APIRouter()

    @router.get("/health", summary="Service health; needs no token", response_model=HealthResponse)
    async def health() -> dict[str, Any]:
        settings, db, sweeper = deps.settings, deps.db, deps.sweeper
        tz = settings.display_tz
        ok = database_responds(db)

        # What the last batch did, falling back to the Provider's own probe only while nothing has been
        # asked for yet. The probe alone was a green light for a gateway this service could not speak
        # to: on 2026-10-16 OpenD held the WEBSOCKET port open and timed out every login, so this read
        # true while every market-data route returned 502. An answered request is the only evidence that
        # matters, and reusing the sweep's costs no extra call (ADR 0010).
        fetched = sweeper.last_fetch_ok()
        answering = fetched if fetched is not None else await deps.provider.reachable()

        return {
            "db": ok,
            "golden_cases": optionality.GOLDEN_CASES,
            "provider": {"name": deps.provider.name, "ok": answering},
            "monitor": {
                "last_sweep_at": display_time(sweeper.last_sweep_at(), tz),
                "last_sweep_ok": sweeper.last_sweep_ok(),
                "consecutive_failures": sweeper.consecutive_failures(),
                "alarms": asdict(sweeper.alarm_state()),
                "fetched_at": display_time(sweeper.last_fetch_at(), tz),
            },
            # knobs a client cannot guess: the sweep cadence the meta line names, and the retention
            # window the muted table counts down to
            "settings": {
                "manage_by_dte": settings.exit_manage_by_dte,
                "sweep_seconds": settings.monitor_interval_seconds,
                "expired_retention_days": settings.expired_retention_days,
                "display_tz": settings.display_tz,
            },
        }

    return router
