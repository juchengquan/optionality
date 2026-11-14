"""Whether a reading alarms, and what to say about it. Mirrors typescript/src/domain/alarm.ts.

Ported under ADR 0017, which extended the golden cases past the arithmetic to the DECISIONS. The
notice is compared exactly, emoji and all: the direction (`fell ≤` against `crossed ≥`), the
recovery (`back above`, `back below`), the reminder suffix, and the rule, figure and distance in the
short form (#388) — `rule_short`, `figure_short`, `distance_short`, which the dashboard writes too.
Two implementations agreeing on that sentence agree about far more than two agreeing on a boolean.

Nothing here sends anything. `alarm_policy` is deliberately absent: it reads the service's Settings,
so this package takes the two knobs directly, exactly as `exit.ExitPolicy` does.
"""

import math
from datetime import datetime

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from optionality.js import to_fixed
from optionality.monitor import Monitor, is_breached, threshold_distance


class AlarmState(BaseModel):
    """What the database says about this rule right now. Accepts camelCase too, as the cases write it."""

    model_config = ConfigDict(frozen=True, alias_generator=to_camel, populate_by_name=True)
    triggered: bool
    last_alarm_at: datetime | None


class AlarmPolicy(BaseModel):
    model_config = ConfigDict(frozen=True, alias_generator=to_camel, populate_by_name=True)
    cooldown_seconds: float
    repeat_seconds: float


class AlarmDecision(BaseModel):
    model_config = ConfigDict(frozen=True)
    #: the flag's new value, or None when this reading does not change it
    triggered: bool | None
    #: what to send, or None for nothing. Non-None is also exactly when the stamp moves.
    notice: str | None


UNCHANGED = AlarmDecision(triggered=None, notice=None)


def _seconds_since(when: datetime | None, now: datetime) -> float:
    """Never alarmed counts as long ago, not as never: a rule whose first breach the cooldown
    swallowed has a flag and no stamp, and reading that as "too soon" would silence it for ever."""
    if when is None:
        return math.inf
    return (now - when).total_seconds()


class RuleShape(BaseModel):
    """A rule as its short form needs it (#388): the five facts of a Monitor its words turn on.

    `combo` rather than the legs, because the words need only whether it is one — a spread's price
    is its `val`, a contract's its `mid` — and the expiry notice reads a row it has not hydrated.
    """

    model_config = ConfigDict(frozen=True)
    field: str
    combo: bool
    compare: str
    direction: str
    threshold: float


def rule_shape(monitor: Monitor) -> RuleShape:
    """A Monitor's shape, as `monitor_leg_codes` reads a combo: legs present and not empty."""
    return RuleShape(
        field=monitor.field,
        combo=bool(monitor.legs),
        compare=monitor.compare,
        direction=monitor.direction,
        threshold=monitor.threshold,
    )


#: What a rule watches, as a symbol. Vega is `ν`, the Greek letter the other three are, and not
#: `V`, which beside `val` would read as a value. An unknown field is written as it is stored.
_SYMBOLS = {
    "option_delta": "Δ",
    "option_gamma": "Γ",
    "option_theta": "Θ",
    "option_vega": "ν",
    "option_implied_volatility": "IV",
}

#: Fixed places per field, the dashboard's (ADR 0023): a price to the cent, a delta to three, gamma to four.
_PLACES = {"option_delta": 3, "option_gamma": 4}


def _places(field: str) -> int:
    return _PLACES.get(field, 2)


def _fixed(value: float, places: int) -> str:
    """`value.toFixed(places)`, through JavaScript's rounding: 0.0625 is 0.063 here and 0.062 under
    `round`, and the cases carry that difference inside the sentence."""
    return f"{to_fixed(value, places):.{places}f}"


def _symbol(field: str, combo: bool) -> str:
    if field == "mid_price":
        return "val" if combo else "mid"
    return _SYMBOLS.get(field, field)


def _is_cost_to_close(rule: RuleShape) -> bool:
    """A held credit's stop: a combo's signed mid at or below a negative figure (ADR 0013), said as
    the cost to close it watches — `close ≥ 9.44` — and its figure as that cost."""
    return (
        rule.combo
        and rule.field == "mid_price"
        and rule.compare == "signed"
        and rule.direction == "below"
        and rule.threshold < 0
    )


def _says_above(rule: RuleShape) -> bool:
    """Whether the rule as SAID is at-or-above, which every arrow follows. Anything not "below" is above."""
    return _is_cost_to_close(rule) or rule.direction != "below"


def _subject(rule: RuleShape) -> str:
    if _is_cost_to_close(rule):
        return "close"
    symbol = _symbol(rule.field, rule.combo)
    return f"|{symbol}|" if rule.compare == "abs" else symbol


