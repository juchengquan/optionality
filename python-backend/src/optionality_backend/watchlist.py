"""The watchlist entries the dashboard and the bot render (ADR 0009, phase 5). Port of
backend/src/watchlist.ts.

Everything a client needs without re-deriving it: how long the contract has left, which holdings the
rule watches, what they cost to close, and how close it is to firing. These used to be computed in the
old Python's routes/ui.py and reachable over no endpoint at all.

**Where the Python differs, and why.**

- **An entry is a `TypedDict`**, the JSON `/quotes` answers and the bot reads. The four keys the
  TypeScript's interface marks optional — `legs`, `combo_value`, `combo_greeks` and `error` — are
  `NotRequired` and ABSENT on a row they do not apply to, as they are on the TypeScript's object: a
  key present as None would answer `null` where the dashboard and the door scenarios see nothing.
- **`MonitorForEntry` subclasses the library's `Monitor`**, with `id` required and `scope` added, as
  the TypeScript's interface extends `Monitor`. `legs` stays the library's `MonitorLeg` models, which
  is the TypeScript's `MonitorLeg[]`; a route turns them into JSON.
- **`codes_for` sorts as JavaScript's `sort()` does**, by UTF-16 code unit, where Python's `sorted`
  compares code points. The two disagree only past the Basic Multilingual Plane, which no contract
  code reaches, but the order is the batch the Provider is asked for and a scenario records it. A
  row's `in_combos` is sorted the same way, for the same reason.
- **A NaN reading is caught with `math.isnan`**, where the TypeScript asks `Number.isNaN`: the
  watched figure is a float here whatever the quote held, because `monitor_value` reads it through
  `optionality.js.number`, as the TypeScript's `monitorValue` reads it through `Number()`.
"""

import math
from collections.abc import Iterable
from datetime import datetime
from typing import Literal, NamedTuple, NotRequired, TypedDict, cast

from optionality.exit import ExitPolicy, dte_at_open, exit_levels
from optionality.expiry import days_to_expiry
from optionality.monitor import (
    COMBO_GREEK_FIELDS,
    Monitor,
    MonitorLeg,
    combo_field_sum,
    is_breached,
    monitor_leg_codes,
    monitor_value,
    threshold_distance,
    threshold_fill,
)
from optionality.position import (
    Position,
    combined_cost_to_close,
    combined_entry,
    combined_pnl,
    cost_to_close_of,
    position_leg_codes,
)
from optionality.quote import ByCode, Quote


class PositionRef(TypedDict):
    id: str
    name: str


class Schedule(TypedDict):
    """The exit schedule, or None where there is no single holding to schedule (ADR 0011): the
    library's `ExitLevels`, and the two things that place it.

    `position_id` names the holding it is FOR. `positions` happens to hold exactly that one wherever a
    schedule exists — a schedule needs `scope: "all"` and one Position — but a client that read
    `positions[0]` would be relying on that coincidence, and the next change to either condition would
    move the figure onto the wrong holding in silence."""

    dte_at_open: int
    position_id: str
    on_pace: float | None
    pace_gap: float | None
    target: float | None
    stop: float | None
    target_dte: int | None
    manage_by_dte: int
    reached: Literal["target", "stop"] | None
    manage_by_due: bool


class WatchlistEntry(TypedDict):
    id: str
    code: str
    strike_date: str
    #: CALL, PUT, or the CMB a combo is stored as — what the monitors column says, passed through. The
    #: dashboard groups by it, and a single-leg row used to carry nothing to group by: only moomoo's
    #: `US.SPXW261130C8100000`, which would have had to be parsed in the browser.
    option_type: str
    field: str
    threshold: float
    direction: str
    compare: str
    #: breaching NOW, by the figures in this same entry — not the alarm engine's stored verdict.
    #: `last_value` used to sit here too, the sweep's figure beside this fetch's; no client read it and
    #: `/monitors` is where the engine's own record belongs. See ADR 0010.
    triggered: bool
    #: the live figures for this contract, or None for a combo, which has no single contract —
    #: CONTEXT.md calls this a Quote; moomoo's "snapshot" stays in the OpenD client, where their wire
    #: format belongs
    quote: Quote | None
    legs: NotRequired[list[MonitorLeg]]
    combo_value: NotRequired[float | None]
    combo_greeks: NotRequired[dict[str, float | None]]
    error: NotRequired[str]
    dte: int
    scope: str | None
    positions: list[PositionRef]
    #: the combos in this same watchlist whose legs include this row's Contract, by id and sorted: what
    #: lets a short leg's delta rule sit under its spread (ADR 0023). A DISCOVERED link, like
    #: `positions` — worked out from the legs each combo names, never recorded, so it is only ever as
    #: true as those rules are now. Empty on a combo's own row, and for a Contract no enabled combo holds.
    in_combos: list[str]
    cost_to_close: float | None
    entry: float | None
    pnl: float | None
    fill: int | None
    #: the figure this row is about — the very reading `fill` and `triggered` are drawn from, so a
    #: sentence built from it cannot disagree with the bar or the bell. None where it was not priced.
    watched: float | None
    #: how far `watched` still has to move to breach, in the field's own units: at or below zero exactly
    #: when `triggered` (`threshold_distance`). None wherever `watched` is.
    distance: float | None
    schedule: Schedule | None


