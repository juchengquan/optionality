"""Adding spreads in one step: each one's holding, when held, and the Monitors it starts with — all of
it, or none of it (#293, ADR 0023). Port of backend/src/create-spread.ts.

The old dashboard made a condor in four requests, a rule and a holding per spread, and a refusal half
way left half a condor behind. Here one request carries the lot, and nothing is written until
everything has passed. The order is `create_monitor.py`'s, for its reason — everything free comes
before the one step that leaves the machine:

1. what the request says about itself: more legs in all than one probe may ask for (`MAX_PROBE_LEGS`), a
   spread that would record nothing, a watched spread carrying a holding's figures, a rule on a leg the
   spread does not have, a threshold the rule refuses, a combo field that does not add up, a name or a
   rule given twice;
2. the database: a holding of that name, a Monitor on that (code, field) already there;
3. ONE probe of every leg of every spread, deduplicated — strict as POST /positions and POST /monitors
   are, so one Contract the Provider refuses refuses the whole request;
4. one transaction: the holdings, then the Monitors, each linked to what holds its Contracts, then any
   older rule the new holdings now cover is adopted, as POST /positions does.

It never trades. The only call that leaves the machine is the bounded market-data probe the two older
routes already make (CLAUDE.md's invariants).

Faults are values, with the status they answer as: this has one door, and the wording of every refusal
the older routes share is theirs, word for word, so a form reads the same sentence whichever route
refused it.

**Where the Python differs, and why.** The inputs are the validated request models themselves
(`schemas/spread.py`), their absent fields None where the TypeScript's are undefined. A strike is
written into a sentence through `js_string`, as JavaScript interpolates a number: a JSON `6400` is the
float 6400.0 here, and Python would say "6400.0". Every code is built by `build_spx_code` and so is
ASCII, and Python's sort is JavaScript's on it.
"""

import sqlite3
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, TypeGuard, cast

from optionality.contract import build_spx_code
from optionality.js import js_string
from optionality.monitor import combo_field_error, threshold_fault
from optionality.position import positions_holding

from .db.open import atomic
from .db.queries import (
    clear_monitor_links,
    delete_monitor_row,
    find_monitor_by_code_field,
    find_position_by_name,
    insert_monitor,
    insert_position,
    link_monitor_to_positions,
    positions_for_monitor,
    update_monitor_fields,
)
from .db.rows import MonitorRow, PositionRow
from .db.time import to_sql_datetime
from .db.values import new_id, to_sqlite_json
from .hydrate import to_position
from .monitors import adopt_orphan_monitors, edited_monitor, link_to_positions
from .ports import QuoteFetcher, verify_contracts
from .schemas.monitor import (
    DEFAULT_COMBO_FIELD,
    DEFAULT_COMPARE,
    DEFAULT_DIRECTION,
    DEFAULT_SINGLE_FIELD,
    threshold_error,
)
from .schemas.position import DEFAULT_CONTRACTS, LegIn, stored_qty
from .schemas.spread import MAX_PROBE_LEGS, SpreadIn, SpreadMonitorIn, SpreadsIn


@dataclass(frozen=True)
class SpreadDeps:
    db: sqlite3.Connection
    fetch_quotes: QuoteFetcher
    #: an AWARE datetime, as `Deps.now` answers one
    now: Callable[[], datetime]
    #: the new rows' ids; uuids unless a door scenario states them (ADR 0021)
    new_id: Callable[[], str] | None = None


@dataclass(frozen=True)
class SpreadFault:
    status: Literal[409, 422]
    message: str


@dataclass
class Added:
    """What was added, by id: the page reads the book again rather than trusting an echo of it. And the
    watch rules a held spread replaced, which the form names before the save and after it."""

    positions: list[dict[str, str]] = field(default_factory=list)
    monitors: list[dict[str, str]] = field(default_factory=list)
    replaced: list[dict[str, str]] = field(default_factory=list)


def is_spread_fault(result: Added | SpreadFault) -> TypeGuard[SpreadFault]:
    return isinstance(result, SpreadFault)


