"""What the API accepts for a monitor (ADR 0009, phase 5). Port of backend/src/schemas/monitor.ts.

Optional fields default to None, with their defaults applied where the value is used — see
`entrypoints/http/validate.py`. The defaults themselves are named here so they are still declared once.

**Where the Python differs, and why.** A zod schema is a pydantic model, each field carrying the zod
schema it is (`zod.py`), so that a refusal reads as zod's: the dashboard prints it verbatim. A field
the TypeScript writes `.optional()` defaults to None and refuses an explicit null, as zod does. The
union of the two creation shapes is a type alias, `MonitorCreateIn`, which `zod.parse` and
`entrypoints/http/validate.py` read as zod reads `z.union`; `is_combo` asks which model a body became.
"""

from typing import Annotated, Any, Literal

from optionality.contract import normalize_strike_date
from optionality.monitor import threshold_fault

from .zod import Array, Boolean, CustomIssue, Enum, Number, Shape, String

DEFAULT_SINGLE_FIELD = "option_delta"
DEFAULT_COMBO_FIELD = "mid_price"
DEFAULT_DIRECTION = "above"
DEFAULT_COMPARE = "abs"
DEFAULT_ENABLED = True


def _normalized(value: str) -> str:
    """Accepts both spellings and always stores the dashed one."""
    try:
        return normalize_strike_date(value)
    except Exception:  # noqa: BLE001 — the TypeScript's bare `catch`: whatever the domain refuses with
        raise CustomIssue(f"invalid strike_date '{value}': use YYYY-MM-DD or YYYYMMDD") from None


StrikeDate = String(transform=_normalized)
_StrikeDate = StrikeDate

#: Every reason the service writes into `disabled_reason`, named once.
#:
#: "unreadable" is the third Quarantine, for a row the engine cannot hydrate at all — corrupt `legs`, or
#: a `strike_date` the domain refuses. It cannot be evaluated and it cannot be drawn, so it is disabled
#: with a notice rather than allowed to fail the sweep for everything else.
#:
#: "unknown-contract" and "no-figure" are the two Quarantines — the service's own doing, because the rule
#: cannot be evaluated — and "manual" is the owner's. "holding-closed" is the owner's too, one step
#: removed: closing a holding switches off the rules that watched it, because a rule left on would go on
#: alarming about contracts no longer held (ADR 0022). It is written by the `/positions/{id}/close`
#: route, never by the engine, and it sends no notice — the owner did it, and the close's own answer says
#: which rules it took. The dashboard groups its muted tables BY this
#: string, and a reason it has no group for renders in no group at all: the row disappears from the page
#: while sitting disabled in the database. So the list is published, and the dashboard is held to it.
type DisabledReason = Literal["unknown-contract", "no-figure", "unreadable", "expired", "manual", "holding-closed"]
DISABLED_REASONS: tuple[DisabledReason, ...] = (
    "unknown-contract",
    "no-figure",
    "unreadable",
    "expired",
    "manual",
    "holding-closed",
)

type Direction = Literal["above", "below"]
type Compare = Literal["abs", "signed"]
type OptionType = Literal["CALL", "PUT"]


def threshold_error(compare: str, threshold: float) -> str | None:
    """The API's wording for a threshold the rule refuses, or None.

    The rule itself is `threshold_fault` in the library's `monitor`, beside the `is_breached` it
    protects. It was written out here, again for PATCH below, and a third time in the bot — twice under
    this same name with the arguments in opposite orders. Only the sentences differ, so only the
    sentences stay at the edges.
    """
    match threshold_fault(compare, threshold):
        case "abs-not-positive":
            return "threshold must be positive when compare='abs' (values are compared as absolutes)"
        case "signed-zero":
            return "signed threshold cannot be 0 (zero-width hysteresis band); use e.g. ±0.01"
        case _:
            return None


