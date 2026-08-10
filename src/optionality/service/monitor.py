import logging
from datetime import date, datetime

from sqlalchemy import select

from optionality.apis.aux import build_spx_code
from optionality.core import fetch_snapshot
from optionality.notification.telegram import send_telegram_message
from optionality.service.models import Monitor, utcnow
from optionality.service.settings import Settings
from optionality.service.timefmt import display_time, market_time_to_display

logger = logging.getLogger("optionality.monitor")

# re-arm only after the value falls this fraction below the threshold, so a
# value oscillating right at the line doesn't alarm on every crossing
REARM_HYSTERESIS = 0.05
DEGRADED_AFTER = 5

# display order everywhere the watchlist is listed: CALLs before PUTs, then by expiry, then strike
WATCHLIST_ORDER = (Monitor.option_type, Monitor.strike_date, Monitor.strike)


def monitor_leg_codes(monitor: Monitor) -> list[str]:
    if not monitor.legs:
        return [monitor.code]
    return [build_spx_code(monitor.strike_date, leg["option_type"], leg["strike"]) for leg in monitor.legs]


def combo_field_sum(monitor: Monitor, by_code: dict, field: str) -> float | None:
    """Signed sum of one field over a combo's legs; None if ANY leg is missing — no partial sums, ever."""
    total = 0.0
    for leg, code in zip(monitor.legs, monitor_leg_codes(monitor), strict=True):
        record = by_code.get(code)
        value = record.get(field) if record else None
        if value is None:
            return None
        total += leg["sign"] * value
    return total


def monitor_value(monitor: Monitor, by_code: dict) -> float | None:
    if not monitor.legs:
        record = by_code.get(monitor.code)
        value = record.get(monitor.field) if record else None
        return float(value) if value is not None else None
    return combo_field_sum(monitor, by_code, monitor.field)


# greeks are linear, so signed sums are the greeks OF the combo's value; IV is not additive
COMBO_GREEK_FIELDS = ("option_delta", "option_gamma", "option_theta", "option_vega")


def watchlist_quotes(session_factory, settings: Settings, fetcher=fetch_snapshot, include_combos=False) -> list[dict]:
    """Live snapshot for every enabled monitor — one API call for the whole watchlist.

    Combo entries (include_combos=True) carry their signed-sum under "combo_value" and no
    per-contract snapshot; summing other fields under the combo's signs would fabricate
    plausible-but-wrong aggregates.
    """
    query = select(Monitor).where(Monitor.enabled).order_by(*WATCHLIST_ORDER)
    if not include_combos:
        query = query.where(Monitor.legs.is_(None))
    with session_factory() as session:
        monitors = session.scalars(query).all()
    if not monitors:
        return []
    codes = sorted({code for m in monitors for code in monitor_leg_codes(m)})
    records = fetcher(codes, opend_host=settings.opend_host, opend_port=settings.opend_port)
    fetched_at = display_time(utcnow(), settings.display_tz)
    for record in records:
        if record.get("update_time"):
            record["update_time"] = market_time_to_display(record["update_time"], settings.display_tz)
        record["fetched_at"] = fetched_at  # the honest "data as-of"; update_time is only the last trade
    by_code = {r.get("code"): r for r in records}
    entries = []
    for m in monitors:
        entry = {
            "code": m.code,
            "field": m.field,
            "threshold": m.threshold,
            "direction": m.direction,
            "triggered": m.triggered,
            "last_value": m.last_value,
            "snapshot": None if m.legs else by_code.get(m.code),
        }
        if m.legs:
            entry["legs"] = m.legs
            entry["combo_value"] = monitor_value(m, by_code)
            entry["combo_greeks"] = {f: combo_field_sum(m, by_code, f) for f in COMBO_GREEK_FIELDS}
        entries.append(entry)
    return entries


class MonitorSweeper:
    def __init__(self, session_factory, settings: Settings, fetcher=fetch_snapshot, sender=send_telegram_message):
        self.session_factory = session_factory
        self.settings = settings
        self.fetcher = fetcher
        self.sender = sender
        self.consecutive_failures = 0
        self.last_sweep_at: datetime | None = None
        self.last_sweep_ok: bool | None = None

    def _notify(self, text: str) -> None:
        if not (self.settings.telegram_bot_token and self.settings.telegram_chat_id):
            logger.info("telegram not configured; alarm suppressed: %s", text)
            return
        try:
            self.sender(self.settings.telegram_bot_token, self.settings.telegram_chat_id, text)
        except Exception:
            logger.exception("telegram send failed")

    def sweep(self) -> None:
        self.last_sweep_at = utcnow()
        today = self.last_sweep_at.date()

        with self.session_factory() as session:
            monitors = session.scalars(select(Monitor).where(Monitor.enabled)).all()
            active = []
            for monitor in monitors:
                if date.fromisoformat(monitor.strike_date) < today:
                    monitor.enabled = False
                    logger.info("monitor %s (%s) expired; disabled", monitor.id, monitor.code)
                else:
                    active.append(monitor)
            session.commit()

        if not active:
            self._record_success()
            return

        codes = sorted({code for m in active for code in monitor_leg_codes(m)})
        try:
            records = self.fetcher(codes, opend_host=self.settings.opend_host, opend_port=self.settings.opend_port)
        except Exception:
            logger.exception("monitor sweep snapshot failed")
            self._record_failure()
            return
        self._record_success()

        by_code = {r.get("code"): r for r in records}
        now = utcnow()
        with self.session_factory() as session:
            for monitor in active:
                value = monitor_value(monitor, by_code)
                if value is None:
                    logger.warning("no complete %s for %s in snapshot", monitor.field, monitor.code)
                    continue

                db_monitor = session.get(Monitor, monitor.id)
                db_monitor.last_value = float(value)
                db_monitor.last_checked_at = now

                record = by_code.get(monitor.code)
                name = (record.get("name") if record else None) or monitor.code
                above = monitor.direction != "below"
                breached = abs(value) >= monitor.threshold if above else abs(value) <= monitor.threshold
                if above:
                    rearmed = abs(value) < monitor.threshold * (1 - REARM_HYSTERESIS)
                    breach_word, recover_word = "crossed ≥", "back below"
                else:
                    rearmed = abs(value) > monitor.threshold * (1 + REARM_HYSTERESIS)
                    breach_word, recover_word = "fell ≤", "back above"
                if breached and not db_monitor.triggered:
                    db_monitor.triggered = True
                    self._notify(f"⚠️ {name}: {monitor.field} {value:.3f} {breach_word} {monitor.threshold}")
                elif db_monitor.triggered and rearmed:
                    db_monitor.triggered = False
                    self._notify(f"✅ {name}: {monitor.field} {value:.3f} {recover_word} {monitor.threshold}")
            session.commit()

    def _record_failure(self) -> None:
        self.last_sweep_ok = False
        self.consecutive_failures += 1
        if self.consecutive_failures == DEGRADED_AFTER:
            self._notify(f"⚠️ monitoring degraded: {DEGRADED_AFTER} consecutive sweep failures (OpenD unreachable?)")

    def _record_success(self) -> None:
        if self.consecutive_failures >= DEGRADED_AFTER:
            self._notify("✅ monitoring recovered")
        self.consecutive_failures = 0
        self.last_sweep_ok = True
