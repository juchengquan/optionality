"""The alarm engine. Port of backend/src/engine/sweeper.ts.

One batched call per sweep for the WHOLE watchlist. The dashboard does NOT render those records: it
polls `/quotes` for a live batch of its own, one per poll per open tab (ADR 0010). A row's value and
its 🔔 still come from the same instant — `build_entries` reads the watched figure once and derives
both the fill bar and the bell from it with `is_breached`, this engine's own predicate — but that
instant is the poll's, not the sweep's, so the dashboard's bell may lead or lag what has been sent.
This engine therefore keeps NO cached view of its last batch: a cached pair was built as the
dashboard's path, the dashboard was wired to the live `/quotes` instead, and after three weeks of no
route calling either they were deleted.

WHETHER a reading alarms is `optionality.alarm` and not this file: the threshold rule, the cooldown
that throttles flapping and the cadence a persisting breach re-reminds on are one decision, and it
takes a reading and two knobs rather than a database. What is left here is the engine — getting the
quotes, deciding which rules are evaluable at all, writing the rows and sending the words. Two more
things left with it: how healthy the engine says it is, which is `health.py` and the whole of the
`SweeperPort` the HTTP layer reads, and the Telegram send itself, which is `notify.py` because the
sweep, the health account and `positions.py` all need the same answer about a message that did not
get through.

Nothing here is auto-deleted except an expired monitor past its retention window. A rule the engine
cannot evaluate is quarantined — disabled with a notice, kept for inspection — and never removed.
There are THREE such faults, and the decision in each is `optionality.lifecycle`'s so a notebook can
ask what the next sweep would do without a sweep running (ADR 0017): a contract the Provider does not
recognise (`unknown_contract_verdict`), a figure that never arrives for one it does
(`silence_verdict`), and a row this service cannot hydrate at all (`unreadable_notice`). The first two
are symmetrical in their answer and differ only in how long it takes to be sure. The second used to
be a log line and a `continue`, which is the quietest failure this service had: an alarm that cannot
fire reads exactly like one that is not breached (#167).

**Where the Python differs, and why.**

- **The alarm policy is read here.** The TypeScript takes `alarmPolicy` from the library's domain; the
  Python library leaves it out because it reads the service's Settings (its docstring says so) and
  takes the two knobs directly, so `_alarm_policy` below reads them into the same fields — as
  `health.py` does for the degraded and flapping policies.
- **JavaScript's sort, and JavaScript's `String`.** The batch's codes are sorted by UTF-16 code unit,
  as `Array.prototype.sort` sorts them, where Python's `sorted` compares code points; the two agree on
  every contract code there is and differ past the Basic Multilingual Plane. A record's `code` and the
  Provider's `name` are whatever the Provider sent, so they are made text as `String` makes it.
- **A row a pydantic model refuses is unreadable here** where the TypeScript casts it and sweeps it
  (`hydrate.py`, issue #266): it is quarantined with `unreadable_notice` by the same guard.
- **`catch (err)` is `except Exception`**, never wider: `asyncio.CancelledError` is the loop stopping
  the sweep on the way out of the process, which ends it rather than counting as a failed sweep. An
  error is logged with its stack (`log.exception`, or `exc_info` at warning level), as Node prints one.
- `SweeperDeps` is a frozen dataclass, `silent_sweeps` a dict, and `now` a `None` that means the real
  clock, as `deps.now?.() ?? new Date()` does.
"""

import logging
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from optionality.alarm import AlarmPolicy, AlarmState, alarm_transition
from optionality.js import js_string
from optionality.js import truthy as js_truthy
from optionality.lifecycle import (
    ExpiringMonitor,
    expiry_verdict,
    silence_verdict,
    unknown_contract_verdict,
    unreadable_notice,
)
from optionality.monitor import monitor_leg_codes, monitor_value
from optionality.position import position_leg_codes
from optionality.quote import ByCode

