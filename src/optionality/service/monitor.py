import logging
from datetime import date, datetime

from sqlalchemy import select

from optionality.core import fetch_snapshot
from optionality.notification.telegram import send_telegram_message
from optionality.service.models import Monitor, utcnow
from optionality.service.settings import Settings

logger = logging.getLogger("optionality.monitor")

# re-arm only after the value falls this fraction below the threshold, so a
# value oscillating right at the line doesn't alarm on every crossing
REARM_HYSTERESIS = 0.05
DEGRADED_AFTER = 5


def watchlist_quotes(session_factory, settings: Settings, fetcher=fetch_snapshot) -> list[dict]:
    """Live snapshot for every enabled monitor — one API call for the whole watchlist."""
    with session_factory() as session:
        monitors = session.scalars(select(Monitor).where(Monitor.enabled).order_by(Monitor.created_at)).all()
    if not monitors:
        return []
    codes = list({m.code for m in monitors})
    records = fetcher(codes, opend_host=settings.opend_host, opend_port=settings.opend_port)
    by_code = {r.get("code"): r for r in records}
    return [
        {
            "code": m.code,
            "field": m.field,
            "threshold": m.threshold,
            "triggered": m.triggered,
            "last_value": m.last_value,
            "snapshot": by_code.get(m.code),
        }
        for m in monitors
    ]


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

        codes = list({m.code for m in active})
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
                record = by_code.get(monitor.code)
                value = record.get(monitor.field) if record else None
                if value is None:
                    logger.warning("no %s for %s in snapshot", monitor.field, monitor.code)
                    continue

                db_monitor = session.get(Monitor, monitor.id)
                db_monitor.last_value = float(value)
                db_monitor.last_checked_at = now

                name = record.get("name") or monitor.code
                if abs(value) >= monitor.threshold and not db_monitor.triggered:
                    db_monitor.triggered = True
                    self._notify(f"⚠️ {name}: {monitor.field} {value:.4f} crossed ≥ {monitor.threshold}")
                elif db_monitor.triggered and abs(value) < monitor.threshold * (1 - REARM_HYSTERESIS):
                    db_monitor.triggered = False
                    self._notify(f"✅ {name}: {monitor.field} {value:.4f} back below {monitor.threshold}")
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
