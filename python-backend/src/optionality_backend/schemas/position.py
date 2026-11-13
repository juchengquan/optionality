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


#: The most of one Contract a leg may hold per unit of its structure (#351): a 1×2 ratio, a butterfly's
#: middle, a 1×3×2 broken wing all fit in single figures. The size of a trade is `contracts`, so a larger
#: figure here is a typo — a strike in the wrong box — far more often than a structure.
MAX_LEG_QTY = 10


class LegIn(Shape):
    side: Annotated[Literal["short", "long"], Enum()]
    option_type: Annotated[Literal["CALL", "PUT"], Enum()]
    strike: Annotated[float, Number()]
    #: how many of this Contract one of the structure holds; 1 when not given (#351)
    qty: Annotated[int | None, Int(min=1, max=MAX_LEG_QTY)] = None


def stored_qty(qty: int | None) -> dict[str, int]:
    """A leg's quantity as a stored leg carries it: only where it is not 1, so a leg of one is stored
    exactly as every leg was before quantities existed, and there is one spelling for it (#351)."""
    return {} if qty is None or qty == 1 else {"qty": qty}


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


class PayoffLegIn(LegIn):
    """A Position's leg with a strike above zero: the payoff's left end is SPX at zero, and a strike
    there is no contract. PayoffIn's own rule, so PositionIn's legs are untouched."""

    strike: Annotated[float, Number(positive=True)]


class PayoffIn(Shape):
    """Draft legs and an Entry, for the payoff at expiry they would have (#291): what the add form previews
    before anything is saved, and what a watched spread is drawn with at its current value. A Position's
    legs and count without a name or an expiry, and an Entry that is REQUIRED: a curve is drawn at a
    credit and there is no other."""

    legs: Annotated[list[PayoffLegIn], Array(min=1)]
    #: points per contract, signed as a Position's: a credit received positive, a debit negative
    entry: Annotated[float, Number()]
    contracts: Annotated[int | None, Int(min=1)] = None


class PositionPatch(Shape):
    """Legs are never edited here — a different structure is a different holding."""

    entry: Annotated[float | None, Number()] = None
    contracts: Annotated[int | None, Int(min=1)] = None
    strategy: Annotated[str | None, String()] = None
    #: settable after the fact, which is the only way the Positions recorded before this existed can get
    #: one — created_at is right for some of them and wrong for the rest
    opened_at: Annotated[str | None, _StrikeDate] = None
    #: a CLOSED holding's exit and close day, correctable after the fact (ADR 0022) — a mistyped close was
    #: otherwise fixable only by deleting, which loses the samples. Refused on a holding still held. A null
    #: exit CLEARS it back to blank, as a close may leave it — the one PATCH field that takes a null, so
    #: whether it was SENT is `model_fields_set`, never `is not None`.
    exit: Annotated[float | None, Number().nullish()] = None
    closed_on: Annotated[str | None, _StrikeDate] = None


class ClosePositionIn(Shape):
    """Closing a holding: what was paid, and when. Both optional.

    `exit` is per contract, in points, like Entry, and may be left out or null — the owner may not know
    it, and a blank is kept as a blank rather than guessed (ADR 0022). The dashboard prefills it from the
    live Cost to close it is already showing; the service makes no market call here.

    `closed_on` is a New York market date, spelled either way, like Opened. Left out, it is today's
    market date — or the expiry, if that is earlier, since nothing is held past one."""

    exit: Annotated[float | None, Number().nullish()] = None
    closed_on: Annotated[str | None, _StrikeDate] = None
