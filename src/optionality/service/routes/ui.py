import json
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
from optionality.service.models import Monitor, Position
from optionality.service.monitor import WATCHLIST_ORDER, apply_total_entry, combo_field_error
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


_APP_DIR = _STATIC_DIR / "app"


def _app_assets() -> tuple[str, list[str]]:
    """Vite's manifest names the hashed entry file. Read at request time so a rebuild needs
    no restart, and so a missing bundle fails loudly instead of serving a blank page."""
    manifest = json.loads((_APP_DIR / ".vite" / "manifest.json").read_text())
    entry = next(v for v in manifest.values() if v.get("isEntry"))
    return entry["file"], list(entry.get("css", []))


@static_router.get("/static/app/{path:path}")
def app_asset(path: str):
    """Hashed assets, served by a route for the same reason htmx.min.js is: a StaticFiles
    mount only matches the root_path-prefixed spelling the proxy never sends."""
    root = _APP_DIR.resolve()
    target = (root / path).resolve()
    if root not in target.parents or not target.is_file():
        raise HTTPException(status_code=404, detail="not found")
    # the filename carries a content hash, so this can never go stale
    return FileResponse(target, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@static_router.get("/app")
def react_app(request: Request):
    """The React shell. /ui keeps working; both run until the comparison is settled."""
    root_path = request.scope.get("root_path", "")
    try:
        entry, css = _app_assets()
    except (OSError, StopIteration, ValueError) as err:
        raise HTTPException(status_code=503, detail=f"frontend bundle missing: run make build-ui ({err})") from err
    response = templates.TemplateResponse(
        request,
        "app.html",
        {
            "root_path": root_path,
            "entry": f"{root_path}/static/app/{entry}",
            "css": [f"{root_path}/static/app/{href}" for href in css],
        },
    )
    response.headers["Cache-Control"] = "no-store"
    return response


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

# (key, label) in render order. "contract"/"combo" identify the row and "actions" operates
# it, so neither may be hidden — see the grilling session of 2026-09-24.
SINGLE_COLUMNS = [
    ("contract", "contract"),
    ("alarm", "alarm"),
    ("dte", "dte"),
    ("delta", "delta"),
    ("gamma", "gamma"),
    ("theta", "theta"),
    ("vega", "vega"),
    ("iv", "IV"),
    ("mid", "mid"),
    ("bid", "bid"),
    ("ask", "ask"),
    ("actions", "actions"),
    ("last_trade", "last trade"),
]
COMBO_COLUMNS = [
    ("combo", "combo"),
    ("alarm", "alarm"),
    ("dte", "dte"),
    ("entry", "entry"),
    ("value", "value"),
    ("pnl", "P&L"),
    ("delta", "delta"),
    ("gamma", "gamma"),
    ("theta", "theta"),
    ("vega", "vega"),
    ("actions", "actions"),
]
PROTECTED_COLUMNS = frozenset({"contract", "combo", "actions"})
COLUMN_TABLES = {"single": SINGLE_COLUMNS, "combo": COMBO_COLUMNS}


def _hidden_columns(request: Request, table: str) -> set[str]:
    """Which columns the viewer has hidden. The cookie stores what is HIDDEN, not what is
    kept, so a column added later shows up by default instead of staying invisible."""
    raw = request.cookies.get(f"ui_cols_{table}", "")
    # "." separates rather than ",": a comma makes the cookie value quote-escaped
    # ("a\054b") and it stops round-tripping
    return {c for c in raw.split(".") if c and c not in PROTECTED_COLUMNS}


def _visible_columns(request: Request, table: str, override: dict | None = None) -> list[tuple[str, str]]:
    hidden = override[table] if override and table in override else _hidden_columns(request, table)
    return [(k, label) for k, label in COLUMN_TABLES[table] if k not in hidden]


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


def _quote_rows(quotes: list[dict]) -> list[dict]:
    rows = []
    for q in quotes:
        snap = q["snapshot"] or {}
        sign = "≤" if q["direction"] == "below" else "≥"
        label = _FIELD_LABEL.get(q["field"], q["field"])
        # the mode column read "abs" on every row; name the mode only where it is not the default
        mode = " signed" if q["compare"] == "signed" else ""
        row = {
            "id": q["id"],
            "contract": snap.get("name") or q["code"],
            "alarm": f"{label} {sign} {q['threshold']}{mode}",
            "triggered": q["triggered"],
            "threshold": q["threshold"],
            "compare": q["compare"],
            "is_combo": "legs" in q,
            "name": q["code"],
            "strike_date": q["strike_date"],
            "dte": q["dte"],
            "error": q.get("error"),
            "field_column": _FIELD_COLUMN.get(q["field"]),  # the column the alarm actually watches
            "fill": q["fill"],
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


def _signal_columns(row: dict, visible: set[str]) -> tuple[str, str]:
    """Where a row's fill bar and 🔔 must be drawn, given what is visible.

    Both normally live in hideable cells, so each falls back along a chain ending at the
    protected identity column — a breach or an urgency reading can never be hidden by
    unticking a box.
    """
    identity = "combo" if row["is_combo"] else "contract"
    watched = "value" if row["is_combo"] else row["field_column"]
    for candidate in (watched, "alarm", identity):
        if candidate and candidate in visible:
            fill_col = candidate
            break
    bell_col = "alarm" if "alarm" in visible else identity
    return fill_col, bell_col


def _live_context(request: Request, session, settings, sweeper, worker, columns: dict | None = None) -> dict:
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
    # no records needed here any more: every figure arrives on the entries themselves
    # Entry belongs to the whole holding, so it is offered only against the rule that
    # watches the whole holding. Showing it beside a wing would invite reading that wing's
    # cost against the entire position's credit.
    # the entries already carry cost_to_close, entry and pnl — see build_entries. The route
    # decides only where a figure may be TYPED: a summed credit is not something you can type,
    # so an entry box appears on a rule watching exactly one holding, and a total box on one
    # spanning several while a wing of it is still unrecorded.
    directly_editable = {
        e["positions"][0]["id"] for e in quotes if len(e.get("positions") or []) == 1 and e.get("scope") == "all"
    }
    for r, q in zip(rows, quotes, strict=True):
        positions = q.get("positions") or []
        whole = positions if q.get("scope") == "all" else []
        if positions and r["is_combo"]:
            r["value"] = _fmt_at(q["cost_to_close"], "mid")
        r["position_id"] = whole[0]["id"] if len(whole) == 1 else ""
        unreachable = [p for p in whole if p["id"] not in directly_editable]
        r["combined_id"] = r["id"] if len(whole) > 1 and len(unreachable) == 1 else ""
        r["entry"] = _fmt_at(q["entry"], "mid") if whole else ""
        r["pnl"] = _fmt_at(q["pnl"], "mid") if whole else ""
    single_cols = _visible_columns(request, "single", columns)
    combo_cols = _visible_columns(request, "combo", columns)
    for r in rows:
        visible = {k for k, _ in (combo_cols if r["is_combo"] else single_cols)}
        r["fill_col"], r["bell_col"] = _signal_columns(r, visible)
    return {
        "single_cols": single_cols,
        "combo_cols": combo_cols,
        "single_keys": [k for k, _ in single_cols],
        "combo_keys": [k for k, _ in combo_cols],
        "column_tables": [
            ("single", "Single-leg", SINGLE_COLUMNS, {k for k, _ in single_cols}),
            ("combo", "Combos", COMBO_COLUMNS, {k for k, _ in combo_cols}),
        ],
        "protected_columns": PROTECTED_COLUMNS,
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
    request: Request,
    session,
    settings,
    sweeper,
    worker,
    error: str | None = None,
    reset_form: str | None = None,
    columns: dict | None = None,
):
    """The table fragment for #live, plus out-of-band updates for the regions it misses.

    A failed mutation reports the error and leaves the add-form's values alone; only a
    successful one swaps a fresh, empty form back.
    """
    context = _live_context(request, session, settings, sweeper, worker, columns)
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


@router.post("/monitors/{monitor_id}/entry")
def ui_set_combined_entry(
    request: Request,
    monitor_id: str,
    session: SessionDep,
    settings: SettingsDep,
    sweeper: SweeperDep,
    worker: WorkerDep,
    entry: Annotated[float, Form()],
):
    """Record a total credit across the Positions a rule spans, by deriving the one wing
    whose credit is not yet known. The arithmetic lives in monitor.apply_total_entry, shared
    with the JSON route so the two cannot drift."""
    if error := apply_total_entry(session, monitor_id, entry):
        return _mutation_response(request, session, settings, sweeper, worker, error=error)
    return _mutation_response(request, session, settings, sweeper, worker)


def _column_response(request, session, settings, sweeper, worker, table: str, hidden: set[str], *, repaint=False):
    """repaint sends the pickers back out-of-band. Only "show all" needs it: a single
    click already left its own box in the right state."""
    response = _mutation_response(
        request,
        session,
        settings,
        sweeper,
        worker,
        columns={table: hidden},
        reset_form="columns" if repaint else None,
    )
    response.set_cookie(f"ui_cols_{table}", ".".join(sorted(hidden)), max_age=31536000, samesite="lax")
    return response


@router.post("/columns/{table}")
def ui_set_column(
    request: Request,
    table: str,
    session: SessionDep,
    settings: SettingsDep,
    sweeper: SweeperDep,
    worker: WorkerDep,
    column: Annotated[str, Form()],
    shown: Annotated[str | None, Form()] = None,
):
    """An unchecked box posts no value, so the absence of `shown` IS the hide."""
    if table not in COLUMN_TABLES:
        return _mutation_response(request, session, settings, sweeper, worker, error="unknown table")
    hidden = _hidden_columns(request, table)
    if shown is None:
        hidden.add(column)
    else:
        hidden.discard(column)
    hidden -= PROTECTED_COLUMNS  # identity and actions are never hideable
    return _column_response(request, session, settings, sweeper, worker, table, hidden)


@router.post("/columns/{table}/reset")
def ui_reset_columns(
    request: Request,
    table: str,
    session: SessionDep,
    settings: SettingsDep,
    sweeper: SweeperDep,
    worker: WorkerDep,
):
    if table not in COLUMN_TABLES:
        return _mutation_response(request, session, settings, sweeper, worker, error="unknown table")
    return _column_response(request, session, settings, sweeper, worker, table, set(), repaint=True)


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
