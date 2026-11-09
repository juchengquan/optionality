"""Creating a monitor, once, for both doors onto it. Port of backend/src/create-monitor.ts.

There are two: `POST /monitors` and the bot's `/watch` and `/watchcombo`. Each implemented the same
five steps — reject an unusable threshold, reject a non-additive combo field, build the code, refuse a
duplicate, prove the contract exists — and then wrote the row and linked it to whatever Position
already holds its contracts. Two implementations of one feature, and they had drifted:

- the route checked uniqueness and THEN probed the Provider; the bot probed and then checked, so
  `/watch` on a contract already watched spent a live Provider call to be told what the database
  already knew — against the rule that every call to the Provider is a bounded, deliberate one
  (CLAUDE.md's invariants);
- the route refused a non-additive combo field before an unusable threshold and the bot did the
  reverse, so the same input was answered with two different complaints;
- the route could create a rule already muted (`disabled_reason: "manual"`) and the bot could not,
  because that argument existed only on one path.

THE ORDER IS THE POINT, not just the sharing. Everything free comes before anything that costs a
Provider call: two local validations, then a lookup in the database, and only then the probe.

What is NOT here: parsing. The route gets a validated payload and the bot gets words typed into a
phone, and turning either into these inputs is that door's own business. What is here starts once the
values are known.

Faults come back as values rather than exceptions, because the two doors answer differently: a route
raises an HTTP status, and the bot writes a sentence to a chat. A `Duplicate` carries the code and the
field instead of a message for the same reason — the two already word it their own way, and this
module has no business choosing between "409" and "Already watching".

**Where the Python differs, and why.** The TypeScript's `CreateFault` is a union of four object types
told apart by `kind`; here each is a frozen dataclass that carries the same `kind`, so a door can ask
`result.kind` as the TypeScript's do, and `is_fault` asks which class a result is rather than whether
it has a `kind` key — a stored row is a dict, and a dict's keys are not a type. The inputs are frozen
dataclasses, their optional fields None where the TypeScript's are absent, and a default is applied
where the TypeScript's `??` applies it: to None, never to a falsy value.
"""

import dataclasses
import sqlite3
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Literal, TypeGuard, cast

from optionality.contract import build_spx_code
from optionality.monitor import combo_field_error, threshold_fault

from .db.open import atomic
from .db.queries import find_monitor, find_monitor_by_code_field, insert_monitor
from .db.rows import MonitorRow
from .db.time import to_sql_datetime
from .db.values import new_id, to_sqlite_bool, to_sqlite_json
from .monitors import link_to_positions
from .ports import QuoteFetcher, verify_contracts
from .schemas.monitor import (
    DEFAULT_COMBO_FIELD,
    DEFAULT_COMPARE,
    DEFAULT_DIRECTION,
    DEFAULT_ENABLED,
    DEFAULT_SINGLE_FIELD,
)


@dataclass(frozen=True)
class CreateDeps:
    db: sqlite3.Connection
    fetch_quotes: QuoteFetcher
    #: an AWARE datetime, as `Deps.now` answers one
    now: Callable[[], datetime]
    #: the new row's id; a uuid unless a door scenario states it (ADR 0021)
    new_id: Callable[[], str] | None = None


@dataclass(frozen=True, kw_only=True)
class SingleInput:
    """The rule's shape, with every default still optional: applying them HERE is what stops the two
    doors defaulting differently, which they did by writing the same constants out separately."""

    strike_date: str
    option_type: str
    strike: float
    threshold: float
    field: str | None = None
    direction: str | None = None
    compare: str | None = None
    enabled: bool | None = None


@dataclass(frozen=True)
class ComboLeg:
    sign: Literal[1, -1]
    option_type: str
    strike: float


@dataclass(frozen=True, kw_only=True)
class ComboInput:
    #: the trader's own name for the combo, which is its code: it prices no single contract
    name: str
    strike_date: str
    legs: list[ComboLeg]
    threshold: float
    field: str | None = None
    direction: str | None = None
    compare: str | None = None
    enabled: bool | None = None


@dataclass(frozen=True)
class BadThreshold:
    """The rule is `threshold_fault` in the library; the WORDING is each door's own and stays there. The
    bot's is deliberately longer than the API's — it is read without the form that produced it — so
    the compare and threshold come back rather than a sentence."""

    compare: str
    threshold: float
    kind: Literal["threshold"] = dataclasses.field(default="threshold", init=False)


@dataclass(frozen=True)
class BadComboField:
    message: str
    kind: Literal["combo-field"] = dataclasses.field(default="combo-field", init=False)


@dataclass(frozen=True)
class UnknownContract:
    message: str
    kind: Literal["unknown-contract"] = dataclasses.field(default="unknown-contract", init=False)


