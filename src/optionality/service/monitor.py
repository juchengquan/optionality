import logging
import re
from datetime import UTC, date, datetime

from sqlalchemy import select

from optionality.apis.aux import build_spx_code
from optionality.core import fetch_snapshot
from optionality.notification.telegram import send_telegram_message
from optionality.service.models import Monitor, utcnow
from optionality.service.settings import Settings
from optionality.service.timefmt import display_time, market_time_to_display

logger = logging.getLogger("optionality.monitor")

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

_UNKNOWN_CODE = re.compile(r"Unknown stock\.?\s+([A-Z0-9.]+)")


def fetch_resilient(codes: list[str], settings: Settings, fetcher=fetch_snapshot) -> tuple[list[dict], list[str]]:
    """Batch snapshot that survives unknown contracts.

    moomoo rejects the WHOLE batch when any code is unknown, naming the culprit;
    we drop it and retry so one bad contract can't take the watchlist hostage.
    Any other error (connection, quota) re-raises untouched — containment only
    engages on the deterministic named-culprit case.
    """
    remaining = list(codes)
    bad: list[str] = []
    while remaining:
        try:
            return fetcher(remaining, opend_host=settings.opend_host, opend_port=settings.opend_port), bad
        except Exception as err:
            match = _UNKNOWN_CODE.search(str(err))
            if not match:
                raise
            culprit = match.group(1).rstrip(".")
            hits = [c for c in remaining if c == culprit or c.endswith(culprit)]
            if not hits:
                raise  # can't map the culprit to our codes; treat as generic failure
            for code in hits:
                remaining.remove(code)
                bad.append(code)
            logger.warning("dropping unknown contract from batch: %s", ", ".join(hits))
    return [], bad


def verify_contracts(codes: list[str], settings: Settings, fetcher=fetch_snapshot) -> str | None:
    """Return an error message unless every code is a verified, existing contract."""
    try:
        records, bad = fetch_resilient(codes, settings, fetcher)
    except Exception as err:
        return f"cannot verify contract: OpenD unreachable ({err})"
    if bad:
        return f"contract does not exist: {', '.join(bad)} — check strike and expiry"
    returned = {r.get("code") for r in records}
    missing = [c for c in codes if c not in returned]
    if missing:
        return f"contract does not exist: {', '.join(missing)} — check strike and expiry"
    return None


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
    records, bad_codes = fetch_resilient(codes, settings, fetcher)
    bad_set = set(bad_codes)
    fetched_at = display_time(utcnow(), settings.display_tz)
    for record in records:
        if record.get("update_time"):
            record["update_time"] = market_time_to_display(record["update_time"], settings.display_tz)
        record["fetched_at"] = fetched_at  # the honest "data as-of"; update_time is only the last trade
    by_code = {r.get("code"): r for r in records}
    entries = []
    for m in monitors:
        entry = {
            "id": m.id,
            "code": m.code,
            "field": m.field,
            "threshold": m.threshold,
            "direction": m.direction,
            "compare": m.compare,
            "triggered": m.triggered,
            "last_value": m.last_value,
            "snapshot": None if m.legs else by_code.get(m.code),
        }
        if m.legs:
            entry["legs"] = m.legs
            entry["combo_value"] = monitor_value(m, by_code)
            entry["combo_greeks"] = {f: combo_field_sum(m, by_code, f) for f in COMBO_GREEK_FIELDS}
        if bad_set.intersection(monitor_leg_codes(m)):
            entry["error"] = "unknown contract"
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
            records, bad_codes = fetch_resilient(codes, self.settings, self.fetcher)
        except Exception:
            logger.exception("monitor sweep snapshot failed")
            self._record_failure()
            return
        self._record_success()

        if bad_codes:
            active = self._quarantine_unknown(active, set(bad_codes))

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
                # abs mode compares magnitude; signed compares the raw value (negative thresholds legal).
                # the triggered flag flips truthfully at the exact threshold; message flapping is
                # prevented by the per-monitor alarm cooldown, not by a value band
                metric = value if monitor.compare == "signed" else abs(value)
                if above:
                    breached = metric >= monitor.threshold
                    breach_word, recover_word = "crossed ≥", "back below"
                else:
                    breached = metric <= monitor.threshold
                    breach_word, recover_word = "fell ≤", "back above"
                if breached and not db_monitor.triggered:
                    db_monitor.triggered = True
                    if self._alarm_allowed(db_monitor, now):
                        db_monitor.last_alarm_at = now
                        self._notify(f"⚠️ {name}: {monitor.field} {value:.3f} {breach_word} {monitor.threshold}")
                elif db_monitor.triggered and not breached:
                    db_monitor.triggered = False
                    if self._alarm_allowed(db_monitor, now):
                        db_monitor.last_alarm_at = now
                        self._notify(f"✅ {name}: {monitor.field} {value:.3f} {recover_word} {monitor.threshold}")
                elif db_monitor.triggered and breached:
                    # a persisting breach re-alarms on a fixed cadence so it can't be missed once and forgotten
                    repeat = self.settings.alarm_repeat_seconds
                    sign = breach_word.split()[-1]
                    if repeat and self._seconds_since_alarm(db_monitor, now) >= repeat:
                        db_monitor.last_alarm_at = now
                        self._notify(
                            f"⚠️ {name}: {monitor.field} {value:.3f} still {sign} {monitor.threshold} (reminder)"
                        )
            session.commit()

    def _quarantine_unknown(self, active: list[Monitor], bad_set: set[str]) -> list[Monitor]:
        """Disable (never delete) monitors whose contracts moomoo doesn't recognize."""
        surviving = []
        with self.session_factory() as session:
            for monitor in active:
                hits = sorted(bad_set.intersection(monitor_leg_codes(monitor)))
                if not hits:
                    surviving.append(monitor)
                    continue
                session.get(Monitor, monitor.id).enabled = False
                logger.warning("monitor %s (%s) disabled: unknown contract %s", monitor.id, monitor.code, hits)
                self._notify(
                    f"⚠️ monitor {monitor.code} disabled: unknown contract {', '.join(hits)} (delisted or never existed)"
                )
            session.commit()
        return surviving

    def _seconds_since_alarm(self, monitor: Monitor, now: datetime) -> float:
        last = monitor.last_alarm_at
        if last is None:
            return float("inf")
        if last.tzinfo is None:
            last = last.replace(tzinfo=UTC)  # SQLite round-trips lose tzinfo; stored values are UTC
        return (now - last).total_seconds()

    def _alarm_allowed(self, monitor: Monitor, now: datetime) -> bool:
        return self._seconds_since_alarm(monitor, now) >= self.settings.alarm_cooldown_seconds

    def _record_failure(self) -> None:
        self.last_sweep_ok = False
        self.consecutive_failures += 1
        if self.consecutive_failures == self.settings.degraded_after_failures:
            self._notify(
                f"⚠️ monitoring degraded: {self.consecutive_failures} consecutive sweep failures (OpenD unreachable?)"
            )

    def _record_success(self) -> None:
        if self.consecutive_failures >= self.settings.degraded_after_failures:
            self._notify("✅ monitoring recovered")
        self.consecutive_failures = 0
        self.last_sweep_ok = True
