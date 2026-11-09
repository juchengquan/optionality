"""What the API accepts for a Reference (ADR 0018, amended by 0019). Port of
backend/src/schemas/reference.ts.

A RAW code, not an expiry/type/strike: `build_spx_code` writes `US.SPXW` + six digits + C/P +
strike×1000 and cannot spell `US.SPY` at all, and a Reference is a Security rather than a Contract —
anything a Provider can quote, named by a code. Allowing an option through costs nothing on the way in
and gives, free, the ability to watch a strike with no rule on it.

Optional fields default to None and their meaning is applied where the value is used, as every other
schema here does — see `entrypoints/http/validate.py`.

**Where the Python differs, and why.** A zod schema is a pydantic model, each field carrying the zod
schema it is (`zod.py`), so that a refusal reads as zod's: the dashboard prints it verbatim.
"""

from typing import Annotated

from .sources import SOURCES, Source
from .zod import Enum, Shape, String

#: Trimmed and upper-cased: every code in this service is upper-case — `build_spx_code` writes them that
#: way and moomoo's own `stock_owner` hands them back that way — so `us.spy` typed into a box is the same
#: Security and must not become a second row the live probe then refuses.
_Code = String(trim=True, min=1, transform=str.upper)

__all__ = ["SOURCES", "ReferenceIn", "Source"]


class ReferenceIn(Shape):
    code: Annotated[str, _Code]
    #: what to call it, or absent for "the code is its own name". More useful since the scale went:
    #: `^GSPC`, `US..SPX` and `SPX` are three vendors' names for one index, and none of them is what the
    #: owner calls it.
    label: Annotated[str | None, String(trim=True, min=1)] = None
    #: required, because a Reference whose vendor is unknown cannot be fetched at all. `scale` was here
    #: until ADR 0019: it existed for SPY×10 standing in for SPX, and a scaled stand-in is a simulation
    #: rather than a reading.
    source: Annotated[Source, Enum()]