class MonitorForEntry(Monitor):
    """What `build_entries` needs, and deliberately no more: the engine's `triggered` and `last_value`
    columns are NOT here, so the entry cannot be built from them. That is the fix made structural
    rather than written down — it was a comment before, and the comment was accurate while the code
    beside it was not."""

    id: str
    scope: str | None


def build_entries(
    *,
    monitors: list[MonitorForEntry],
    by_code: ByCode,
    bad: set[str],
    owned: dict[str, list[Position]],
    policy: ExitPolicy,
    now: datetime | None = None,
) -> list[WatchlistEntry]:
    """Watchlist entries for a set of monitors against an already-fetched batch of records.

    `bad` is the codes the Provider rejected as unknown. `now` is injectable so a test can state the
    date rather than wait for it. `policy` is REQUIRED rather than optional: a schedule that silently
    does not appear because a caller forgot to pass the policy is the shape of bug this project keeps
    finding.

    Combo entries carry their signed sum under `combo_value` and no per-contract quote: summing other
    fields under the combo's signs would fabricate plausible-but-wrong aggregates, and IV is never
    summed at all (CLAUDE.md).
    """
    # every combo in this watchlist, by the Contracts its legs name: the spreads a single Contract sits
    # in are found from these, as the holdings a rule watches are found from what is held
    combos = [_Combo(id=m.id, codes=frozenset(monitor_leg_codes(m))) for m in monitors if m.legs]
    return [_entry(m, by_code, bad, owned, policy, now, combos) for m in monitors]


class _Combo(NamedTuple):
    id: str
    codes: frozenset[str]