@dataclass(frozen=True)
class _Planned:
    """One Monitor, decided: its code, what it watches, and every column it will be written with."""

    code: str
    field: str
    #: the Contracts it watches: the legs for the value, the one contract for a leg
    contracts: list[str]
    columns: dict[str, Any]


def _refuse(message: str, status: Literal[409, 422] = 422) -> SpreadFault:
    return SpreadFault(status=status, message=message)


def _plan(strike_date: str, spread: SpreadIn, m: SpreadMonitorIn, index: int) -> _Planned | SpreadFault:
    """A Monitor of `spread`, as the row it would be, or why it cannot be."""
    which = f"monitor {index + 1} of '{spread.name}'"
    on_leg = m.option_type is not None or m.strike is not None
    compare = DEFAULT_COMPARE if m.compare is None else m.compare
    common = {
        "threshold": m.threshold,
        "direction": DEFAULT_DIRECTION if m.direction is None else m.direction,
        "compare": compare,
    }

    if on_leg:
        if m.option_type is None or m.strike is None:
            return _refuse(f"{which} names a leg: give both its option_type and its strike")
        type_, strike = m.option_type, m.strike
        if not any(leg.option_type == type_ and leg.strike == strike for leg in spread.legs):
            return _refuse(f"{which} watches {type_} {js_string(strike)}, which is not one of its legs")
        if threshold_fault(compare, m.threshold):
            return _refuse(cast(str, threshold_error(compare, m.threshold)))
        code = build_spx_code(strike_date, type_, strike)
        field_ = DEFAULT_SINGLE_FIELD if m.field is None else m.field
        return _Planned(
            code=code,
            field=field_,
            contracts=[code],
            columns={
                "code": code,
                "strike_date": strike_date,
                "option_type": type_,
                "strike": strike,
                "field": field_,
                **common,
            },
        )

    if len(spread.legs) < 2:
        return _refuse(f"'{spread.name}' has one leg, so its value is that contract's: watch the leg instead")
    field_ = DEFAULT_COMBO_FIELD if m.field is None else m.field
    not_additive = combo_field_error(field_)
    if not_additive:
        return _refuse(not_additive)
    if threshold_fault(compare, m.threshold):
        return _refuse(cast(str, threshold_error(compare, m.threshold)))
    # minus is short (ADR 0013): a credit spread's value is the negative of its cost to close, which
    # `compare: abs` is indifferent to. A leg's quantity goes with it, so the rule values the structure
    # the holding is (#351)
    legs = [
        {
            "sign": -1 if leg.side == "short" else 1,
            "option_type": leg.option_type,
            "strike": leg.strike,
            **stored_qty(leg.qty),
        }
        for leg in spread.legs
    ]
    return _Planned(
        code=spread.name,
        field=field_,
        contracts=[build_spx_code(strike_date, leg.option_type, leg.strike) for leg in spread.legs],
        columns={
            "code": spread.name,
            "strike_date": strike_date,
            "option_type": "CMB",
            "strike": 0,
            "field": field_,
            "legs": to_sqlite_json(legs),
            **common,
        },
    )


def _in_the_way(
    db: sqlite3.Connection, spreads: list[SpreadIn], planned: list[list[_Planned]], replacing: bool
) -> list[MonitorRow] | SpreadFault:
    """Step 2, the database: the first clash it finds, or the watch rules a HELD spread replaces.

    A planned Monitor whose (code, field) is already taken is a 409 — unless the spread is held and the
    rule in the way is linked to no holding: a WATCH rule on the candidate the owner has now sold, which
    the holding's own rule replaces (owner's decision, #322). One another holding owns is still a 409,
    and a watched spread never replaces anything. `replacing=False` asks for the 409 alone, which is how
    a clash the write itself ran into is answered."""
    for spread in spreads:
        if spread.held and find_position_by_name(db, spread.name) is not None:
            return _refuse(f"position '{spread.name}' already exists", 409)
    replaced: list[MonitorRow] = []
    for spread, mine in zip(spreads, planned, strict=True):
        for p in mine:
            there = find_monitor_by_code_field(db, p.code, p.field)
            if there is None:
                continue
            watching = all(h["closed_on"] is not None for h in positions_for_monitor(db, there["id"]))
            if not (replacing and spread.held and watching):
                return _refuse(f"monitor for ({p.code}, {p.field}) already exists", 409)
            replaced.append(there)
    return replaced