@dataclass(frozen=True)
class Duplicate:
    code: str
    field: str
    kind: Literal["duplicate"] = dataclasses.field(default="duplicate", init=False)


type CreateFault = BadThreshold | BadComboField | UnknownContract | Duplicate


def is_fault(result: MonitorRow | CreateFault) -> TypeGuard[CreateFault]:
    return isinstance(result, (BadThreshold, BadComboField, UnknownContract, Duplicate))


def _blank(deps: CreateDeps, **over: object) -> MonitorRow:
    """Every column of a new monitor, so neither door writes a half-built row."""
    return cast(
        MonitorRow,
        {
            "id": (deps.new_id or new_id)(),
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
            "created_at": to_sql_datetime(deps.now()),
            **over,
        },
    )


async def _finish(
    deps: CreateDeps, code: str, field_: str, contracts: list[str], row: Callable[[], MonitorRow]
) -> MonitorRow | CreateFault:
    """The shared tail: refuse a duplicate, prove the contracts exist, then write and link.

    `contracts` is what the rule WATCHES — the contract itself for a single, the legs for a combo, whose
    own code is a name. The probe sees them deduplicated and sorted because that is a batch; the link
    sees them as given, because `link_to_positions` matches Positions by contract and a repeated leg is
    still the same contract. Every one is built by `build_spx_code`, so it is ASCII, and Python's sort
    is JavaScript's on it.
    """
    db = deps.db
    if find_monitor_by_code_field(db, code, field_) is not None:
        return Duplicate(code=code, field=field_)
    # last, and only now: this is the one step that leaves the machine
    missing = await verify_contracts(sorted(set(contracts)), deps.fetch_quotes)
    if missing:
        return UnknownContract(message=missing)

    def write() -> MonitorRow:
        inserted = insert_monitor(db, row())
        link_to_positions(db, inserted["id"], contracts)
        # re-read, because linking can WRITE to the row it just linked: a rule whose contracts are
        # wholly held by one Position gets `scope: "all"` from link_to_positions, and returning the row
        # as inserted hands the caller a scope of None for a monitor the database says owns the lot.
        return cast(MonitorRow, find_monitor(db, inserted["id"]))

    return await atomic(db, write)


def _or[T](value: T | None, default: T) -> T:
    """`value ?? default`: the default for an absent value only, never for a falsy one."""
    return default if value is None else value


async def create_single_monitor(deps: CreateDeps, given: SingleInput) -> MonitorRow | CreateFault:
    compare = _or(given.compare, DEFAULT_COMPARE)
    if threshold_fault(compare, given.threshold):
        return BadThreshold(compare=compare, threshold=given.threshold)

    code = build_spx_code(given.strike_date, given.option_type, given.strike)
    field_ = _or(given.field, DEFAULT_SINGLE_FIELD)
    enabled = _or(given.enabled, DEFAULT_ENABLED)

    return await _finish(
        deps,
        code,
        field_,
        [code],
        lambda: _blank(
            deps,
            code=code,
            strike_date=given.strike_date,
            option_type=given.option_type,
            strike=given.strike,
            field=field_,
            threshold=given.threshold,
            direction=_or(given.direction, DEFAULT_DIRECTION),
            compare=compare,
            enabled=to_sqlite_bool(enabled),
            disabled_reason=None if enabled else "manual",
        ),
    )


async def create_combo_monitor(deps: CreateDeps, given: ComboInput) -> MonitorRow | CreateFault:
    field_ = _or(given.field, DEFAULT_COMBO_FIELD)
    # checked here rather than in the schema: inside a union, a refinement's message is buried under the
    # other branch's "field required" errors
    not_additive = combo_field_error(field_)
    if not_additive:
        return BadComboField(message=not_additive)

    compare = _or(given.compare, DEFAULT_COMPARE)
    if threshold_fault(compare, given.threshold):
        return BadThreshold(compare=compare, threshold=given.threshold)

    enabled = _or(given.enabled, DEFAULT_ENABLED)
    leg_codes = [build_spx_code(given.strike_date, leg.option_type, leg.strike) for leg in given.legs]

    return await _finish(
        deps,
        given.name,
        field_,
        leg_codes,
        lambda: _blank(
            deps,
            code=given.name,
            strike_date=given.strike_date,
            option_type="CMB",
            strike=0,
            field=field_,
            threshold=given.threshold,
            direction=_or(given.direction, DEFAULT_DIRECTION),
            compare=compare,
            legs=to_sqlite_json([asdict(leg) for leg in given.legs]),
            enabled=to_sqlite_bool(enabled),
            disabled_reason=None if enabled else "manual",
        ),
    )
