"""What the sweep does about a rule it cannot evaluate, and one whose expiry has passed.

Mirrors backend/src/domain/lifecycle.ts. Ported under ADR 0017, which asked for every decision the
sweep makes to be held by a golden case rather than only the arithmetic underneath it. Both were
branches inside the service's sweeper, tangled with the writes they caused.

Nothing here writes or sends anything: the verdict says what should happen and the service does it.
A notebook can therefore ask "what would the next sweep do to this rule?" without a sweep running —
and the words it answers with are the words the owner would have read.

`retention_days` is passed in rather than read from a policy object, as `exit.ExitPolicy` and the
absent `alarm_policy` are: this package takes its knobs directly.
"""

from datetime import date, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict

from optionality.monitor import Monitor, monitor_leg_codes


def silence_reason(monitor: Monitor, priced: set[str]) -> str:
    """Why a figure did not arrive, in the words the notice uses. Sorted, so the sentence does not
    depend on the order a provider happened to answer in."""
    unpriced = [code for code in monitor_leg_codes(monitor) if code not in priced]
    if unpriced:
        return f"no quote for {', '.join(sorted(unpriced))}"
    return f"no {monitor.field} in the quote"


class SilenceVerdict(BaseModel):
    model_config = ConfigDict(frozen=True)
    #: the run's new length, or None to forget it — forgotten rather than held at the limit, so
    #: unmuting a quarantined rule gives it its full count again
    count: int | None
    quarantine: bool
    #: what to tell the owner, or None while the run is still short enough to be only logged
    notice: str | None


def silence_verdict(monitor: Monitor, priced: set[str], sweeps_so_far: int, limit: int) -> SilenceVerdict:
    """A sweep in which this rule's figure did not arrive.

    A `limit` of 0 only logs, by the invariant: quarantine is OBSERVED, never declared, and what a
    provider serves depends on the account rather than on its code.
    """
    count = sweeps_so_far + 1
    why = silence_reason(monitor, priced)
    if limit > 0 and count >= limit:
        return SilenceVerdict(
            count=None,
            quarantine=True,
            notice=f"⚠️ monitor {monitor.code} disabled: {why} for {count} consecutive sweeps",
        )
    return SilenceVerdict(count=count, quarantine=False, notice=None)


def unreadable_notice(code: str) -> str:
    """The notice for a rule whose ROW the engine could not read at all.

    A notice rather than a verdict, because there is nothing to decide: a row that cannot be
    hydrated cannot be evaluated, so it is always quarantined. What varies is only the sentence.
    """
    return (
        f"⚠️ monitor {code} disabled: its row could not be read "
        "(corrupt legs, or a strike date this service refuses)"
    )


class UnknownContractVerdict(BaseModel):
    model_config = ConfigDict(frozen=True)
    #: the legs this provider does not recognise, sorted — so the sentence does not depend on the
    #: order the structure was entered in
    hits: list[str]
    #: true once ANY leg is unknown: a combo with one delisted leg has no value to compare
    quarantine: bool
    notice: str | None


def unknown_contract_verdict(monitor: Monitor, unknown: set[str]) -> UnknownContractVerdict:
    """A sweep whose batch named some of this rule's contracts as ones the provider does not carry.

    `silence_verdict`'s twin, and the symmetry is the point: the same answer — disable with a
    notice, never delete — to the other half of "cannot evaluate". The asymmetry is in how long it
    takes to be sure. An unknown contract is a fact the provider stated, so one sweep is enough; a
    figure that has not arrived may yet arrive, which is why only that one counts sweeps.
    """
    hits = sorted(code for code in monitor_leg_codes(monitor) if code in unknown)
    if not hits:
        return UnknownContractVerdict(hits=hits, quarantine=False, notice=None)
    return UnknownContractVerdict(
        hits=hits,
        quarantine=True,
        notice=(
            f"⚠️ monitor {monitor.code} disabled: unknown contract {', '.join(hits)} "
            "(delisted or never existed)"
        ),
    )


ExpiryAction = Literal["remove", "mute", "keep"]


class ExpiryVerdict(BaseModel):
    model_config = ConfigDict(frozen=True)
    action: ExpiryAction
    notice: str | None


class ExpiringMonitor(BaseModel):
    """The three fields the decision reads. A whole Monitor would do, but the service hands this
    straight out of a database row and the notebook has no reason to build more than it needs."""

    model_config = ConfigDict(frozen=True)
    code: str
    strike_date: str
    enabled: bool


def expiry_verdict(monitor: ExpiringMonitor, today: str, retention_days: int) -> ExpiryVerdict:
    """What becomes of a monitor whose expiry is behind it.

    Expired monitors are muted with a notice and auto-deleted after the retention window; nothing
    else is ever auto-deleted. `enabled` matters because the notices are about a CHANGE: a rule
    already muted says nothing when it is finally removed, except on the retention=0 path where it
    never got the muted notice in the first place.
    """
    cutoff = add_days(today, -retention_days)
    expiry = monitor.strike_date
    if expiry < cutoff:
        notice = f"ℹ️ monitor {monitor.code} expired ({expiry}) — removed" if monitor.enabled else None
        return ExpiryVerdict(action="remove", notice=notice)
    if expiry < today:
        if not monitor.enabled:
            return ExpiryVerdict(action="keep", notice=None)
        return ExpiryVerdict(
            action="mute",
            notice=(f"ℹ️ monitor {monitor.code} expired ({expiry}) — muted; auto-removes in {retention_days} days"),
        )
    return ExpiryVerdict(action="keep", notice=None)


def add_days(iso_date: str, days: int) -> str:
    """Days added to a market DATE, as text: a monitor expires on a day, not at a moment."""
    return (date.fromisoformat(iso_date) + timedelta(days=days)).isoformat()