def _twice_over(spread: SpreadIn) -> SpreadFault | None:
    """Two legs on one contract: a typo, or a leg that cancels itself. Held twice over is ONE leg with a
    quantity (#351), so that "a Contract held twice" stays a fact about two holdings — a roll day."""
    seen: dict[str, LegIn] = {}
    for leg in spread.legs:
        key = f"{leg.option_type} {js_string(leg.strike)}"
        before = seen.get(key)
        if before is not None:
            return _refuse(
                f"'{spread.name}' names {key} twice: give the one leg a quantity"
                if before.side == leg.side
                else f"'{spread.name}' is both short and long {key}"
            )
        seen[key] = leg
    return None


def _is_unique_clash(err: BaseException) -> bool:
    return isinstance(err, sqlite3.IntegrityError) and "UNIQUE constraint failed" in str(err)


async def create_spreads(deps: SpreadDeps, given: SpreadsIn) -> Added | SpreadFault:
    db = deps.db
    date = given.strike_date

    # 1. what the request says about itself, starting with its size: the one probe is bounded. LEGS, not
    # legs times quantity: a quantity asks the Provider for nothing more, and a spread names a Contract
    # once (`_twice_over`), so legs are at least the codes the probe asks for (#351)
    leg_count = sum(len(spread.legs) for spread in given.spreads)
    if leg_count > MAX_PROBE_LEGS:
        return _refuse(f"this request has {leg_count} legs: at most {MAX_PROBE_LEGS} in one request")
    names: set[str] = set()
    planned: list[list[_Planned]] = []
    watched: set[tuple[str, str]] = set()
    for spread in given.spreads:
        if not spread.held and len(spread.monitors) == 0:
            return _refuse(f"'{spread.name}' is neither held nor watched: nothing would be recorded")
        holding_figures = spread.entry is not None or spread.contracts is not None or spread.opened_at is not None
        if not spread.held and holding_figures:
            return _refuse(f"'{spread.name}' is watched, not held: an entry, a count and an Opened belong to a holding")
        if spread.name in names:
            return _refuse(f"'{spread.name}' is named twice")
        names.add(spread.name)
        twice = _twice_over(spread)
        if twice is not None:
            return twice
        mine: list[_Planned] = []
        for i, m in enumerate(spread.monitors):
            p = _plan(date, spread, m, i)
            if isinstance(p, SpreadFault):
                return p
            if (p.code, p.field) in watched:
                return _refuse(f"the monitor for ({p.code}, {p.field}) is given twice")
            watched.add((p.code, p.field))
            mine.append(p)
        planned.append(mine)

    # 2. the database
    replacing = _in_the_way(db, given.spreads, planned, True)
    if isinstance(replacing, SpreadFault):
        return replacing

    # 3. one probe, last: the one step that leaves the machine
    codes = sorted(
        {build_spx_code(date, leg.option_type, leg.strike) for spread in given.spreads for leg in spread.legs}
    )
    missing = await verify_contracts(codes, deps.fetch_quotes)
    if missing:
        return _refuse(missing)

    # 4. all of it, in one transaction
    make_id = deps.new_id or new_id
    created_at = to_sql_datetime(deps.now())
    try:
        return await atomic(db, lambda: _write(db, given, planned, replacing, make_id, created_at))
    except sqlite3.IntegrityError as err:
        # Something got in after the checks — a second save of the same spread, landing between this
        # one's checks and its transaction. The transaction is rolled back, and the clash is answered as
        # the checks would have answered it, rather than as a 500.
        if not _is_unique_clash(err):
            raise
        clash = _in_the_way(db, given.spreads, planned, False)
        if isinstance(clash, SpreadFault):
            return clash
        raise


