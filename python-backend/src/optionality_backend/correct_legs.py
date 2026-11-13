"""Correcting a held leg's quantity, keeping the holding and its samples (#359). Port of
backend/src/correct-legs.ts.

A holding's legs are never edited: a different structure is a different holding. A quantity typed wrong
is the one exception, because the only other remedy is DELETE, and DELETE takes the daily samples with it
— the one thing in the database that cannot be re-entered. So `PATCH /positions/{id}` takes `legs` that
name the SAME contracts on the same sides, in any order, and differ from what is stored in nothing but
`qty`; anything else is refused as it always was.

What follows a correction, in the one transaction the route opens:

- the legs are written in the order they were recorded, each quantity stored as #351 stores it, and
  `qty_corrected_at` stamps when;
- every rule that valued EXACTLY the structure it links to, under the quantities as they were, takes the
  corrected quantities with it: the holding's own value rule, and a rule spanning two holdings in the wing
  that was corrected. That rule now watches a different figure, so it is a new rule, unrung, as an edit
  that changes what a rule watches is (#292, `edited_monitor`). Its name and its code are KEPT, though a
  derived name spells the old quantities: the code is the rule's identity and the holding's name is the
  trade's, and neither is what was mistyped;
- every rule linked to the holding is given the scope its contracts now have against the holdings it
  links to (`positions_holding`, which compares quantities since #358). A rule that watched other
  quantities is not re-quantified — it never valued the holding's structure — but may now be all of it,
  or no longer. No link is added or taken away: a correction changes no contract, so nothing is held or
  let go.

The samples are KEPT AS THEY ARE. Each one's IV, vega and delta are one contract's readings and stay
true; its Cost to close was summed under the old quantities, and no sample stores a leg's price, so
nothing can re-sum it. `qty_corrected_at` is what says which samples those are.

**Where the Python differs, and why.** A contract in the refusals is spelled with `js_string`, so a
strike reads `7075` as the TypeScript interpolates it, never `7075.0`.
"""

import sqlite3
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from optionality.js import js_string
from optionality.monitor import monitor_contracts, monitor_leg_codes
from optionality.position import Leg, position_leg_codes, positions_holding

from .db.queries import (
    find_position,
    monitors_watching,
    positions_for_monitor,
    update_monitor_fields,
    update_position_fields,
)
from .db.rows import PositionRow
from .db.time import to_sql_datetime
from .db.values import to_sqlite_json
from .hydrate import to_monitor, to_position
from .schemas.position import LegIn, stored_qty


@dataclass(frozen=True)
class Fault:
    """Why the legs given are not a correction."""

    fault: str


@dataclass(frozen=True)
class Corrected:
    """The holding's legs with the quantities given, and whether any quantity differs."""

    legs: list[Leg]
    changed: bool


_TAIL = ": only a leg's quantity can be corrected — a different structure is a different holding"


def corrected_legs(name: str, stored: tuple[Leg, ...] | list[Leg], given: list[LegIn]) -> Fault | Corrected:
    """The stored legs, in their own order, with each one's quantity as `given` says — matched by contract,
    so the order they are given in does not matter. Refused, with the first thing wrong, where `given` is
    not the same contracts on the same sides. `changed` is whether any quantity differs, so a request that
    says what is stored writes nothing and stamps nothing."""

    def leg_words(n: int) -> str:
        return f"{n} leg{'' if n == 1 else 's'}"

    if len(given) != len(stored):
        return Fault(f"'{name}' has {leg_words(len(stored))}, not {len(given)}{_TAIL}")
    qty: dict[int, int] = {}
    for g in given:
        at = next(
            (i for i, leg in enumerate(stored) if leg.option_type == g.option_type and leg.strike == g.strike), -1
        )
        contract = f"{g.option_type} {js_string(g.strike)}"
        if at == -1:
            return Fault(f"'{name}' has no {contract} leg{_TAIL}")
        if at in qty:
            return Fault(f"'{name}' is given {contract} twice{_TAIL}")
        side = stored[at].side
        if side != g.side:
            return Fault(f"'{name}' is {side} {contract}, not {g.side}{_TAIL}")
        qty[at] = g.qty if g.qty is not None else 1
    legs = [
        Leg(side=leg.side, option_type=leg.option_type, strike=leg.strike, **stored_qty(qty.get(i)))
        for i, leg in enumerate(stored)
    ]
    return Corrected(legs=legs, changed=any(leg.qty != stored[i].qty for i, leg in enumerate(legs)))


