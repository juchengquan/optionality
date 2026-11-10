"""What the API accepts for a position (ADR 0009, phase 5). Port of backend/src/schemas/position.ts.

Optional fields default to None, with their defaults applied where used — see
`entrypoints/http/validate.py`.

**Where the Python differs, and why.** A zod schema is a pydantic model, each field carrying the zod
schema it is (`zod.py`), so that a refusal reads as zod's: the dashboard prints it verbatim. A field
the TypeScript writes `.optional()` defaults to None and refuses an explicit null, as zod does;
`.nullish()` takes either. Which keys a PATCH carried is `model_fields_set`.
"""

from typing import Annotated, Literal

from optionality.contract import normalize_strike_date

from .zod import Array, CustomIssue, Enum, Int, Number, Shape, String

DEFAULT_CONTRACTS = 1


def _normalized(value: str) -> str:
    try:
        return normalize_strike_date(value)
    except Exception:  # noqa: BLE001 — the TypeScript's bare `catch`: whatever the domain refuses with
        raise CustomIssue(f"invalid strike_date '{value}': use YYYY-MM-DD or YYYYMMDD") from None


_StrikeDate = String(transform=_normalized)


class LegIn(Shape):
    side: Annotated[Literal["short", "long"], Enum()]
    option_type: Annotated[Literal["CALL", "PUT"], Enum()]
    strike: Annotated[float, Number()]


class PositionIn(Shape):
    name: Annotated[str, String()]
    strike_date: Annotated[str, _StrikeDate]
    #: a single held option is a position too
    legs: Annotated[list[LegIn], Array(min=1)]
    #: unknown for a Position migrated from a combo; P&L then reads unknown rather than inventing one
    entry: Annotated[float | None, Number().nullish()] = None
    contracts: Annotated[int | None, Int(min=1)] = None
    strategy: Annotated[str | None, String().nullish()] = None
    #: the day it was PUT ON, which is not the day it is recorded here. None means no exit schedule: the
    #: decay shape needs a DTE at entry and will not guess one (ADR 0011).
    opened_at: Annotated[str | None, _StrikeDate.nullish()] = None


class PositionPatch(Shape):
    """Legs are never edited here — a different structure is a different holding."""

    entry: Annotated[float | None, Number()] = None
    contracts: Annotated[int | None, Int(min=1)] = None
    strategy: Annotated[str | None, String()] = None
    #: settable after the fact, which is the only way the Positions recorded before this existed can get
    #: one — created_at is right for some of them and wrong for the rest
    opened_at: Annotated[str | None, _StrikeDate] = None


class ClosePositionIn(Shape):
    """Closing a holding: what was paid, and when. Both optional.

    `exit` is per contract, in points, like Entry, and may be left out or null — the owner may not know
    it, and a blank is kept as a blank rather than guessed (ADR 0022). The dashboard prefills it from the
    live Cost to close it is already showing; the service makes no market call here.

    `closed_on` is a New York market date, spelled either way, like Opened. Left out, it is today's
    market date — or the expiry, if that is earlier, since nothing is held past one."""

    exit: Annotated[float | None, Number().nullish()] = None
    closed_on: Annotated[str | None, _StrikeDate] = None
