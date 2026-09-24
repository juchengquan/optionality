import logging
import re
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select

from optionality.apis.aux import build_spx_code
from optionality.core import fetch_snapshot
from optionality.notification.telegram import send_telegram_message
from optionality.service.models import Monitor, Position, monitor_positions, utcnow
from optionality.service.position import (
    combined_cost_to_close,
    combined_entry,
    combined_pnl,
    position_leg_codes,
)
from optionality.service.settings import Settings
from optionality.service.timefmt import days_to_expiry, display_time, market_time_to_display

logger = logging.getLogger("optionality.monitor")

# display order everywhere the watchlist is listed (dashboard, bot /monitors, GET /monitors):
# expiry groups first, combos ahead of the singles inside each (legs IS NULL sorts False->0 first),
# so a condor's legs stay beside its combo row instead of splitting across the CALL and PUT blocks
WATCHLIST_ORDER = (Monitor.strike_date, Monitor.legs.is_(None), Monitor.option_type, Monitor.strike)


def monitor_leg_codes(monitor: Monitor) -> list[str]:
    if not monitor.legs:
        return [monitor.code]
    return [build_spx_code(monitor.strike_date, leg["option_type"], leg["strike"]) for leg in monitor.legs]


# IV is intensive, not extensive: two legs at 20% are not a 40% combo, so a signed sum of
# them is a number with no meaning. Combos may not watch these fields, and a row predating
# that rule must still never produce a sum.
NON_ADDITIVE_FIELDS = frozenset({"option_implied_volatility"})


def combo_field_error(field: str) -> str | None:
    """Reason this field cannot be a combo's monitored field, or None if it can."""
    if field in NON_ADDITIVE_FIELDS:
        return f"combos cannot watch {field}: it is not additive across legs"
    return None


def combo_field_sum(monitor: Monitor, by_code: dict, field: str) -> float | None:
    """Signed sum of one field over a combo's legs; None if ANY leg is missing — no partial sums, ever."""
    if combo_field_error(field):
        return None  # guard for legacy rows: never fabricate a summed IV
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


