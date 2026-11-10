"""The SQL the rest of the service runs (ADR 0009, phase 5), by table. Port of
backend/src/db/queries/index.ts.

Hand-written because there is no ORM. Gathered out of the handlers so that the statements are
greppable and the routes stay about HTTP. The split is by TABLE rather than by caller, because a
table's rules belong together — `links` is its own module precisely because `monitor_positions` has
a hazard of its own.

This module re-exports, so every caller keeps one import path and a query can move between the
modules behind it without touching a route. `sql.py` holds what all of them were repeating.

Every write that touches more than one row goes through `atomic` from `..open`. Reading is cheap and
uncoordinated; writing is not.
"""

from .links import (
    clear_monitor_links,
    clear_position_links,
    link_monitor_to_positions,
    monitors_watching,
    positions_for_monitor,
    positions_for_monitors,
    solely_watched_positions,
)
from .monitors import (
    clear_scope_of_orphans,
    delete_monitor_row,
    enabled_monitors,
    find_combo_by_name,
    find_monitor,
    find_monitor_by_code_field,
    find_monitors_by_identifier,
    insert_monitor,
    list_monitors,
    orphan_monitors,
    set_monitor_scope,
    update_monitor_fields,
)
from .positions import (
    delete_position_row,
    find_position,
    find_position_by_name,
    insert_position,
    list_positions,
    open_positions,
    set_position_entry,
    stamp_manage_notified,
    update_position_fields,
)
from .references import (
    delete_reference_row,
    find_reference,
    find_reference_by_code,
    insert_reference,
    list_references,
)
from .samples import (
    clear_position_samples,
    find_position_sample,
    list_position_samples,
    record_position_sample,
)
from .sql import database_responds

__all__ = [
    "clear_monitor_links",
    "clear_position_links",
    "clear_position_samples",
    "clear_scope_of_orphans",
    "database_responds",
    "delete_monitor_row",
    "delete_position_row",
    "delete_reference_row",
    "enabled_monitors",
    "find_combo_by_name",
    "find_monitor",
    "find_monitor_by_code_field",
    "find_monitors_by_identifier",
    "find_position",
    "find_position_by_name",
    "find_position_sample",
    "find_reference",
    "find_reference_by_code",
    "insert_monitor",
    "insert_position",
    "insert_reference",
    "link_monitor_to_positions",
    "list_monitors",
    "list_position_samples",
    "list_positions",
    "list_references",
    "monitors_watching",
    "open_positions",
    "orphan_monitors",
    "positions_for_monitor",
    "positions_for_monitors",
    "record_position_sample",
    "set_monitor_scope",
    "set_position_entry",
    "solely_watched_positions",
    "stamp_manage_notified",
    "update_monitor_fields",
    "update_position_fields",
]