from ..db.open import atomic
from ..db.queries import (
    clear_monitor_links,
    delete_monitor_row,
    find_monitor,
    list_monitors,
    open_positions,
    update_monitor_fields,
)
from ..db.rows import MonitorRow, PositionRow
from ..db.time import from_sql_datetime, to_sql_datetime
from ..db.values import to_sqlite_bool
from ..env import Settings
from ..hydrate import to_monitor, to_position
from ..notify import Notifier, NotifySender, notifier
from ..ports import QuoteFetcher
from ..schemas.monitor import DisabledReason
from .health import SweepHealth, SweepHealthDeps
from .positions import PositionSweepDeps, notice_manage_by, record_samples

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class SweeperDeps:
    db: sqlite3.Connection
    settings: Settings
    fetch_quotes: QuoteFetcher
    send: NotifySender
    now: Callable[[], datetime] | None = None


def _utc_date(when: datetime) -> str:
    """The date a sweep reckons expiry against: the UTC day, as the Python's `utcnow().date()` gave.

    Deliberately NOT the market date, even though `dte` on the dashboard is. The two genuinely differ
    for the hours when New York is a day behind UTC, so a contract can read `dte: 0` while the sweep
    already calls it expired. Carried across unchanged: changing it would mute a monitor on a
    different day from the one the other backend would have, and that is a decision, not a port."""
    return when.astimezone(UTC).date().isoformat()


def _last_alarm_at(monitor: MonitorRow) -> datetime | None:
    return None if monitor["last_alarm_at"] is None else from_sql_datetime(monitor["last_alarm_at"])


def _alarm_policy(settings: Settings) -> AlarmPolicy:
    return AlarmPolicy(cooldown_seconds=settings.alarm_cooldown_seconds, repeat_seconds=settings.alarm_repeat_seconds)


def _js_sorted(codes: set[str]) -> list[str]:
    """`[...codes].sort()`: by UTF-16 code unit, which is the order JavaScript's default sort uses.
    Big-endian UTF-16 bytes compare as the code units they encode."""
    return sorted(codes, key=lambda code: code.encode("utf-16-be", "surrogatepass"))


#: a key a record does not have, which JavaScript reads as `undefined`
_ABSENT = object()


def _js_text(value: object) -> str:
    """`String(value)` for a field of a quote, which is whatever the Provider sent."""
    if value is _ABSENT:
        return "undefined"
    if isinstance(value, str):
        return value
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return js_string(value)
    return str(value)


