"""`monitor_positions`: which holdings each rule covers. Port of backend/src/db/queries/links.ts.

Its own module because it is its own table with its own hazard. SQLAlchemy never managed it and
nothing manages it here either, so the links must be cleared before the row they point at is deleted
or the foreign key refuses — inside the sweep, every sweep, which is how the alarm engine once stopped
altogether (#70, #81). Every row in the live database is linked, so that is not a rare path.
"""

import sqlite3
from typing import cast

from ..rows import MonitorRow, PositionRow
from .sql import rows


def clear_monitor_links(db: sqlite3.Connection, monitor_id: str) -> None:
    db.execute("delete from monitor_positions where monitor_id = ?", (monitor_id,))


def clear_position_links(db: sqlite3.Connection, position_id: str) -> None:
    db.execute("delete from monitor_positions where position_id = ?", (position_id,))


def link_monitor_to_positions(db: sqlite3.Connection, monitor_id: str, position_ids: list[str]) -> None:
    for pid in sorted(position_ids):
        db.execute("insert into monitor_positions (monitor_id, position_id) values (?, ?)", (monitor_id, pid))


def positions_for_monitors(db: sqlite3.Connection, monitor_ids: list[str]) -> dict[str, list[PositionRow]]:
    """Which Positions each Monitor watches. A rule may span several — a combined stop over two credit
    spreads belongs to neither alone (ADR 0004).

    One query for a batch of ids, because the list route asks about every monitor at once and a query
    per row is what made it slow enough to notice.
    """
    if not monitor_ids:
        return {}
    holes = ", ".join("?" for _ in monitor_ids)
    found = rows(
        db,
        f"""select mp.monitor_id as monitor_id, p.* from monitor_positions mp
     join positions p on p.id = mp.position_id
     where mp.monitor_id in ({holes})
     order by p.name""",
        *monitor_ids,
    )
    owned: dict[str, list[PositionRow]] = {}
    for r in found:
        monitor_id = r.pop("monitor_id")
        owned.setdefault(monitor_id, []).append(cast(PositionRow, r))
    return owned


def monitors_watching(db: sqlite3.Connection, position_id: str) -> list[MonitorRow]:
    """The rules that watch one holding — every Monitor linked to it, in the watchlist's own order of
    code then field, so whatever reports them reads them as the page lists them."""
    return cast(
        list[MonitorRow],
        rows(
            db,
            """select m.* from monitor_positions mp
               join monitors m on m.id = mp.monitor_id
               where mp.position_id = ?
               order by m.code, m.field""",
            position_id,
        ),
    )


def positions_for_monitor(db: sqlite3.Connection, monitor_id: str) -> list[PositionRow]:
    return positions_for_monitors(db, [monitor_id]).get(monitor_id, [])


def solely_watched_positions(db: sqlite3.Connection) -> set[str]:
    """Positions that some whole-position rule watches ALONE, and which therefore have an entry field of
    their own.

    A leg rule links to one Position too but offers no field, so counting it would wrongly mark that
    Position reachable — which is the difference between "set this wing's credit directly" and "it can
    only be reached by splitting a total"."""
    found = rows(
        db,
        """select mp.position_id as position_id
     from monitor_positions mp
     join monitors m on m.id = mp.monitor_id
     where m.scope = 'all'
       and mp.monitor_id in (
         select monitor_id from monitor_positions group by monitor_id having count(position_id) = 1
       )""",
    )
    return {r["position_id"] for r in found}
