import logging
import re
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select

from optionality.apis.aux import build_spx_code
from optionality.core import fetch_snapshot
from optionality.notification.telegram import send_telegram_message
from optionality.service.models import Monitor, utcnow
from optionality.service.settings import Settings
from optionality.service.timefmt import display_time, market_time_to_display

logger = logging.getLogger("optionality.monitor")

# display order everywhere the watchlist is listed (dashboard, bot /monitors, GET /monitors):
# expiry groups first, combos ahead of the singles inside each (legs IS NULL sorts False->0 first),
# so a condor's legs stay beside its combo row instead of splitting across the CALL and PUT blocks
WATCHLIST_ORDER = (Monitor.strike_date, Monitor.legs.is_(None), Monitor.option_type, Monitor.strike)


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


def enabled_monitors(session_factory, include_combos: bool = False) -> list[Monitor]:
    query = select(Monitor).where(Monitor.enabled).order_by(*WATCHLIST_ORDER)
    if not include_combos:
        query = query.where(Monitor.legs.is_(None))
    with session_factory() as session:
        return list(session.scalars(query).all())


def _display_records(records: list[dict], settings: Settings, fetched_at: datetime) -> dict:
    """Index records by code, with display-tz timestamps stamped on.

    Copies rather than mutates: the sweeper's cached records get rendered on every
    dashboard poll, and market_time_to_display is not idempotent.
    """
    stamped = display_time(fetched_at, settings.display_tz)
    by_code = {}
    for raw in records:
        record = dict(raw)
        if record.get("update_time"):
            record["update_time"] = market_time_to_display(record["update_time"], settings.display_tz)
        record["fetched_at"] = stamped  # the honest "data as-of"; update_time is only the last trade
        by_code[record.get("code")] = record
    return by_code


def build_entries(monitors: list[Monitor], by_code: dict, bad_set: set[str]) -> list[dict]:
    """Watchlist entries for a set of monitors against an already-fetched batch of records.

    Combo entries carry their signed-sum under "combo_value" and no per-contract snapshot;
    summing other fields under the combo's signs would fabricate plausible-but-wrong aggregates.
    """
    entries = []
    for m in monitors:
        entry = {
            "id": m.id,
            "code": m.code,
            "strike_date": m.strike_date,
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


def watchlist_quotes(session_factory, settings: Settings, fetcher=fetch_snapshot, include_combos=False) -> list[dict]:
    """Live snapshot for every enabled monitor — one API call for the whole watchlist.

    Used by the bot's /quotes family, which is a documented live-call exception. The
    dashboard does NOT come through here; it renders MonitorSweeper.cached_quotes().
    """
    monitors = enabled_monitors(session_factory, include_combos)
    if not monitors:
        return []
    codes = sorted({code for m in monitors for code in monitor_leg_codes(m)})
    records, bad_codes = fetch_resilient(codes, settings, fetcher)
    return build_entries(monitors, _display_records(records, settings, utcnow()), set(bad_codes))


class MonitorSweeper:
    def __init__(self, session_factory, settings: Settings, fetcher=fetch_snapshot, sender=send_telegram_message):
        self.session_factory = session_factory
        self.settings = settings
        self.fetcher = fetcher
        self.sender = sender
        self.consecutive_failures = 0
        self.last_sweep_at: datetime | None = None
        self.last_sweep_ok: bool | None = None
        # the last successful batch, kept so the dashboard can render the same instant the
        # alarm engine evaluated instead of fetching a second, slightly different one
        self.last_records: list[dict] = []
        self.last_bad_codes: list[str] = []
        self.last_fetch_at: datetime | None = None

    def alarm_state(self) -> tuple[str, bool]:
        """Human label for the alarm engine's health: (label, is_bad)."""
        if self.last_sweep_ok is None:
            return "starting", False
        if self.last_sweep_ok:
            return "active", False
        n = self.consecutive_failures
        return f"STALLED ({n} failed sweep{'s' if n != 1 else ''})", True

    def cached_quotes(self, include_combos: bool = True) -> tuple[list[dict], str | None]:
        """Watchlist entries built from the LAST SWEEP's records — no OpenD call.

        The dashboard renders these so a row's value and its 🔔 come from one instant:
        `triggered` is written by the sweep, and showing a fresher quote beside it makes
        the alarm engine look wrong when it is not. A monitor created since the last
        sweep has no record yet and renders as "—" until the next one.

        Returns (entries, fetched_display); fetched_display is None before the first sweep.
        """
        monitors = enabled_monitors(self.session_factory, include_combos)
        if self.last_fetch_at is None:
            return build_entries(monitors, {}, set()), None
        by_code = _display_records(self.last_records, self.settings, self.last_fetch_at)
        fetched = display_time(self.last_fetch_at, self.settings.display_tz)
        return build_entries(monitors, by_code, set(self.last_bad_codes)), fetched

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

        # expiry lifecycle: mute with a notice on expiry, delete quietly after the grace period.
        # (nothing else is ever auto-deleted; unknown-contract quarantines are kept for inspection)
        retention = self.settings.expired_retention_days
        cutoff = today - timedelta(days=retention)
        with self.session_factory() as session:
            monitors = session.scalars(select(Monitor)).all()
            active = []
            for monitor in monitors:
                expiry = date.fromisoformat(monitor.strike_date)
                if expiry < cutoff:
                    if monitor.enabled:  # retention=0 path: never got the muted notice
                        self._notify(f"ℹ️ monitor {monitor.code} expired ({monitor.strike_date}) — removed")
                    logger.info("monitor %s (%s) expired %s; deleted", monitor.id, monitor.code, monitor.strike_date)
                    session.delete(monitor)
                elif expiry < today:
                    if monitor.enabled:
                        monitor.enabled = False
                        monitor.disabled_reason = "expired"
                        logger.info("monitor %s (%s) expired; muted", monitor.id, monitor.code)
                        self._notify(
                            f"ℹ️ monitor {monitor.code} expired ({monitor.strike_date}) — muted; "
                            f"auto-removes in {retention} days"
                        )
                elif monitor.enabled:
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
        self.last_records, self.last_bad_codes, self.last_fetch_at = records, bad_codes, utcnow()

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
                disabled = session.get(Monitor, monitor.id)
                disabled.enabled = False
                disabled.disabled_reason = "unknown-contract"
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