def _carried_alarm(was: MonitorRow | None, now: MonitorRow) -> dict[str, Any]:
    """What a watch rule's alarm leaves the holding's rule that replaces it (#336): its state — the bell,
    when it last sent, the figure it last read — where the new rule watches the same figure the same way,
    as a PATCH moving the threshold alone keeps it (#292); nothing where it watches another way or the
    watch rule was off, as such a PATCH would forget it. One rule, `edited_monitor`'s, so the two doors
    cannot disagree. Remade fresh, a ringing rule would send "crossed" again next sweep."""
    if was is None:
        return {}
    edited = edited_monitor(
        was,
        {
            "field": now["field"],
            "direction": now["direction"],
            "compare": now["compare"],
            "threshold": now["threshold"],
            "enabled": now["enabled"],
        },
    )
    if "triggered" in edited:
        return {}
    return {"triggered": was["triggered"], "last_alarm_at": was["last_alarm_at"], "last_value": was["last_value"]}


def _write(
    db: sqlite3.Connection,
    given: SpreadsIn,
    planned: list[list[_Planned]],
    replacing: list[MonitorRow],
    make_id: Callable[[], str],
    created_at: str,
) -> Added:
    date = given.strike_date
    added = Added(replaced=[{"id": m["id"], "code": m["code"], "field": m["field"]} for m in replacing])
    # the watch rules a held spread replaces go first, so their (code, field) is free: a deletion the owner
    # asked for by saving, not one the service decided on (CLAUDE.md's retention invariant)
    for m in replacing:
        clear_monitor_links(db, m["id"])
        delete_monitor_row(db, m["id"])
    links: list[tuple[str, list[str], PositionRow | None]] = []
    for spread, mine in zip(given.spreads, planned, strict=True):
        holding: PositionRow | None = None
        if spread.held:
            holding = {
                "id": make_id(),
                "name": spread.name,
                "strategy": None,
                "strike_date": date,
                "contracts": DEFAULT_CONTRACTS if spread.contracts is None else spread.contracts,
                "entry": spread.entry,
                "legs": to_sqlite_json(
                    [
                        {"side": leg.side, "option_type": leg.option_type, "strike": leg.strike, **stored_qty(leg.qty)}
                        for leg in spread.legs
                    ]
                ),
                "created_at": created_at,
                "opened_at": spread.opened_at,
                "manage_notified_at": None,
                "closed_on": None,
                "exit": None,
            }
            insert_position(db, holding)
            added.positions.append({"id": holding["id"], "name": holding["name"]})
        for p in mine:
            monitor = cast(
                MonitorRow,
                {
                    "id": make_id(),
                    "code": "",
                    "strike_date": "",
                    "option_type": "",
                    "strike": 0,
                    "field": "",
                    "threshold": 0,
                    "direction": DEFAULT_DIRECTION,
                    "compare": DEFAULT_COMPARE,
                    "legs": None,
                    "scope": None,
                    "enabled": 1,
                    "disabled_reason": None,
                    "triggered": 0,
                    "last_value": None,
                    "last_checked_at": None,
                    "last_alarm_at": None,
                    "created_at": created_at,
                    **p.columns,
                },
            )
            was = next((m for m in replacing if m["code"] == p.code and m["field"] == p.field), None)
            monitor.update(cast(Any, _carried_alarm(was, monitor)))
            insert_monitor(db, monitor)
            added.monitors.append({"id": monitor["id"], "code": p.code, "field": p.field})
            links.append((monitor["id"], p.contracts, holding))
    for monitor_id, contracts, holding in links:
        if holding is not None:
            # A held spread's rules are ITS rules, so they are linked to it and to nothing else, scoped as
            # against that one holding. Worked out against the whole book, a contract another open holding
            # shares — a neighbouring spread, or scaling in on the same strikes — reads as ambiguous, and
            # the new holding's own stop and delta rule came out linked to nothing.
            owned = positions_holding([to_position(holding)], contracts)
            if not owned.found:
                continue
            update_monitor_fields(db, monitor_id, {"scope": owned.scope})
            link_monitor_to_positions(db, monitor_id, list(owned.found))
        else:
            # a watched spread's rule is linked as POST /monitors links one: to whatever holds its contracts
            link_to_positions(db, monitor_id, contracts)
    # and a rule set before these holdings were recorded is adopted by them, as POST /positions does
    adopt_orphan_monitors(db)
    return added