def threshold_fill(value, threshold, direction: str, compare: str) -> int | None:
    """How far a value has travelled toward its threshold, 0-100.

    None where the journey has no honest baseline to fill from — a signed negative threshold
    the value must cross from the other side. A figure that sometimes lies is worse than none,
    the same reasoning that makes a partly priced combo report nothing rather than a part sum.
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


def solely_watched_positions(session) -> set[str]:
    """Positions that some whole-position rule watches alone, and which therefore have an
    entry field of their own. A leg rule links to one Position too but offers no field, so
    counting it would wrongly mark that Position reachable."""
    sole = (
        session.query(monitor_positions.c.monitor_id)
        .group_by(monitor_positions.c.monitor_id)
        .having(func.count(monitor_positions.c.position_id) == 1)
        .subquery()
    )
    return {
        pid
        for (pid,) in session.query(monitor_positions.c.position_id)
        .join(Monitor, Monitor.id == monitor_positions.c.monitor_id)
        .filter(
            Monitor.scope == "all",
            monitor_positions.c.monitor_id.in_(session.query(sole.c.monitor_id)),
        )
        .all()
    }


def apply_total_entry(session, monitor_id: str, total: float) -> str | None:
    """Record a credit taken in across everything a rule spans, by deriving the one wing
    that has no rule of its own — the one that cannot be edited directly.

    Returns an error message, or None on success. Shared by the HTML and JSON routes so the
    two cannot drift, which is how the API rotted away from the dashboard once already.
    """
    positions = (
        session.query(Position)
        .join(monitor_positions, monitor_positions.c.position_id == Position.id)
        .filter(monitor_positions.c.monitor_id == monitor_id)
        .all()
    )
    if not positions:
        return "no holdings attached to this rule"
    editable = solely_watched_positions(session)
    targets = [p for p in positions if p.id not in editable]
    if len(targets) != 1:
        return (
            "every wing here has a rule of its own — set them individually"
            if not targets
            else f"cannot split a total across {len(targets)} wings that have no rule of their own"
        )
    others = [p.entry for p in positions if p.id != targets[0].id]
    if any(e is None for e in others):
        return "set the other wings' credits first"
    targets[0].entry = round(total - sum(others), 4)
    session.commit()
    return None


def positions_for_monitors(session, monitor_ids: list[str]) -> dict[str, list]:
    """Which Positions each Monitor watches. A rule may span several — a combined stop over
    two credit spreads belongs to neither alone."""
    if not monitor_ids:
        return {}
    rows = (
        session.query(monitor_positions.c.monitor_id, Position)
        .filter(
            Position.id == monitor_positions.c.position_id,
            monitor_positions.c.monitor_id.in_(monitor_ids),
        )
        .all()
    )
    owned: dict[str, list] = {}
    for monitor_id, position in rows:
        owned.setdefault(monitor_id, []).append(position)
    for positions in owned.values():
        positions.sort(key=lambda p: p.name)
    return owned


def build_entries(
    monitors: list[Monitor], by_code: dict, bad_set: set[str], owned: dict[str, list] | None = None
) -> list[dict]:
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

        # everything a client needs without re-deriving it: how long the contract has left,
        # which holdings the rule watches, what they cost to close, and how close it is to
        # firing. These used to be computed in routes/ui.py and reachable over no endpoint.
        entry["dte"] = days_to_expiry(m.strike_date)
        positions = (owned or {}).get(m.id, [])
        entry["scope"] = m.scope
        entry["positions"] = [{"id": p.id, "name": p.name} for p in positions]
        entry["cost_to_close"] = combined_cost_to_close(positions, by_code, m.scope) if positions else None
        whole = positions if m.scope == "all" else []
        entry["entry"] = combined_entry(whole) if whole else None
        entry["pnl"] = combined_pnl(whole, by_code) if whole else None

        # a rule backed by a Position is measured on its cost to close, which cannot be
        # negative — so the comparison is always "above"/"abs" regardless of the rule's own
        # mode, matching what the dashboard has shown since the sign reconciliation.
        if positions and m.legs:
            entry["fill"] = threshold_fill(entry["cost_to_close"], m.threshold, "above", "abs")
        else:
            watched = entry.get("combo_value") if m.legs else (entry["snapshot"] or {}).get(m.field)
            entry["fill"] = threshold_fill(watched, m.threshold, m.direction, m.compare)
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
    with session_factory() as session:
        owned = positions_for_monitors(session, [m.id for m in monitors])
    # a Position can hold legs no Monitor names — a rule watching one wing of a condor, say.
    # Without them the cost to close would be a partial sum, so it joins the batch instead.
    codes = sorted(
        {code for m in monitors for code in monitor_leg_codes(m)}
        | {code for ps in owned.values() for p in ps for code in position_leg_codes(p)}
    )
    records, bad_codes = fetch_resilient(codes, settings, fetcher)
    return build_entries(monitors, _display_records(records, settings, utcnow()), set(bad_codes), owned)


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

    def cached_records(self) -> tuple[dict, str | None]:
        """The last sweep's quotes indexed by code, display-stamped.

        Positions read from here too, so everything on the dashboard — a monitor's value,
        a position's cost to close — comes from one instant.
        """
        if self.last_fetch_at is None:
            return {}, None
        return (
            _display_records(self.last_records, self.settings, self.last_fetch_at),
            display_time(self.last_fetch_at, self.settings.display_tz),
        )

    def cached_quotes(self, include_combos: bool = True) -> tuple[list[dict], str | None]:
        """Watchlist entries built from the LAST SWEEP's records — no OpenD call.

        The dashboard renders these so a row's value and its 🔔 come from one instant:
        `triggered` is written by the sweep, and showing a fresher quote beside it makes
        the alarm engine look wrong when it is not. A monitor created since the last
        sweep has no record yet and renders as "—" until the next one.

        Returns (entries, fetched_display); fetched_display is None before the first sweep.
        """
        monitors = enabled_monitors(self.session_factory, include_combos)
        by_code, fetched = self.cached_records()
        with self.session_factory() as session:
            owned = positions_for_monitors(session, [m.id for m in monitors])
        return build_entries(monitors, by_code, set(self.last_bad_codes), owned), fetched

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

        # positions join the batch even when nothing alarms on them: the dashboard values
        # them from this same fetch, and a held position must not read as "—" merely
        # because you happen not to be watching it. Widens the batch only — the alarm
        # loop below still runs over `active` and nothing else.
        with self.session_factory() as session:
            position_codes = {code for p in session.scalars(select(Position)).all() for code in position_leg_codes(p)}

        codes = sorted({code for m in active for code in monitor_leg_codes(m)} | position_codes)
        if not codes:
            self._record_success()
            return

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