class MonitorSweeper:
    def __init__(self, deps: SweeperDeps) -> None:
        self._deps = deps
        #: Consecutive sweeps a monitor's figure has failed to arrive for, by monitor id.
        #:
        #: In memory, like everything `health.py` remembers and for its reason: the claim is about a
        #: RUN of sweeps, and a restart genuinely breaks the run — nothing was being swept while the
        #: service was down, so a count carried across it would be about a stretch of time the engine
        #: did not observe. The cost is that a deploy gives a silent rule its N sweeps again, which is
        #: the conservative direction.
        self.silent_sweeps: dict[str, int] = {}
        #: Telling the owner, shared with `health.py` and `positions.py` so one answer about a failed
        #: send serves all three (notify.py).
        self._notify: Notifier = notifier(deps.settings, deps.send)
        #: The engine's account of itself, and the `SweeperPort` the HTTP layer reads (health.py). It
        #: is the sweep's own, rather than a dependency, because nothing else may write to it: a sweep
        #: is the only thing that knows whether a sweep succeeded.
        self.health = SweepHealth(SweepHealthDeps(settings=deps.settings, notify=self._notify, now=self._now))

    def _now(self) -> datetime:
        return self._deps.now() if self._deps.now is not None else datetime.now(UTC)

    # --- the sweep -------------------------------------------------------------------------------
    async def sweep(self) -> None:
        """One sweep, and an honest account of whether it happened.

        The account is the whole point of the wrapper. `_run_sweep` below records success on its LAST
        line, because everything between the batch and that line — quarantine, the alarm loop, the
        samples, the manage-by notices — is work the sweep exists to do, and a sweep that did not do it
        has not succeeded however cleanly the quotes arrived. Success used to be recorded the moment
        the batch came back, which put all of that outside any failure path: a raise reached
        `scheduler`, which logs and returns, and `/health` went on saying `last_sweep_ok: true` and
        `alarms: "active"` with nothing being evaluated. `_stale_for()` cannot see it either, since
        `sweep_at` is stamped at the START of a sweep — one that begins every 15 seconds and raises
        every time is never stale. The watchdog covers a sweep that HANGS, not one that raises.

        It still returns rather than raising: a broken sweep must not kill the loop, which is
        `scheduler`'s rule and the reason its own catch stays where it is.
        """
        try:
            await self._run_sweep()
        except Exception as err:
            log.exception("monitor sweep failed:")
            await self.health.failure(f"the sweep threw: {err}")

    async def _run_sweep(self) -> None:
        db = self._deps.db
        # held as a local as well as on the account: a sweep takes real time, and every date the sweep
        # reckons — expiry, and the samples' market day — must come from ONE instant or a sweep
        # straddling midnight disagrees with itself
        at = self._now()
        self.health.started_sweep(at)
        today = _utc_date(at)

        active = await self._run_expiry_lifecycle(today)
        self._forget_silence_but(active)

        # positions join the batch even when nothing alarms on them: the dashboard values them from
        # this same fetch, and a held position must not read as "—" merely because you happen not to
        # be watching it. This widens the batch only — the alarm loop below still runs over `active`.
        # The rows, not only their codes: the same list is what the samples below are written from, so
        # a Position cannot be in the batch and missing from the record.
        #
        # HYDRATED PER ROW, inside a try. This ran as two bare flatMaps in the TypeScript, so a corrupt
        # row took the whole sweep down — every minute, with the healthy rules never evaluated and no
        # alarm ever sent, which is #81's failure mode through a different door (review 2026-11-01).
        #
        # Filtering here also protects `_quarantine_unknown`, which hydrates again inside a transaction.
        legible: list[MonitorRow] = []
        unreadable: list[MonitorRow] = []
        monitor_codes: list[str] = []
        for monitor in active:
            try:
                monitor_codes.extend(monitor_leg_codes(to_monitor(monitor)))
                legible.append(monitor)
            except Exception:
                log.warning("cannot read monitor %s:", monitor["code"], exc_info=True)
                unreadable.append(monitor)
        if unreadable:
            await self._quarantine_unreadable(unreadable)
        active = legible

        # positions join the batch for the dashboard's sake, so an unreadable one costs its own figures
        # and nothing else. A holding is not a rule and cannot be quarantined; the panel shows the gap.
        #
        # Only those still HELD. A closed holding is kept with its history (ADR 0022), but it is not
        # valued, sampled or told it is due a manage-by: its last sample is the record of how it ended,
        # and a sweep writing one more would rewrite that record with a market it was no longer in.
        position_rows: list[PositionRow] = []
        position_codes: list[str] = []
        for position in open_positions(db):
            try:
                position_codes.extend(position_leg_codes(to_position(position)))
                position_rows.append(position)
            except Exception:
                log.warning("cannot read position %s:", position["name"], exc_info=True)
        codes = _js_sorted({*monitor_codes, *position_codes})
        if not codes:
            await self.health.success()
            return

        try:
            records, bad_codes = await self._deps.fetch_quotes(codes)
        except Exception:
            self.health.fetched(False)
            log.exception("monitor sweep snapshot failed:")
            await self.health.failure()
            return
        self.health.fetched(True, self._now())

        surviving = active
        if bad_codes:
            surviving = await self._quarantine_unknown(active, set(bad_codes))

        by_code: ByCode = {_js_text(r.get("code", _ABSENT)): r for r in records}
        refused = await self._evaluate(surviving, by_code)
        # Both are about POSITIONS, not about alarms. They live here only because this is where the
        # batch is, so they take it as an argument instead (positions.py).
        record_samples(db, position_rows, by_code, at)
        await notice_manage_by(
            PositionSweepDeps(db=db, settings=self._deps.settings, notify=self._notify), position_rows, by_code, at
        )
        # A watchlist evaluated in part is not a swept watchlist. The rules that COULD be evaluated have
        # been, which is what the containment in `_evaluate` buys; saying so here is what stops the
        # rest from going quiet without a word.
        if refused:
            await self.health.failure(f"could not evaluate {', '.join(refused)}")
            return
        await self.health.success()

    def _forget_silence_but(self, active: list[MonitorRow]) -> None:
        """Drop the silence counts of rules this sweep is not evaluating.

        Left behind, the map grows for ever and a rule unmuted weeks later resumes mid-count. Called
        from the sweep rather than from the alarm loop because a sweep with nothing to fetch returns
        before the loop — and that is precisely the sweep after the last rule was deleted.
        """
        sweeping = {m["id"] for m in active}
        for id_ in [i for i in self.silent_sweeps if i not in sweeping]:
            del self.silent_sweeps[id_]

    async def _run_expiry_lifecycle(self, today: str) -> list[MonitorRow]:
        """Mute with a notice on expiry; delete quietly after the grace period.

        Nothing else is ever auto-deleted, and an unknown-contract quarantine is kept for inspection
        rather than removed (CLAUDE.md)."""
        db, settings = self._deps.db, self._deps.settings
        retention = settings.expired_retention_days
        active: list[MonitorRow] = []
        notices: list[str] = []

        def apply() -> None:
            for monitor in list_monitors(db):
                # the decision is `optionality.lifecycle.expiry_verdict` (ADR 0017); this applies it
                verdict = expiry_verdict(
                    ExpiringMonitor(
                        code=monitor["code"], strike_date=monitor["strike_date"], enabled=bool(monitor["enabled"])
                    ),
                    today,
                    retention,
                )
                if verdict.notice is not None:
                    notices.append(verdict.notice)
                if verdict.action == "remove":
                    # the links go FIRST. monitor_positions is not managed for us, and deleting a
                    # linked monitor raises FOREIGN KEY constraint failed — inside the sweep, every
                    # minute, so the alarm engine stops altogether (#81). The Position stays: it is a
                    # holding.
                    clear_monitor_links(db, monitor["id"])
                    delete_monitor_row(db, monitor["id"])
                elif verdict.action == "mute":
                    reason: DisabledReason = "expired"
                    update_monitor_fields(
                        db, monitor["id"], {"enabled": to_sqlite_bool(False), "disabled_reason": reason}
                    )
                elif monitor["enabled"]:
                    active.append(monitor)

        await atomic(db, apply)
        # after the writes have committed, so a failed send cannot roll back a mute
        for text in notices:
            await self._notify(text)
        return active

    async def _quarantine_unreadable(self, rows: list[MonitorRow]) -> None:
        """A row the engine cannot hydrate: disabled with a notice, kept for inspection.

        The same treatment an unknown contract gets, and for the same reason — a rule the engine cannot
        evaluate is quarantined, never deleted (CLAUDE.md).
        """
        db = self._deps.db
        notices: list[str] = []

        def apply() -> None:
            for monitor in rows:
                reason: DisabledReason = "unreadable"
                update_monitor_fields(db, monitor["id"], {"enabled": to_sqlite_bool(False), "disabled_reason": reason})
                # the words are `optionality.lifecycle.unreadable_notice`'s (ADR 0017); this applies it
                notices.append(unreadable_notice(monitor["code"]))

        await atomic(db, apply)
        for text in notices:
            await self._notify(text)

    async def _quarantine_unknown(self, active: list[MonitorRow], bad: set[str]) -> list[MonitorRow]:
        """Disable — never delete — monitors whose contracts the Provider does not recognise. Its twin
        is the silence count in `_evaluate`: the same answer to the other half of "cannot evaluate"."""
        db = self._deps.db
        surviving: list[MonitorRow] = []
        notices: list[str] = []

        def apply() -> None:
            for monitor in active:
                # the decision is `optionality.lifecycle.unknown_contract_verdict` (ADR 0017); this
                # applies it
                verdict = unknown_contract_verdict(to_monitor(monitor), bad)
                if not verdict.quarantine:
                    surviving.append(monitor)
                    continue
                reason: DisabledReason = "unknown-contract"
                update_monitor_fields(db, monitor["id"], {"enabled": to_sqlite_bool(False), "disabled_reason": reason})
                if verdict.notice is not None:
                    notices.append(verdict.notice)

        await atomic(db, apply)
        for text in notices:
            await self._notify(text)
        return surviving

    async def _evaluate(self, monitors: list[MonitorRow], by_code: ByCode) -> list[str]:
        """The alarm loop: a figure per rule, `optionality.alarm`'s verdict on it, the write — and, for
        a rule with no figure to evaluate at all, the count toward quarantine.

        The count lives here rather than beside `_quarantine_unknown` because this is the only place
        that knows a figure did not arrive: the fetch succeeded, the contract was priced, and
        `monitor_value` still answered None.

        Answers the rules this sweep could not evaluate at all, named for the record the caller leaves.
        """
        db, settings = self._deps.db, self._deps.settings
        now = self._now()
        stamp = to_sql_datetime(now)
        notices: list[str] = []
        limit = settings.quarantine_after_silent_sweeps
        refused: list[str] = []

        def apply() -> None:
            for row in monitors:
                # Per ROW, inside the transaction, which is the only place it contains anything: one
                # unreadable row — corrupt `legs`, an unparseable date, a write SQLite refuses — used to
                # abort the whole batch and take every other rule's alarm with it. The rules that can be
                # evaluated are, and the sweep reports itself failed rather than clean.
                #
                # NOT a quarantine. That is reserved for the faults the engine can diagnose, and
                # disabling a rule over a fault nobody has read yet would silence it for a reason that
                # might be a bug in here.
                #
                # Where this row's messages start, so a row that fails takes its own back: it queued a
                # "crossed" the instant before its write was refused, and sending that would announce a
                # breach the database has no record of — which re-announces on every sweep after, since
                # `triggered` never got written.
                mark = len(notices)
                try:
                    monitor = to_monitor(row)
                    value = monitor_value(monitor, by_code)
                    if value is None:
                        # the decision is `optionality.lifecycle.silence_verdict` (ADR 0017); this
                        # applies it
                        verdict = silence_verdict(monitor, set(by_code), self.silent_sweeps.get(row["id"], 0), limit)
                        if verdict.count is None:
                            self.silent_sweeps.pop(row["id"], None)
                        else:
                            self.silent_sweeps[row["id"]] = verdict.count
                        if verdict.quarantine:
                            reason: DisabledReason = "no-figure"
                            update_monitor_fields(
                                db, row["id"], {"enabled": to_sqlite_bool(False), "disabled_reason": reason}
                            )
                        if verdict.notice is not None:
                            notices.append(verdict.notice)
                        else:
                            log.warning(
                                "silent: %s (%s%s)", monitor.code, verdict.count, f"/{limit}" if limit > 0 else ""
                            )
                        continue
                    # it arrived: the run of silence is over, and a run is what the limit counts
                    self.silent_sweeps.pop(row["id"], None)
                    # re-read: the fetch was awaited, and a request may have changed the row in the
                    # meantime
                    current = find_monitor(db, row["id"])
                    if not current:
                        continue
                    # INCLUDING whether it is still on. Harvesting `triggered` and `last_alarm_at` alone
                    # meant muting a flapping rule while a sweep was out got you the message anyway — and
                    # left the flag on, so the eventual unmute re-fired it (review 2026-11-01). Deleted
                    # and muted are the same answer here: this reading is about a rule that is no longer
                    # being watched.
                    if not current["enabled"]:
                        continue

                    changes: dict[str, object] = {"last_value": value, "last_checked_at": stamp}
                    # the Provider's name for the contract where it has one: a combo's code IS its
                    # name, and a single's code is machine-readable rather than something to read on a
                    # phone
                    record = by_code.get(monitor.code)
                    named = None if record is None else record.get("name")
                    name = _js_text(named) if js_truthy(named) else monitor.code
                    # the decision is `optionality.alarm`'s; what is left here is turning it into a row
                    # and a message
                    decision = alarm_transition(
                        monitor,
                        value,
                        name,
                        AlarmState(triggered=current["triggered"] != 0, last_alarm_at=_last_alarm_at(current)),
                        _alarm_policy(settings),
                        now,
                    )
                    if decision.triggered is not None:
                        changes["triggered"] = to_sqlite_bool(decision.triggered)
                    if decision.notice is not None:
                        # one condition, not two: the stamp is the record of having SPOKEN, and moving
                        # it for a message that was never queued is what would mute the next reminder
                        changes["last_alarm_at"] = stamp
                        notices.append(decision.notice)
                    update_monitor_fields(db, row["id"], changes)
                except Exception:
                    del notices[mark:]
                    refused.append(row["code"])
                    log.exception("monitor %s could not be evaluated:", row["code"])

        await atomic(db, apply)
        for text in notices:
            await self._notify(text)
        return refused
