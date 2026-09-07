import urllib.parse
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from optionality.service.deps import get_session, get_settings, get_sweeper, get_worker
from optionality.service.models import Monitor
from optionality.service.monitor import WATCHLIST_ORDER
from optionality.service.routes.health import _opend_reachable
from optionality.service.routes.monitors import (
    ComboMonitorIn,
    MonitorIn,
    MonitorPatch,
    _create_combo,
    create_monitor,
    delete_monitor,
    patch_monitor,
)
from optionality.service.settings import Settings

router = APIRouter(prefix="/ui", tags=["ui"], include_in_schema=False)
static_router = APIRouter(include_in_schema=False)
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))

_STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


# a plain route, NOT a StaticFiles mount: mounts only match the root_path-prefixed
# spelling, which a path-stripping proxy (tailscale serve) never sends
@static_router.get("/static/htmx.min.js")
def htmx_asset():
    return FileResponse(
        _STATIC_DIR / "htmx.min.js",
        media_type="text/javascript",
        headers={"Cache-Control": "public, max-age=86400"},
    )


SessionDep = Annotated[Session, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]

UI_FIELDS = [
    "option_delta",
    "mid_price",
    "option_implied_volatility",
    "option_theta",
    "option_vega",
    "option_gamma",
]

_FIELD_COLUMN = {
    "option_delta": "delta",
    "option_gamma": "gamma",
    "option_theta": "theta",
    "option_vega": "vega",
    "option_implied_volatility": "iv",
    "mid_price": "mid",
}


def _leg_summary(legs: list[dict]) -> str:
    """+C8100 -C8150 -P7900 +P7850 — the signs are what the signed-sum engine keys off,
    so seeing them is how a leg entered backwards gets caught."""
    return " ".join(f"{'+' if leg['sign'] > 0 else '-'}{leg['option_type'][0]}{leg['strike']:g}" for leg in legs)


def _fmt(value) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.4g}"
    return str(value)


def _quote_rows(quotes: list[dict]) -> list[dict]:
    rows = []
    for q in quotes:
        snap = q["snapshot"] or {}
        sign = "≤" if q["direction"] == "below" else "≥"
        row = {
            "id": q["id"],
            "contract": snap.get("name") or q["code"],
            "alarm": f"{q['field']} {sign} {q['threshold']}" + (" 🔔" if q["triggered"] else ""),
            "triggered": q["triggered"],
            "threshold": q["threshold"],
            "compare": q["compare"],
            "is_combo": "legs" in q,
            "name": q["code"],
            "strike_date": q["strike_date"],
            "error": q.get("error"),
            "field_column": _FIELD_COLUMN.get(q["field"]),  # the column the alarm actually watches
            "legs": _leg_summary(q["legs"]) if "legs" in q else "",
            "delta": _fmt(snap.get("option_delta")),
            "gamma": _fmt(snap.get("option_gamma")),
            "theta": _fmt(snap.get("option_theta")),
            "vega": _fmt(snap.get("option_vega")),
            "iv": _fmt(snap.get("option_implied_volatility")),
            "mid": _fmt(snap.get("mid_price")),
            "bid": _fmt(snap.get("bid_price")),
            "ask": _fmt(snap.get("ask_price")),
            "last_trade": _fmt(snap.get("update_time")),
        }
        if "legs" in q:
            for greek_field, greek_value in q["combo_greeks"].items():
                if greek_value is not None:
                    row[_FIELD_COLUMN[greek_field]] = _fmt(greek_value)
            column = _FIELD_COLUMN.get(q["field"])
            if column and q["combo_value"] is not None:
                row[column] = _fmt(q["combo_value"])
        rows.append(row)
    return rows


_REFRESH_PRESETS = (5, 10, 15, 30, 60, 120)


def _refresh_options(settings: Settings) -> list[int]:
    # the page renders the last sweep, so polling faster than MONITOR_INTERVAL_SECONDS
    # would redraw identical data while implying it were fresh
    floor = settings.monitor_interval_seconds
    return sorted({floor} | {opt for opt in _REFRESH_PRESETS if opt >= floor})


def _refresh_seconds(request: Request, settings: Settings) -> int:
    # viewer preference (cookie) beats the .env default; never faster than the sweep behind it
    floor = settings.monitor_interval_seconds
    try:
        return max(floor, min(3600, int(request.cookies.get("ui_refresh"))))
    except (TypeError, ValueError):
        return max(floor, settings.ui_refresh_seconds)


def _redirect(request: Request, error: str | None = None) -> RedirectResponse:
    url = f"{request.scope.get('root_path', '')}/ui"
    if error:
        url += "?error=" + urllib.parse.quote(error)
    return RedirectResponse(url, status_code=303)


def _error_text(err: Exception) -> str:
    if isinstance(err, HTTPException):
        return str(err.detail)
    if isinstance(err, ValidationError):
        first = err.errors()[0]
        location = ".".join(str(part) for part in first["loc"])
        return f"{location}: {first['msg']}"
    return str(err)


