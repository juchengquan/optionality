"""The schema as the Python sees it (ADR 0009, phase 4). Port of backend/src/db/rows.ts.

These are STORED shapes, not domain shapes: a BOOLEAN column is an `int` here because that is what
SQLite holds and what both backends write, and a JSON column is the unparsed string. The domain types
in the library are the parsed, meaningful versions; converting between them is what `db/values.py`
and `db/time.py` are for. Keeping the two apart is deliberate — the moment a row type claims
`enabled: bool`, something has to be lying about what is in the file.

schema.sql is the database's truth, COLUMNS is the runtime's, and the row types are the type
checker's; `tests/db/test_rows.py` ties all three together. Change one without the others and
something fails rather than drifts.

**Where the Python differs, and why.** A row type is a `TypedDict`, not a frozen dataclass: a row is
what a query answers, a dict keyed by column (`queries/sql.py`), and `insert_row` reads it by the
names in COLUMNS, so it stays the plain mapping the TypeScript's interface describes. A number column
is `int` or `float` by its SQL type, which is what `sqlite3` hands back for each — JavaScript has one
number type and could not say. The TypeScript ties the interfaces to COLUMNS and NULLABLE in its
COMPILER (`SchemaChecks`); Python has no compiler in the gate, so `ROW_TYPES` names each table's row
type and the test does it.
"""

from typing import Literal, TypedDict

type TableName = Literal[
    "monitors", "positions", "position_samples", "monitor_positions", "reference_securities", "schema_migrations"
]

#: Every column of every table, in the order schema.sql declares them.
COLUMNS: dict[TableName, tuple[str, ...]] = {
    "monitors": (
        "id", "code", "strike_date", "option_type", "strike", "field", "threshold", "direction",
        "compare", "legs", "scope", "enabled", "disabled_reason", "triggered", "last_value",
        "last_checked_at", "last_alarm_at", "created_at",
    ),
    "positions": (
        "id", "name", "strategy", "strike_date", "contracts", "entry", "legs", "created_at",
        # appended, because ALTER TABLE adds at the end and a migrated database lists them here
        "opened_at", "manage_notified_at", "closed_on", "exit",
    ),
    "position_samples": (
        "position_id", "observed_on", "dte", "cost_to_close",
        # appended, because ALTER TABLE adds at the end
        "legs_iv", "legs_vega", "legs_delta", "observed_at",
    ),
    "monitor_positions": ("monitor_id", "position_id"),
    "reference_securities": ("id", "code", "label", "source", "created_at"),
    # bookkeeping: COLUMNS covers every table the schema creates, and a table left out of it is a
    # table nothing checks (db/migrate.py)
    "schema_migrations": ("name", "applied_at"),
}  # fmt: skip

#: Which columns the database allows to be NULL.
#:
#: A separate list because nullability is the half that bites at runtime: a row type that says
#: `scope: str` for a column the database leaves empty produces code that reads a None as a string
#: and only fails on the row that happens to have one.
NULLABLE: dict[TableName, tuple[str, ...]] = {
    "monitors": ("legs", "scope", "disabled_reason", "last_value", "last_checked_at", "last_alarm_at"),
    "positions": ("strategy", "entry", "opened_at", "manage_notified_at", "closed_on", "exit"),
    "position_samples": ("legs_iv", "legs_vega", "legs_delta", "observed_at"),
    "monitor_positions": (),
    "reference_securities": ("label",),
    "schema_migrations": (),
}


class MonitorRow(TypedDict):
    id: str
    code: str
    strike_date: str
    option_type: str
    strike: float
    field: str
    threshold: float
    #: "above" | "below"
    direction: str
    #: "abs" | "signed"
    compare: str
    #: JSON text, or None for a single-leg monitor
    legs: str | None
    #: "all" | "calls" | "puts" | "leg" | None
    scope: str | None
    #: 0 | 1
    enabled: int
    #: DISABLED_REASONS, or None: "manual" | "expired" | "unknown-contract" | "no-figure" |
    #: "unreadable". See schemas/monitor.ts, which is where the list lives.
    disabled_reason: str | None
    #: 0 | 1
    triggered: int
    last_value: float | None
    last_checked_at: str | None
    last_alarm_at: str | None
    created_at: str


class PositionRow(TypedDict):
    id: str
    name: str
    strategy: str | None
    strike_date: str
    contracts: int
    entry: float | None
    #: JSON text
    legs: str
    created_at: str
    #: the day the Position was PUT ON, which created_at is not; None until someone says
    opened_at: str | None
    #: sent-once marker for the manage-by notice
    manage_notified_at: str | None
    #: the New York market day it was closed, or None while it is still held. A closed holding is KEPT,
    #: with its samples — closing is not deleting (ADR 0022)
    closed_on: str | None
    #: what was paid to close it, per contract, in points — Entry's counterpart. None where the owner left
    #: it blank when closing; the holding is closed either way (ADR 0022)
    exit: float | None


class ReferenceRow(TypedDict):
    """A Reference: a Security kept on the page to read the market by (ADR 0018).

    It never alarms, need not be held, and no rule reads one — so there is nothing here about a
    threshold, an enabled flag or a disabled reason. A Reference is never auto-disabled, never notified
    and never deleted: its absence is not an event, and quarantine does not transfer, because that is
    defined as a Monitor the service disabled because it cannot be EVALUATED and a Reference evaluates
    nothing.
    """

    id: str
    #: a raw code, given rather than built: `build_spx_code` cannot write `US.SPY`
    code: str
    #: what to call it, or None for "the code is its own name": `^GSPC`, `US..SPX` and `SPX` are three
    #: vendors' names for one index
    label: str | None
    #: the vendor that answers for this code — never "the Provider", which would change meaning the day
    #: OPTIONALITY_PROVIDER does, under the same unchanged label (ADR 0019)
    source: str
    created_at: str


class SchemaMigrationRow(TypedDict):
    name: str
    applied_at: str


class PositionSampleRow(TypedDict):
    """One observation of a Position's Cost to close, one per market day (ADR 0011)."""

    position_id: str
    observed_on: str
    dte: int
    cost_to_close: float
    #: JSON text: contract code -> implied volatility. None where not every leg was priced — a partial
    #: map would invite a vol figure computed from half a structure (ADR 0011).
    legs_iv: str | None
    #: JSON text: contract code -> vega, the weight legs_iv has to be combined with, since the legs of
    #: one structure do not share a vol. None on the same all-or-nothing rule, and gated separately
    #: from legs_iv: a withheld vega does not make the IV reading untrue, and the IV is the half no
    #: later sweep can recover (ADR 0011).
    legs_vega: str | None
    #: JSON text: contract code -> delta, the risk the book is managed by. None on the same
    #: all-or-nothing rule and gated on its own, like the vega: only knowable when observed.
    legs_delta: str | None
    #: When the sweep that wrote this row ran, UTC. Inside the sample hours it is the close or near it;
    #: outside them the row filled a day that had none (ADR 0011). None before migration 0009.
    observed_at: str | None


class MonitorPositionRow(TypedDict):
    monitor_id: str
    position_id: str


#: Each table's row type, which `tests/db/test_rows.py` holds to COLUMNS and NULLABLE: the Python's
#: `SchemaChecks`.
ROW_TYPES: dict[TableName, type] = {
    "monitors": MonitorRow,
    "positions": PositionRow,
    "position_samples": PositionSampleRow,
    "monitor_positions": MonitorPositionRow,
    "reference_securities": ReferenceRow,
    "schema_migrations": SchemaMigrationRow,
}