def _stored_legs(legs: list[Leg]) -> str:
    return to_sqlite_json(
        [
            {"side": leg.side, "option_type": leg.option_type, "strike": leg.strike, **stored_qty(leg.qty)}
            for leg in legs
        ]
    )


@dataclass
class Followed:
    """What a correction did to the rules: those whose legs took the new quantities (each a new rule,
    unrung), and those whose scope moved, with the scope each now has. The route answers with both, so the
    page says what happened rather than what usually would."""

    followed: list[dict[str, str]]
    rescoped: list[dict[str, str | None]]


def correct_quantities(db: sqlite3.Connection, row: PositionRow, legs: list[Leg], at: datetime) -> Followed:
    """Write a correction and what follows it (see the module's docstring). The caller holds the
    transaction, and has already checked the holding is open and the legs are a correction."""
    done = Followed(followed=[], rescoped=[])
    before = to_position(row)
    update_position_fields(db, row["id"], {"legs": _stored_legs(legs), "qty_corrected_at": to_sql_datetime(at)})
    written = find_position(db, row["id"])
    assert written is not None  # written just above, inside the caller's transaction
    after = to_position(written)
    # contract -> its corrected quantity, for every contract this holding holds
    corrected = {code: after.legs[i].qty for i, code in enumerate(position_leg_codes(after))}

    for watcher in monitors_watching(db, row["id"]):
        try:
            monitor = to_monitor(watcher)
        except Exception:  # noqa: BLE001, S112 — the TypeScript's bare `catch`: the sweep's to quarantine
            continue
        linked = [to_position(p) for p in positions_for_monitor(db, watcher["id"])]
        linked_before = [before if p.id == row["id"] else p for p in linked]
        changes: dict[str, Any] = {}

        watching = monitor
        if positions_holding(linked_before, monitor_contracts(monitor)).scope == "all" and monitor.legs:
            codes = monitor_leg_codes(monitor)
            # one leg per contract of this holding, as #351 records a quantity; a rule from before it that
            # names a contract twice has no one leg to carry the quantity, and keeps its legs
            once = all(codes.count(code) == 1 for code in corrected)
            if once:
                followed = [
                    {
                        "sign": leg.sign,
                        "option_type": leg.option_type,
                        "strike": leg.strike,
                        **stored_qty(corrected.get(codes[i], leg.qty)),
                    }
                    for i, leg in enumerate(monitor.legs)
                ]
                text = to_sqlite_json(followed)
                if text != watcher["legs"]:
                    # what it watches changed, so it is a new rule: unrung (#292)
                    changes.update({"legs": text, "triggered": 0, "last_alarm_at": None})
                    watching = to_monitor({**watcher, "legs": text})
                    done.followed.append({"id": watcher["id"], "code": watcher["code"]})
        scope = positions_holding(linked, monitor_contracts(watching)).scope
        if scope != watcher["scope"]:
            changes["scope"] = scope
            done.rescoped.append({"id": watcher["id"], "code": watcher["code"], "scope": scope})
        if changes:
            update_monitor_fields(db, watcher["id"], changes)
    return done


def before_correction(observed_at: str | None, corrected_at: str | None) -> bool:
    """Whether a sample was summed under quantities since corrected: observed before the correction, or at
    an instant never recorded (every such row predates migration 0009, and so any correction). Both stamps
    are `to_sql_datetime`'s fixed-width UTC text, so they compare as text."""
    if corrected_at is None:
        return False
    return observed_at is None or observed_at < corrected_at