def _live_context(request: Request, session, settings, sweeper, worker) -> dict:
    quotes, fetched, quotes_error = [], None, None
    try:
        # the sweep's records, not a fetch of our own: the value and the 🔔 beside it
        # must come from the same instant. fetched is None until the first sweep lands.
        quotes, fetched = sweeper.cached_quotes(include_combos=True)
    except Exception as err:  # noqa: BLE001 - dashboard must render even when the sweep is broken
        quotes_error = str(err)
    muted = session.scalars(select(Monitor).where(~Monitor.enabled).order_by(*WATCHLIST_ORDER)).all()
    alarms_label, alarms_bad = sweeper.alarm_state()
    health = {
        "opend": _opend_reachable(settings.opend_host, settings.opend_port),
        "alarms": alarms_label,
        "alarms_bad": alarms_bad,
        "queue": worker.queue_depth(),
    }
    return {
        "rows": _quote_rows(quotes),
        "muted": muted,
        "fetched": fetched,
        "health": health,
        "quotes_error": quotes_error,
        "root_path": request.scope.get("root_path", ""),
    }


@router.get("")
def ui_dashboard(
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    sweeper: Annotated[object, Depends(get_sweeper)],
    worker: Annotated[object, Depends(get_worker)],
    error: str | None = None,
):
    context = _live_context(request, session, settings, sweeper, worker)
    context.update(
        {
            "fields": UI_FIELDS,
            "error": error,
            "refresh_seconds": _refresh_seconds(request, settings),
            "refresh_options": _refresh_options(settings),
        }
    )
    response = templates.TemplateResponse(request, "ui.html", context)
    response.headers["Cache-Control"] = "no-store"
    return response


@router.get("/table")
def ui_table_fragment(
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    sweeper: Annotated[object, Depends(get_sweeper)],
    worker: Annotated[object, Depends(get_worker)],
):
    context = _live_context(request, session, settings, sweeper, worker)
    response = templates.TemplateResponse(request, "ui_table.html", context)
    response.headers["Cache-Control"] = "no-store"
    return response


@router.post("/refresh")
def ui_set_refresh(request: Request, settings: SettingsDep, refresh: Annotated[int, Form()]):
    response = _redirect(request)
    clamped = max(settings.monitor_interval_seconds, min(3600, refresh))
    response.set_cookie("ui_refresh", str(clamped), max_age=31536000, samesite="lax")
    return response


@router.post("/monitors")
def ui_create_monitor(
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    strike_date: Annotated[str, Form()],
    option_type: Annotated[str, Form()],
    strike: Annotated[float, Form()],
    threshold: Annotated[float, Form()],
    field: Annotated[str, Form()] = "option_delta",
    direction: Annotated[str, Form()] = "above",
    compare: Annotated[str, Form()] = "abs",
    sweeper: Annotated[object, Depends(get_sweeper)] = None,
):
    try:
        payload = MonitorIn(
            strike_date=strike_date,
            option_type=option_type,
            strike=strike,
            field=field,
            threshold=threshold,
            direction=direction,
            compare=compare,
        )
        create_monitor(payload, session, settings, sweeper)
    except (ValidationError, HTTPException) as err:
        return _redirect(request, error=_error_text(err))
    return _redirect(request)


@router.post("/combos")
async def ui_create_combo(
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    sweeper: Annotated[object, Depends(get_sweeper)] = None,
):
    form = await request.form()
    try:
        legs = []
        for i in range(1, 7):
            strike_raw = (form.get(f"strike_{i}") or "").strip()
            if not strike_raw:
                continue
            legs.append(
                {
                    "sign": 1 if form.get(f"sign_{i}") == "+" else -1,
                    "option_type": form.get(f"option_type_{i}"),
                    "strike": float(strike_raw),
                }
            )
        payload = ComboMonitorIn(
            name=form.get("name", ""),
            strike_date=form.get("strike_date", ""),
            legs=legs,
            field=form.get("field", "mid_price"),
            threshold=float(form.get("threshold", "0")),
            direction=form.get("direction", "above"),
            compare=form.get("compare", "abs"),
        )
        _create_combo(payload, session, settings, sweeper)
    except (ValidationError, HTTPException, ValueError) as err:
        return _redirect(request, error=_error_text(err))
    return _redirect(request)


@router.post("/monitors/{monitor_id}/threshold")
def ui_set_threshold(
    request: Request,
    monitor_id: str,
    session: SessionDep,
    settings: SettingsDep,
    threshold: Annotated[float, Form()],
):
    try:
        patch_monitor(monitor_id, MonitorPatch(threshold=threshold), session, settings)
    except (ValidationError, HTTPException) as err:
        return _redirect(request, error=_error_text(err))
    return _redirect(request)


@router.post("/monitors/{monitor_id}/rename")
def ui_rename_monitor(
    request: Request,
    monitor_id: str,
    session: SessionDep,
    settings: SettingsDep,
    name: Annotated[str, Form()],
):
    try:
        patch_monitor(monitor_id, MonitorPatch(name=name.strip()), session, settings)
    except (ValidationError, HTTPException) as err:
        return _redirect(request, error=_error_text(err))
    return _redirect(request)


@router.post("/monitors/{monitor_id}/toggle")
def ui_toggle_monitor(request: Request, monitor_id: str, session: SessionDep):
    row = session.get(Monitor, monitor_id)
    if row is None:
        return _redirect(request, error="monitor not found")
    row.enabled = not row.enabled
    session.commit()
    return _redirect(request)


@router.post("/monitors/{monitor_id}/delete")
def ui_delete_monitor(request: Request, monitor_id: str, session: SessionDep):
    try:
        delete_monitor(monitor_id, session)
    except HTTPException as err:
        return _redirect(request, error=_error_text(err))
    return _redirect(request)
