"""The two commands that add a rule, which is where the typing happens. Port of
backend/src/entrypoints/bot/commands/create.ts.

Both hand off to `create_monitor.py` the moment the words have been read: the five steps of creating
a rule — reject an unusable threshold, reject a non-additive combo field, build the code, refuse a
duplicate, prove the contract exists — are shared with `POST /monitors`, and the two had drifted when
each had its own copy. What is left here is parsing words typed into a phone, and the bot's own
wording for a refusal.

**Where the Python differs, and why.** The leg token is anchored as the TypeScript's is, so it is
compiled with `re.ASCII` and used with `fullmatch`: JavaScript's `\\d` is ASCII and its `$` is the end
of the text, where Python's take any Unicode digit and a final newline. A leg's strike is `Number` of
what it matched, through `optionality.js.number`. A word that cannot be read is caught as `except
Exception`, which is the TypeScript's bare `catch`: every step inside it refuses with a raise.
"""

import re
from dataclasses import dataclass
from typing import Literal

from optionality.contract import build_spx_code, normalize_strike_date
from optionality.js import number

from ....create_monitor import (
    ComboInput,
    ComboLeg,
    CreateFault,
    SingleInput,
    create_combo_monitor,
    create_single_monitor,
    is_fault,
)
from ..format import rule_text, threshold_error
from .context import BotContext, creating, require_number

_LEG_TOKEN = re.compile(r"([+-])([CP])(\d+(?:\.\d+)?)", re.ASCII)


@dataclass(frozen=True)
class _Modifiers:
    field: str
    direction: str
    compare: str


def _modifiers(extras: list[str], default_field: str) -> _Modifiers:
    """The trailing `[field] [above|below] [signed]` words, in any order."""
    field = default_field
    direction = "above"
    compare = "abs"
    for extra in extras:
        low = extra.lower()
        if low in ("above", "below"):
            direction = low
        elif low == "signed":
            compare = "signed"
        else:
            field = extra
    return _Modifiers(field, direction, compare)


def _say(fault: CreateFault) -> str:
    """A refusal, in the bot's own words. The route answers the same faults with statuses, and the
    wording here is deliberately longer: it is read without the form that produced it."""
    if fault.kind == "duplicate":
        return f"Already watching {fault.code} ({fault.field})."
    if fault.kind == "threshold":
        return threshold_error(fault.compare, fault.threshold) or ""
    return fault.message


async def watch(ctx: BotContext, args: list[str]) -> str:
    usage = "Usage: /watch <YYYY-MM-DD> <CALL|PUT> <strike> <threshold> [field] [above|below]"
    if len(args) < 4:
        return usage
    option_type = args[1].upper()
    if option_type not in ("CALL", "PUT"):
        return usage
    try:
        strike_date = normalize_strike_date(args[0])
        strike = require_number(args[2])
        threshold = require_number(args[3])
        code = build_spx_code(strike_date, option_type, strike)
    except Exception:  # noqa: BLE001 — the TypeScript's bare `catch`: a word it cannot read is a usage error
        return usage
    m = _modifiers(args[4:7], "option_delta")

    made = await create_single_monitor(
        creating(ctx),
        SingleInput(
            strike_date=strike_date,
            option_type=option_type,
            strike=strike,
            field=m.field,
            threshold=threshold,
            direction=m.direction,
            compare=m.compare,
        ),
    )
    if is_fault(made):
        return _say(made)
    return rule_text(f"Watching {code}", m.field, threshold, m.direction, m.compare)


async def watchcombo(ctx: BotContext, args: list[str]) -> str:
    usage = "Usage: /watchcombo <name> <date> <±C|Pstrike ...> <threshold> [field] [above|below]  (−short +long)"
    if len(args) < 5:
        return usage
    name = args[0]
    try:
        strike_date = normalize_strike_date(args[1])
    except Exception:  # noqa: BLE001 — the TypeScript's bare `catch`, as above
        return usage
    legs: list[ComboLeg] = []
    i = 2
    while i < len(args):
        token = _LEG_TOKEN.fullmatch(args[i].upper())
        if not token:
            break
        sign: Literal[1, -1] = 1 if token[1] == "+" else -1
        legs.append(ComboLeg(sign=sign, option_type="CALL" if token[2] == "C" else "PUT", strike=number(token[3])))
        i += 1
    if len(legs) < 2 or i >= len(args):
        return usage
    try:
        threshold = require_number(args[i])
    except Exception:  # noqa: BLE001 — the TypeScript's bare `catch`, as above
        return usage
    m = _modifiers(args[i + 1 : i + 4], "mid_price")

    made = await create_combo_monitor(
        creating(ctx),
        ComboInput(
            name=name,
            strike_date=strike_date,
            legs=legs,
            field=m.field,
            threshold=threshold,
            direction=m.direction,
            compare=m.compare,
        ),
    )
    if is_fault(made):
        return _say(made)
    return rule_text(f"Watching combo {name} ({len(legs)} legs)", m.field, threshold, m.direction, m.compare)
