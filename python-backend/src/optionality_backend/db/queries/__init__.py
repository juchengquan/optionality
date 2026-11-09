"""The SQL the rest of the service runs (ADR 0009, phase 5), by table. Port of
backend/src/db/queries/index.ts — PARTLY: see the last paragraph.

Hand-written because there is no ORM. Gathered out of the handlers so that the statements are
greppable and the routes stay about HTTP. The split is by TABLE rather than by caller, because a
table's rules belong together — `links` is its own module precisely because `monitor_positions` has
a hazard of its own.

This module re-exports, so every caller keeps one import path and a query can move between the
modules behind it without touching a route. `sql.py` holds what all of them were repeating.

Every write that touches more than one row goes through `atomic` from `..open`. Reading is cheap and
uncoordinated; writing is not.

**Partly ported.** It re-exports what `sql.py` and `positions.py` define, the two tables' modules the
Python has (ADR 0021, phase 3: `GET /positions`). `monitors`, `links`, `samples` and `references` are
still on the module map's backlog, and each one's names join the list below in the change that ports
it — so a caller that needs one fails at import rather than at a query.
"""

from .positions import (
    delete_position_row,
    find_position,
    find_position_by_name,
    insert_position,
    list_positions,
    set_position_entry,
    stamp_manage_notified,
    update_position_fields,
)
from .sql import database_responds

__all__ = [
    "database_responds",
    "delete_position_row",
    "find_position",
    "find_position_by_name",
    "insert_position",
    "list_positions",
    "set_position_entry",
    "stamp_manage_notified",
    "update_position_fields",
]
