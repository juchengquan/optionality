from datetime import UTC, date, datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from optionality.service.deps import get_session, get_settings, get_sweeper, get_worker
from optionality.service.models import Monitor, Position, monitor_positions
from optionality.service.monitor import WATCHLIST_ORDER, combo_field_error
from optionality.service.position import (
    combined_cost_to_close,
    combined_entry,
    combined_pnl,
)
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
from optionality.service.timefmt import days_to_expiry

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
SweeperDep = Annotated[object, Depends(get_sweeper)]
WorkerDep = Annotated[object, Depends(get_worker)]

UI_FIELDS = [
    "option_delta",
    "mid_price",
    "option_implied_volatility",
    "option_theta",
    "option_vega",
    "option_gamma",
]

# a single-leg monitor on IV is fine; a combo on IV is refused, so the combo form
# must not offer it — see combo_field_error
COMBO_FIELDS = [f for f in UI_FIELDS if not combo_field_error(f)]

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


# %.4g was used for everything, which rendered money as a bare "1" and gamma as
# "-9.351e-05". Prices want a fixed 2dp so decimal points line up under tabular-nums;
# greeks want enough places to never reach scientific notation.
_PLACES = {"delta": 4, "gamma": 6, "theta": 4, "vega": 4, "iv": 2, "mid": 2, "bid": 2, "ask": 2}

_FIELD_LABEL = {
    "option_delta": "delta",
    "option_gamma": "gamma",
    "option_theta": "theta",
    "option_vega": "vega",
    "option_implied_volatility": "IV",
    "mid_price": "mid",
}


def _fmt(value) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.4g}"
    return str(value)


def _fmt_at(value, column: str) -> str:
    """Format a numeric cell at the precision its column deserves."""
    if value is None:
        return "—"
    return f"{float(value):.{_PLACES.get(column, 4)}f}"


def _fill_pct(value, threshold, direction: str, compare: str) -> int | None:
    """How far a value has travelled toward its threshold, 0-100.

    None where the journey has no honest baseline to fill from — a signed negative
    threshold the value must cross from the other side, for instance. A bar that
    sometimes lies is worse than no bar, the same reasoning that makes a partly
    priced combo report nothing rather than a partial sum.
    """
    if value is None or not threshold:
        return None
    metric = abs(value) if compare == "abs" else value
    if metric < 0 or threshold < 0:
        return None
    if direction == "above":
        ratio = metric / threshold
    elif metric > 0:
        ratio = threshold / metric
    else:
        return None
    return max(0, min(100, round(ratio * 100)))


def _quote_rows(quotes: list[dict]) -> list[dict]:
    rows = []
    for q in quotes:
        snap = q["snapshot"] or {}
        sign = "≤" if q["direction"] == "below" else "≥"
        label = _FIELD_LABEL.get(q["field"], q["field"])
        # the mode column read "abs" on every row; name the mode only where it is not the default
        mode = " signed" if q["compare"] == "signed" else ""
        watched = q["combo_value"] if "legs" in q else snap.get(q["field"])
        row = {
            "id": q["id"],
            "contract": snap.get("name") or q["code"],
            "alarm": f"{label} {sign} {q['threshold']}{mode}" + (" 🔔" if q["triggered"] else ""),
            "triggered": q["triggered"],
            "threshold": q["threshold"],
            "compare": q["compare"],
            "is_combo": "legs" in q,
            "name": q["code"],
            "strike_date": q["strike_date"],
            "dte": days_to_expiry(q["strike_date"]),
            "error": q.get("error"),
            "field_column": _FIELD_COLUMN.get(q["field"]),  # the column the alarm actually watches
            "fill": _fill_pct(watched, q["threshold"], q["direction"], q["compare"]),
            "legs": _leg_summary(q["legs"]) if "legs" in q else "",
            "delta": _fmt_at(snap.get("option_delta"), "delta"),
            "gamma": _fmt_at(snap.get("option_gamma"), "gamma"),
            "theta": _fmt_at(snap.get("option_theta"), "theta"),
            "vega": _fmt_at(snap.get("option_vega"), "vega"),
            "iv": _fmt_at(snap.get("option_implied_volatility"), "iv"),
            "mid": _fmt_at(snap.get("mid_price"), "mid"),
            "bid": _fmt_at(snap.get("bid_price"), "bid"),
            "ask": _fmt_at(snap.get("ask_price"), "ask"),
            "last_trade": _fmt(snap.get("update_time")),
        }
        if "legs" in q:
            for greek_field, greek_value in q["combo_greeks"].items():
                if greek_value is not None:
                    row[_FIELD_COLUMN[greek_field]] = _fmt_at(greek_value, _FIELD_COLUMN[greek_field])
            # one column for the monitored field, whatever it is: bid/ask/last-trade never
            # apply to a combo, and the alarm column already names the field
            row["value"] = _fmt_at(q["combo_value"], _FIELD_COLUMN.get(q["field"], "mid"))
        rows.append(row)
    return rows


_REFRESH_PRESETS = (5, 10, 15, 30, 60, 120)


