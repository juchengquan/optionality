import urllib.parse
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from optionality.service.deps import get_session, get_session_factory, get_settings, get_sweeper, get_worker
from optionality.service.models import Monitor, utcnow
from optionality.service.monitor import WATCHLIST_ORDER, watchlist_quotes
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
from optionality.service.timefmt import display_time

router = APIRouter(prefix="/ui", tags=["ui"], include_in_schema=False)
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent.parent / "templates"))

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


def _live_context(request: Request, session, settings, session_factory, sweeper, worker) -> dict:
    quotes, quotes_error = [], None
    try:
        quotes = watchlist_quotes(session_factory, settings, sweeper.fetcher, include_combos=True)
    except Exception as err:  # noqa: BLE001 - dashboard must render even with OpenD down
        quotes_error = str(err)
    fetched = next(
        (q["snapshot"]["fetched_at"] for q in quotes if q.get("snapshot")),
        display_time(utcnow(), settings.display_tz),
    )
    muted = session.scalars(select(Monitor).where(~Monitor.enabled).order_by(*WATCHLIST_ORDER)).all()
    health = {
        "opend": _opend_reachable(settings.opend_host, settings.opend_port),
        "sweep_ok": sweeper.last_sweep_ok,
        "failures": sweeper.consecutive_failures,
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
    session_factory: Annotated[object, Depends(get_session_factory)],
    sweeper: Annotated[object, Depends(get_sweeper)],
    worker: Annotated[object, Depends(get_worker)],
    error: str | None = None,
):
    context = _live_context(request, session, settings, session_factory, sweeper, worker)
    context.update({"fields": UI_FIELDS, "error": error})
    response = templates.TemplateResponse(request, "ui.html", context)
    response.headers["Cache-Control"] = "no-store"
    return response


@router.get("/table")
def ui_table_fragment(
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    session_factory: Annotated[object, Depends(get_session_factory)],
    sweeper: Annotated[object, Depends(get_sweeper)],
    worker: Annotated[object, Depends(get_worker)],
):
    context = _live_context(request, session, settings, session_factory, sweeper, worker)
    response = templates.TemplateResponse(request, "ui_table.html", context)
    response.headers["Cache-Control"] = "no-store"
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
):
    try:
        payload = MonitorIn(
            strike_date=strike_date,
            option_type=option_type,
            strike=strike,
            field=field,
            threshold=threshold,
            direction=direction,
        )
        create_monitor(payload, session, settings)
    except (ValidationError, HTTPException) as err:
        return _redirect(request, error=_error_text(err))
    return _redirect(request)


@router.post("/combos")
async def ui_create_combo(request: Request, session: SessionDep, settings: SettingsDep):
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
        )
        _create_combo(payload, session, settings)
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