def _minus(text: str) -> str:
    """The real minus, U+2212, as the pace gap writes it."""
    return f"\u2212{text[1:]}" if text.startswith("-") else text


def _typed_places(threshold: float) -> int:
    """The places a threshold was typed with: two at least (`0.20`), and as many more as it carries (`0.125`)."""
    places = 2
    while places < 10 and to_fixed(threshold, places) != threshold:
        places += 1
    return places


def _shown_places(rule: RuleShape) -> int:
    """The figure's and distance's places: the field's, or the threshold's where it was typed finer —
    a mid of 4.506 against 4.505 is not "4.51, past 0.00" (review of #388)."""
    return max(_places(rule.field), _typed_places(rule.threshold))


def _threshold_text(rule: RuleShape) -> str:
    t = -rule.threshold if _is_cost_to_close(rule) else rule.threshold
    return _minus(_fixed(t, _typed_places(t)))


def _size_text(size: float, places: int) -> str:
    """A distance never written as zero when it is not: "<0.001" where it rounds away at these places."""
    if to_fixed(size, places) == 0:
        return f"<{_fixed(10**-places, places)}"
    return _fixed(size, places)


def rule_short(rule: RuleShape) -> str:
    """ "|Δ| ≥ 0.20", "close ≥ 9.44", "val ≤ −1.50": a rule in symbols, with no figure (#388)."""
    return f"{_subject(rule)} {'≥' if _says_above(rule) else '≤'} {_threshold_text(rule)}"


def figure_short(rule: RuleShape, value: float) -> str:
    """The figure as served, to its field's places, with a real minus — or, for a cost to close, that cost."""
    return _minus(_fixed(-value if _is_cost_to_close(rule) else value, _shown_places(rule)))


def distance_short(rule: RuleShape, distance: float) -> str:
    """ "↑2.41" — the way the figure (its SIZE under abs) must move — "▲ at", or "▲ past 0.050";
    `↓`/`▼` for a rule said `≤`. `threshold_distance` measured it; this only says it."""
    up = _says_above(rule)
    places = _shown_places(rule)
    if distance > 0:
        return f"{'↑' if up else '↓'}{_size_text(distance, places)}"
    if distance == 0:
        return f"{'▲' if up else '▼'} at"
    return f"{'▲' if up else '▼'} past {_size_text(-distance, places)}"


def _said(rule: RuleShape, word: str) -> str:
    """The rule with the message's own word in it: "|Δ| crossed ≥ 0.30", "|Δ| back below 0.30".

    Nothing is mirrored: the rule is written as what it compares, so `|Δ|` beside −0.151 is true of
    its size, and the figure stays as served (review 2026-11-01, then #388)."""
    if word.startswith("back"):
        return f"{_subject(rule)} {word} {_threshold_text(rule)}"
    return f"{_subject(rule)} {word} {'≥' if _says_above(rule) else '≤'} {_threshold_text(rule)}"


def _reading(rule: RuleShape, monitor: Monitor, value: float) -> str:
    d = threshold_distance(value, monitor.threshold, monitor.direction, monitor.compare)
    figure = figure_short(rule, value)
    return figure if d is None else f"{figure}  {distance_short(rule, d)}"


def alarm_transition(
    monitor: Monitor,
    value: float,
    name: str,
    state: AlarmState,
    policy: AlarmPolicy,
    now: datetime,
) -> AlarmDecision:
    rule = rule_shape(monitor)
    breached = is_breached(value, monitor.threshold, monitor.direction, monitor.compare)
    if breached == state.triggered:
        # the flag already says this; the only thing left to decide is whether to re-remind
        if not breached:
            return UNCHANGED
        repeat = policy.repeat_seconds
        if not repeat or _seconds_since(state.last_alarm_at, now) < repeat:
            return UNCHANGED
        return AlarmDecision(
            triggered=None,
            notice=f"⚠️ {name}: {_said(rule, 'still')} — {_reading(rule, monitor, value)} (reminder)",
        )

    # the state changed, and it is written whether or not the owner hears about it
    if _seconds_since(state.last_alarm_at, now) < policy.cooldown_seconds:
        return AlarmDecision(triggered=breached, notice=None)
    above = _says_above(rule)
    if breached:
        words = f"⚠️ {name}: {_said(rule, 'crossed' if above else 'fell')} — {_reading(rule, monitor, value)}"
    else:
        words = f"✅ {name}: {_said(rule, 'back below' if above else 'back above')} — {_reading(rule, monitor, value)}"
    return AlarmDecision(triggered=breached, notice=words)