def _refresh_options(settings: Settings) -> list[int]:
    # deliberately NOT clamped to MONITOR_INTERVAL_SECONDS: the sweep decides how fresh the
    # data is, the poll decides how soon the page shows the newest sweep. A poll that just
    # misses a sweep leaves stale-looking data up for nearly two intervals, so a faster poll
    # cuts display latency even though it cannot make the data newer — and it is free, since
    # the page reads the sweep's cache instead of calling OpenD.
    return sorted({settings.ui_refresh_seconds} | set(_REFRESH_PRESETS))


# most alarming first: a vanished contract needs attention, one you muted yourself does not
_DISABLED_GROUPS = (
    ("unknown-contract", "Unknown contract"),
    ("expired", "Expired"),
    ("manual", "Muted by you"),
    (None, "Reason not recorded"),  # rows disabled before the column existed
)


def _retention_note(monitor: Monitor, settings: Settings) -> str:
    """Days left before the sweep deletes this expired monitor.

    The sweep deletes once expiry < today - EXPIRED_RETENTION_DAYS, so the last surviving
    day is expiry + retention: remaining = retention + 1 - days_since_expiry.
    """
    days_gone = (datetime.now(UTC).date() - date.fromisoformat(monitor.strike_date)).days
    remaining = settings.expired_retention_days + 1 - days_gone
    if remaining <= 0:
        return "auto-deletes on the next sweep"
    return f"auto-deletes in {remaining} day{'s' if remaining != 1 else ''}"


def _muted_groups(monitors, settings: Settings) -> list[dict]:
    by_reason: dict[str | None, list[dict]] = {}
    for m in monitors:
        by_reason.setdefault(m.disabled_reason, []).append(
            {
                "id": m.id,
                "code": m.code,
                "field": m.field,
                "threshold": m.threshold,
                "note": _retention_note(m, settings) if m.disabled_reason == "expired" else "",
            }
        )
    return [{"label": label, "rows": by_reason[reason]} for reason, label in _DISABLED_GROUPS if reason in by_reason]


def _refresh_seconds(request: Request, settings: Settings) -> int:
    # viewer preference (cookie) beats the .env default; clamped only to sane bounds
    try:
        return max(5, min(3600, int(request.cookies.get("ui_refresh"))))
    except (TypeError, ValueError):
        return settings.ui_refresh_seconds


def _redirect(request: Request) -> RedirectResponse:
    """Only the refresh selector still reloads: the poll interval lives in #live's
    hx-trigger attribute, which an innerHTML swap of #live cannot rewrite."""
    return RedirectResponse(f"{request.scope.get('root_path', '')}/ui", status_code=303)


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
    rows = _quote_rows(quotes)
    by_code, _stamp = sweeper.cached_records()
    # Entry belongs to the whole holding, so it is offered only against the rule that
    # watches the whole holding. Showing it beside a wing would invite reading that wing's
    # cost against the entire position's credit.
    # a rule may span several Positions — a combined stop over two credit spreads belongs
    # to neither alone
    owned: dict[str, list[Position]] = {}
    scopes: dict[str, str | None] = {}
    for m, p in (
        session.query(Monitor, Position)
        .join(monitor_positions, monitor_positions.c.monitor_id == Monitor.id)
        .filter(Position.id == monitor_positions.c.position_id)
        .all()
    ):
        owned.setdefault(m.id, []).append(p)
        scopes[m.id] = m.scope
    for r in rows:
        positions = owned.get(r["id"], [])
        scope = scopes.get(r["id"])
        # with entry beside it, the value column has to BE the cost to close: reading
        # "entry 3.21, value -1.50, P&L 171" is arithmetic that does not work. The alarm
        # engine still evaluates its own signed sum; only the display is reconciled.
        if positions and r["is_combo"]:
            closing = combined_cost_to_close(positions, by_code, scope)
            r["value"] = _fmt_at(closing, "mid")
            r["fill"] = _fill_pct(closing, r["threshold"], "above", "abs")
        whole = positions if scope == "all" else []
        # a summed credit is not something you can type, so entry is editable only where
        # the rule watches exactly one holding
        r["position_id"] = whole[0].id if len(whole) == 1 else ""
        r["entry"] = _fmt_at(combined_entry(whole), "mid") if whole else ""
        r["pnl"] = _fmt_at(combined_pnl(whole, by_code), "mid") if whole else ""
    return {
        "single_rows": [r for r in rows if not r["is_combo"]],
        "combo_rows": [r for r in rows if r["is_combo"]],
        "muted_groups": _muted_groups(muted, settings),
        "fetched": fetched,
        "sweep_seconds": settings.monitor_interval_seconds,
        "health": health,
        "quotes_error": quotes_error,
        "root_path": request.scope.get("root_path", ""),
    }