def _entry(
    m: MonitorForEntry,
    by_code: ByCode,
    bad: set[str],
    owned: dict[str, list[Position]],
    policy: ExitPolicy,
    now: datetime | None,
    combos: list[_Combo],
) -> WatchlistEntry:
    is_combo = bool(m.legs)
    positions = owned.get(m.id, [])
    quote = None if is_combo else by_code.get(m.code)

    combo_value = monitor_value(m, by_code) if is_combo else None
    # What it would cost to buy back the options in question (CONTEXT.md) — and "in question" means
    # the Contracts this Monitor NAMES, not the holding's Legs. A Monitor watches Contracts, never a
    # Position; the holding is found afterwards.
    #
    # So an alarm on the call side of a condor costs the call side. It used to be compared against the
    # whole condor's cost: you named two options and it fired on four. For an alarm covering the
    # holding whole this is the same number it always gave.
    #
    # A single Contract reports the figure only when it IS the whole holding — otherwise the row is
    # about one option and the holding's cost belongs on the holding's own row.
    #
    # Only where you hold the Contracts: buying back something you do not have is not a cost, and an
    # unheld combo is still shown and measured on its own signed sum.
    cost_to_close: float | None = None
    if positions:
        if is_combo:
            # costed from the holding's SIDES, restricted to the Contracts this Monitor names — not from
            # the combo's own signed sum. That sum is in the Monitor's own field, which may be delta, and
            # its sign depends on which of the two leg conventions the legs were entered under (#97):
            # derived from signs this figure is inverted under one of them.
            cost_to_close = cost_to_close_of(positions, by_code, monitor_leg_codes(m))
        elif m.scope == "all":
            cost_to_close = combined_cost_to_close(positions, by_code, m.scope)
    # only a rule that covers whole positions has an entry to speak of; a leg rule watches part of a
    # structure and its P&L would be a fraction of someone else's credit
    whole = positions if m.scope == "all" else []

    entry: WatchlistEntry = {
        "id": m.id,
        "code": m.code,
        "strike_date": m.strike_date,
        "option_type": m.option_type,
        "field": m.field,
        "threshold": m.threshold,
        "direction": m.direction,
        "compare": m.compare,
        # derived below, from the figure this row actually shows
        "triggered": False,
        "quote": quote,
        "dte": days_to_expiry(m.strike_date, now),
        "scope": m.scope,
        "positions": [{"id": cast(str, p.id), "name": p.name} for p in positions],
        "in_combos": [] if is_combo else _js_sorted(c.id for c in combos if m.code in c.codes),
        "cost_to_close": cost_to_close,
        "entry": combined_entry(whole) if whole else None,
        "pnl": combined_pnl(whole, by_code) if whole else None,
        # these three are derived below, from the one figure this row is about
        "fill": None,
        "watched": None,
        "distance": None,
        # ONE holding only. Two Positions put on different days have no single DTE at entry, and a
        # blended pace line would hide that rather than say it — ADR 0004 allows a rule to span them,
        # and this declines to guess rather than averaging two trades into one.
        "schedule": None,
    }

    if is_combo:
        entry["legs"] = list(m.legs or ())
        entry["combo_value"] = combo_value
        entry["combo_greeks"] = {f: combo_field_sum(m, by_code, f) for f in COMBO_GREEK_FIELDS}
    if any(c in bad for c in monitor_leg_codes(m)):
        entry["error"] = "unknown contract"

    # The figure this row is about, read ONCE and then used for both the fill bar and the bell. They
    # are one claim drawn twice and must not be able to disagree: the bell came from the sweep's stored
    # column while every figure beside it came from this fetch, so a row could show a value past its
    # threshold with no bell, or a bell beside a value well inside it (ADR 0010).
    #
    # It is the rule's OWN field, under the rule's own direction and compare — `monitor_value`, which is
    # the very call the sweep evaluates every rule with. A held combo used to be measured on its cost to
    # close instead, with above/abs forced: that is a PRICE, which a delta rule's threshold is not, so a
    # delta alarm rang here for ever while the sweep stayed silent. Its cost to close is still shown, in
    # its own column; it is not what any alarm is decided by.
    #
    # The price cases are unchanged: under compare 'abs' the sign washes out, so a combo summing to
    # -4.00 and a 4.00 cost to close give the same bell and the same bar.
    #
    # A NaN is no reading: the bar and the bell already took it for none, and in the reply it would fail
    # the schema and take every other row down with it.
    read = combo_value if is_combo else monitor_value(m, by_code)
    watched = None if read is None or math.isnan(read) else read
    entry["watched"] = watched
    entry["distance"] = threshold_distance(watched, m.threshold, m.direction, m.compare)
    entry["fill"] = threshold_fill(watched, m.threshold, m.direction, m.compare)
    # An unreadable figure is neither calm nor breaching, so no bell beside a dash — otherwise the
    # stored state would be back, by the other door. is_breached is the ENGINE's own predicate fed the
    # ENGINE's own value, so the bell flips at the exact threshold and cannot drift from how an alarm is
    # decided.
    entry["triggered"] = watched is not None and is_breached(watched, m.threshold, m.direction, m.compare)

    # Built from THIS entry's own cost to close, so the gap is the gap against the figure the row
    # shows. Fetching /positions/values beside it on the dashboard would compute it against a different
    # instant, which is the fault ADR 0010 settled.
    held = whole[0] if len(whole) == 1 else None
    if held is not None and held.opened_at:
        opened_dte = dte_at_open(held.strike_date, held.opened_at)
        levels = exit_levels(held.entry, opened_dte, entry["dte"], policy, entry["cost_to_close"])
        if levels is not None:
            entry["schedule"] = {"dte_at_open": opened_dte, "position_id": cast(str, held.id), **levels.model_dump()}
    return entry


def _js_sorted(values: Iterable[str]) -> list[str]:
    """`[...values].sort()`: by UTF-16 code unit, which is how JavaScript compares two strings."""
    return sorted(values, key=lambda s: s.encode("utf-16-be", "surrogatepass"))


def codes_for(monitors: list[MonitorForEntry], owned: dict[str, list[Position]]) -> list[str]:
    """Every code a batch has to carry for these monitors and the positions they watch.

    A Position can hold legs no Monitor names — a rule watching one wing of a condor, say. Without them
    the cost to close would be a partial sum, so they join the batch instead."""
    codes: set[str] = set()
    for m in monitors:
        codes.update(monitor_leg_codes(m))
    for positions in owned.values():
        for p in positions:
            codes.update(position_leg_codes(p))
    return _js_sorted(codes)
