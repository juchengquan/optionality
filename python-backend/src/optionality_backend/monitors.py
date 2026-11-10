"""Monitor operations that are more than a query (ADR 0009, phase 5). Port of backend/src/monitors.ts.

The non-sweeper half of the old Python's monitor.py; the sweeper itself is the engine's.

**Where the Python differs, and why.**

- **A total is summed left to right, by hand.** The TypeScript reduces the other wings' credits with
  `+` from 0; Python's `sum` of floats has compensated for rounding since 3.12, and would write a
  different last digit into a credit the owner reads back.
- **Hydrating validates** (`hydrate.py`, issue #266): a row the TypeScript would cast and carry is
  refused here, where it is read. The watchlist's and the links' callers meet it as a raise.
- `watchlist_quotes`' options are keyword arguments, and `now` defaults to None, which means now.
"""

import logging
import sqlite3
from datetime import UTC, datetime

from optionality.exit import ExitPolicy
from optionality.monitor import monitor_leg_codes
from optionality.position import Position, positions_holding
from optionality.quote import display_records, round4

from .db.open import atomic
from .db.queries import (
    enabled_monitors,
    link_monitor_to_positions,
    open_positions,
    orphan_monitors,
    positions_for_monitor,
    positions_for_monitors,
    set_monitor_scope,
    set_position_entry,
    solely_watched_positions,
    update_monitor_fields,
)
from .db.rows import MonitorRow
from .hydrate import to_monitor, to_position
from .ports import QuoteFetcher
from .watchlist import MonitorForEntry, WatchlistEntry, build_entries, codes_for

log = logging.getLogger(__name__)


def link_to_positions(db: sqlite3.Connection, monitor_id: str, contracts: list[str]) -> None:
    """Attach a new Monitor to whatever Position already holds its contracts.

    Without this a monitor created through the API is linked to nothing, and everything the Position
    work built — entry, P&L, the derived total — applies only to monitors that predate the migration
    which backfilled these rows. See `positions_holding` for the two cases that deliberately link
    nothing: a contract nothing holds, and a contract something holds twice.
    """
    # only what is still held: a rule watching a contract of a closed holding watches an option, not a
    # holding anyone has any more (ADR 0022)
    positions = [to_position(r) for r in open_positions(db)]
    holding = positions_holding(positions, contracts)
    if not holding.found:
        return
    update_monitor_fields(db, monitor_id, {"scope": holding.scope})
    link_monitor_to_positions(db, monitor_id, list(holding.found))


async def apply_total_entry(db: sqlite3.Connection, monitor_id: str, total: float) -> str | None:
    """Record a credit taken in across everything a rule spans, by deriving the one wing that has no
    rule of its own — the one that cannot be edited directly.

    Returns an error message, or None on success. The per-wing credits stay the single source of truth:
    the total is a way of REACHING them, not a second place to keep them, so the two can never
    disagree.
    """
    positions = positions_for_monitor(db, monitor_id)
    if not positions:
        return "no holdings attached to this rule"
    editable = solely_watched_positions(db)
    targets = [p for p in positions if p["id"] not in editable]
    if len(targets) != 1:
        return (
            "every wing here has a rule of its own — set them individually"
            if not targets
            else f"cannot split a total across {len(targets)} wings that have no rule of their own"
        )
    target = targets[0]
    others = [p["entry"] for p in positions if p["id"] != target["id"]]
    rest = 0.0
    for credit in others:
        if credit is None:
            return "set the other wings' credits first"
        rest += credit
    entry = round4(total - rest)
    await atomic(db, lambda: set_position_entry(db, target["id"], entry))
    return None


def _for_entry(row: MonitorRow) -> MonitorForEntry:
    """A monitor row in the shape `build_entries` needs — which no longer includes the engine's
    `triggered` or `last_value`. An entry describes the row as of the batch it is built from, and those
    two describe the last sweep (ADR 0010)."""
    return MonitorForEntry(**dict(to_monitor(row)), scope=row["scope"])


async def watchlist_quotes(
    db: sqlite3.Connection,
    display_tz: str,
    fetch: QuoteFetcher,
    *,
    policy: ExitPolicy,
    include_combos: bool = False,
    now: datetime | None = None,
) -> list[WatchlistEntry]:
    """Live quotes for every enabled monitor — one call for the whole watchlist.

    Used by the bot's `/quotes` family AND by the dashboard, which polls it. The TypeScript's comment
    said the opposite for as long as the route existed: that the dashboard rendered the sweeper's
    cached records instead. It never did, and the sweeper's cached view has since been deleted for
    exactly that reason. The owner ratified the live reading in ADR 0010, so a row's figures come from
    THIS call and its bell is derived from them rather than from the engine's stored verdict.

    `policy` has no default, so a caller that would silently produce entries with no schedule fails
    instead (ADR 0011).
    """
    rows = enabled_monitors(db, include_combos)
    if not rows:
        return []
    monitors = [_for_entry(r) for r in rows]
    owned_rows = positions_for_monitors(db, [m.id for m in monitors])
    owned: dict[str, list[Position]] = {id_: [to_position(p) for p in ps] for id_, ps in owned_rows.items()}
    at = now if now is not None else datetime.now(UTC)
    batch = await fetch(codes_for(monitors, owned))
    return build_entries(
        monitors=monitors,
        by_code=display_records(batch.records, display_tz, at),
        bad=set(batch.unknown),
        owned=owned,
        holdings=_readable_open_positions(db),
        now=at,
        policy=policy,
    )


def _readable_open_positions(db: sqlite3.Connection) -> list[Position]:
    """Every OPEN holding that can be read, for whether a rule watches anything held.

    It joins no batch — holding a Contract needs no quote — but it reads holdings no rule is linked to,
    so one that cannot be read costs its own Contracts and nothing else, as it does in the sweep: a
    watchlist that failed over a holding it never shows would be the larger harm."""
    readable: list[Position] = []
    for row in open_positions(db):
        try:
            readable.append(to_position(row))
        except Exception:
            log.warning("cannot read position %s:", row["name"], exc_info=True)
    return readable


def adopt_orphan_monitors(db: sqlite3.Connection) -> None:
    """Link monitors that watch something now held, and never unlink anything.

    The link is worked out when a thing is created, which handled only one order: position first, then
    monitor. Set the alarm before recording the holding and the monitor stayed orphaned for ever. This
    is the mirror image, so either order works.

    It looks ONLY at monitors that have no link. The tempting alternative — recompute every link on a
    schedule — is worse than the bug: rolling a spread leaves the old and the new sharing a strike for
    a day, a recomputing job would call that contract ambiguous, and a monitor that had worked for
    weeks would silently lose its entry and P&L mid-session. What you already have cannot be taken
    away by something you subsequently hold.
    """
    orphans = orphan_monitors(db)
    if not orphans:
        return
    # never onto a closed holding: closing one is what ORPHANED the rules it took (ADR 0022), and
    # adopting them straight back would undo the close
    positions = [to_position(r) for r in open_positions(db)]
    for row in orphans:
        monitor = to_monitor(row)
        holding = positions_holding(positions, monitor_leg_codes(monitor))
        if not holding.found:
            continue
        set_monitor_scope(db, row["id"], holding.scope)
        link_monitor_to_positions(db, row["id"], list(holding.found))