def _mutation_response(
    request: Request, session, settings, sweeper, worker, error: str | None = None, reset_form: str | None = None
):
    """The table fragment for #live, plus out-of-band updates for the regions it misses.

    A failed mutation reports the error and leaves the add-form's values alone; only a
    successful one swaps a fresh, empty form back.
    """
    context = _live_context(request, session, settings, sweeper, worker)
    context.update(
        {
            "fields": UI_FIELDS,
            "combo_fields": COMBO_FIELDS,
            "error": error,
            "oob": True,
            "reset_form": None if error else reset_form,
        }
    )
    response = templates.TemplateResponse(request, "ui_mutation.html", context)
    response.headers["Cache-Control"] = "no-store"
    return response


@router.get("")
def ui_dashboard(
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    sweeper: SweeperDep,
    worker: WorkerDep,
):
    context = _live_context(request, session, settings, sweeper, worker)
    context.update(
        {
            "fields": UI_FIELDS,
            "combo_fields": COMBO_FIELDS,
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
    sweeper: SweeperDep,
    worker: WorkerDep,
):
    context = _live_context(request, session, settings, sweeper, worker)
    response = templates.TemplateResponse(request, "ui_table.html", context)
    response.headers["Cache-Control"] = "no-store"
    return response


@router.post("/refresh")
def ui_set_refresh(request: Request, settings: SettingsDep, refresh: Annotated[int, Form()]):
    response = _redirect(request)
    response.set_cookie("ui_refresh", str(max(5, min(3600, refresh))), max_age=31536000, samesite="lax")
    return response


@router.post("/monitors")
def ui_create_monitor(
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    sweeper: SweeperDep,
    worker: WorkerDep,
    strike_date: Annotated[str, Form()],
    option_type: Annotated[str, Form()],
    strike: Annotated[float, Form()],
    threshold: Annotated[float, Form()],
    field: Annotated[str, Form()] = "option_delta",
    direction: Annotated[str, Form()] = "above",
    compare: Annotated[str, Form()] = "abs",
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
        return _mutation_response(request, session, settings, sweeper, worker, error=_error_text(err))
    return _mutation_response(request, session, settings, sweeper, worker, reset_form="monitor")


@router.post("/combos")
async def ui_create_combo(
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    sweeper: SweeperDep,
    worker: WorkerDep,
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
        return _mutation_response(request, session, settings, sweeper, worker, error=_error_text(err))
    return _mutation_response(request, session, settings, sweeper, worker, reset_form="combo")


@router.post("/monitors/{monitor_id}/threshold")
def ui_set_threshold(
    request: Request,
    monitor_id: str,
    session: SessionDep,
    settings: SettingsDep,
    sweeper: SweeperDep,
    worker: WorkerDep,
    threshold: Annotated[float, Form()],
):
    try:
        patch_monitor(monitor_id, MonitorPatch(threshold=threshold), session, settings)
    except (ValidationError, HTTPException) as err:
        return _mutation_response(request, session, settings, sweeper, worker, error=_error_text(err))
    return _mutation_response(request, session, settings, sweeper, worker)


@router.post("/monitors/{monitor_id}/rename")
def ui_rename_monitor(
    request: Request,
    monitor_id: str,
    session: SessionDep,
    settings: SettingsDep,
    sweeper: SweeperDep,
    worker: WorkerDep,
    name: Annotated[str, Form()],
):
    try:
        patch_monitor(monitor_id, MonitorPatch(name=name.strip()), session, settings)
    except (ValidationError, HTTPException) as err:
        return _mutation_response(request, session, settings, sweeper, worker, error=_error_text(err))
    return _mutation_response(request, session, settings, sweeper, worker)


@router.post("/positions/{position_id}/entry")
def ui_set_entry(
    request: Request,
    position_id: str,
    session: SessionDep,
    settings: SettingsDep,
    sweeper: SweeperDep,
    worker: WorkerDep,
    entry: Annotated[float, Form()],
):
    row = session.get(Position, position_id)
    if row is None:
        return _mutation_response(request, session, settings, sweeper, worker, error="position not found")
    row.entry = entry
    session.commit()
    return _mutation_response(request, session, settings, sweeper, worker)


@router.post("/monitors/{monitor_id}/toggle")
def ui_toggle_monitor(
    request: Request,
    monitor_id: str,
    session: SessionDep,
    settings: SettingsDep,
    sweeper: SweeperDep,
    worker: WorkerDep,
):
    row = session.get(Monitor, monitor_id)
    if row is None:
        return _mutation_response(request, session, settings, sweeper, worker, error="monitor not found")
    row.enabled = not row.enabled
    # a re-enabled monitor must not keep a stale reason; the sweep re-quarantines it if the
    # contract is still unknown, which is what makes the unmute badge meaningful
    row.disabled_reason = None if row.enabled else "manual"
    session.commit()
    return _mutation_response(request, session, settings, sweeper, worker)


@router.post("/monitors/{monitor_id}/delete")
def ui_delete_monitor(
    request: Request,
    monitor_id: str,
    session: SessionDep,
    settings: SettingsDep,
    sweeper: SweeperDep,
    worker: WorkerDep,
):
    try:
        delete_monitor(monitor_id, session)
    except HTTPException as err:
        return _mutation_response(request, session, settings, sweeper, worker, error=_error_text(err))
    return _mutation_response(request, session, settings, sweeper, worker)
