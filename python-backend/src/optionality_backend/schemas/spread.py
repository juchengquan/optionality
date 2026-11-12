"""What the API accepts for adding spreads in one step (#293, ADR 0023). Port of
backend/src/schemas/spread.ts.

A spread is legs on one expiry, and it is added either HELD — a Position, with its Entry and Opened —
or only WATCHED; either way with the Monitors it starts with. The expiry is given once for the whole
request, because a condor entered as two spreads shares it and typing it twice was the old form's
commonest chore.

A Monitor here is written in terms of its spread rather than as `POST /monitors` takes one: with no leg
named it watches the spread's VALUE, a combo over its legs (minus is short, ADR 0013); naming a leg's
type and strike watches that one contract. Optional fields default to None, with their defaults applied
where used — see `entrypoints/http/validate.py`.

**Where the Python differs, and why.** As `position.py` and `monitor.py`: each field carries the zod
schema it is (`zod.py`), declared in the TypeScript's order, because the order of a shape's keys is the
order a refusal lists its issues in.
"""

from typing import Annotated

from .monitor import Compare, Direction, OptionType, StrikeDate
from .position import LegIn
from .zod import Array, Boolean, Enum, Int, Number, Shape, String


class SpreadMonitorIn(Shape):
    #: the leg watched, by type and strike — both, or neither for the spread's value
    option_type: Annotated[OptionType | None, Enum()] = None
    strike: Annotated[float | None, Number()] = None
    #: `mid_price` for the value, `option_delta` for a leg, when not given
    field: Annotated[str | None, String()] = None
    threshold: Annotated[float, Number()]
    direction: Annotated[Direction | None, Enum()] = None
    compare: Annotated[Compare | None, Enum()] = None


class SpreadIn(Shape):
    #: the holding's name when held, and the value Monitor's code either way
    name: Annotated[str, String(min=1)]
    #: a condor at most: with the eight spreads below, the one probe asks for no more than 32 codes
    legs: Annotated[list[LegIn], Array(min=1, max=4)]
    #: True records a Position; False records only the Monitors
    held: Annotated[bool, Boolean()]
    #: a holding's, as POST /positions takes them; refused on a spread that is only watched
    entry: Annotated[float | None, Number().nullish()] = None
    contracts: Annotated[int | None, Int(min=1)] = None
    opened_at: Annotated[str | None, StrikeDate.nullish()] = None
    #: the Monitors it starts with: a default switched off is simply not sent
    monitors: Annotated[list[SpreadMonitorIn], Array()]


class SpreadsIn(Shape):
    strike_date: Annotated[str, StrikeDate]
    #: at most eight, so the request's ONE probe is bounded in size as well as in number
    spreads: Annotated[list[SpreadIn], Array(min=1, max=8)]