def patch_threshold_error(compare: str, threshold: float) -> str | None:
    """The shorter wording the PATCH route uses, kept because the dashboard shows these verbatim."""
    match threshold_fault(compare, threshold):
        case "abs-not-positive":
            return "threshold must be positive when compare='abs'"
        case "signed-zero":
            return "signed threshold cannot be 0; use e.g. ±0.01"
        case _:
            return None


class MonitorIn(Shape):
    strike_date: Annotated[str, _StrikeDate]
    option_type: Annotated[OptionType, Enum()]
    strike: Annotated[float, Number()]
    field: Annotated[str | None, String()] = None
    threshold: Annotated[float, Number()]
    direction: Annotated[Direction | None, Enum()] = None
    compare: Annotated[Compare | None, Enum()] = None
    enabled: Annotated[bool | None, Boolean()] = None


class ComboLegIn(Shape):
    #: MINUS IS SHORT: −1 is a short leg, +1 a long one. The combo's value is the signed sum under those
    #: signs, so a credit structure's value is the NEGATIVE of its cost to close — which `compare: abs`
    #: is indifferent to, and which is why a position-backed row switches to `cost_to_close` on the
    #: dashboard.
    #:
    #: This comment said the opposite until 2026-10-06 ("+ on sold legs watches the cost to close").
    #: Both readings are arithmetically legal and nothing failed, because the sign is otherwise just a
    #: multiplier. It is not harmless: the add-combo form derives a holding's SIDES from these signs, and
    #: the wrong reading inverts every P&L rather than failing. The relationship is pinned in the
    #: domain's position tests — "the sign convention" — rather than left to prose.
    #:
    #: One literal of two values rather than a union of two literals, which answered a 2 here with
    #: "Invalid input" and nothing about what it would have taken.
    sign: Annotated[Literal[1, -1], Enum()]
    option_type: Annotated[OptionType, Enum()]
    strike: Annotated[float, Number()]


class ComboMonitorIn(Shape):
    #: a combo's code IS the name the trader chose; there is no contract to derive one from
    name: Annotated[str, String()]
    strike_date: Annotated[str, _StrikeDate]
    legs: Annotated[list[ComboLegIn], Array(min=2)]
    field: Annotated[str | None, String()] = None
    threshold: Annotated[float, Number()]
    direction: Annotated[Direction | None, Enum()] = None
    compare: Annotated[Compare | None, Enum()] = None
    enabled: Annotated[bool | None, Boolean()] = None


#: Either shape, as the request is DOCUMENTED and typed. The route does not validate with it — see
#: `monitor_create_member`.
type MonitorCreateIn = ComboMonitorIn | MonitorIn


def monitor_create_member(body: Any) -> type[ComboMonitorIn] | type[MonitorIn]:
    """The member a body is meant for, by its shape: a combo carries `legs`, the same test `is_combo`
    puts to a parsed one. The route validates against this member alone.

    A union refused by both members answers "Invalid input" and nothing else, because it cannot know
    whose complaint applies: an unreadable strike date, a missing threshold and an empty body all read
    the same, and the dashboard prints that `detail` verbatim. The shape can know. It also stops a body
    carrying `legs` but no `name` being taken as a single-leg rule with its legs dropped, which the union
    did because the second member accepted what the first refused.
    """
    return ComboMonitorIn if isinstance(body, dict) and "legs" in body else MonitorIn


class MonitorPatch(Shape):
    #: combos only: the name IS the code; single-leg codes are contract-derived
    name: Annotated[str | None, String()] = None
    threshold: Annotated[float | None, Number()] = None
    direction: Annotated[Direction | None, Enum()] = None
    field: Annotated[str | None, String()] = None
    compare: Annotated[Compare | None, Enum()] = None
    enabled: Annotated[bool | None, Boolean()] = None


class TotalEntryIn(Shape):
    entry: Annotated[float, Number()]


def is_combo(payload: ComboMonitorIn | MonitorIn) -> bool:
    return isinstance(payload, ComboMonitorIn)
