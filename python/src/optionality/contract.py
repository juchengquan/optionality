"""SPX contract codes. Mirrors backend/src/domain/contract.ts."""

import re
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict

type OptionType = Literal["CALL", "PUT"]

_ISO_DATE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
_COMPACT_DATE = re.compile(r"(\d{4})(\d{2})(\d{2})")


def _parse_strike_date(strike_date: str) -> tuple[str, str, str]:
    m = _ISO_DATE.fullmatch(strike_date) or _COMPACT_DATE.fullmatch(strike_date)
    if not m:
        raise ValueError(f"invalid strike_date: {strike_date}")
    y, mo, d = m.groups()
    # Date.UTC reads a year below 100 as 19xx, so the TypeScript refuses those as rolled dates
    if int(y) < 100:
        raise ValueError(f"invalid strike_date: {strike_date}")
    try:
        date(int(y), int(mo), int(d))
    except ValueError:
        raise ValueError(f"invalid strike_date: {strike_date}") from None
    return y, mo, d


def normalize_strike_date(strike_date: str) -> str:
    """`2026-11-20` or `20261120`, always returned dashed. Refuses a date that does not exist."""
    y, mo, d = _parse_strike_date(strike_date)
    return f"{y}-{mo}-{d}"


def build_spx_code(strike_date: str, option_type: str, strike: float) -> str:
    """`US.SPXW` + yymmdd + C or P + the strike times 1000, as moomoo names a weekly."""
    y, mo, d = _parse_strike_date(strike_date)
    letter = "C" if option_type.upper() == "CALL" else "P"
    return f"US.SPXW{y[2:]}{mo}{d}{letter}{int(strike)}000"


def compact_strike_date(strike_date: str) -> str:
    """`2026-10-16` -> `261016`: the six digits a code carries, and the bot's short form with it."""
    y, mo, d = _parse_strike_date(strike_date)
    return f"{y[2:]}{mo}{d}"


class SpxContract(BaseModel):
    """A contract's three facts — exactly what build_spx_code is given."""

    model_config = ConfigDict(frozen=True)
    strike_date: str
    option_type: OptionType
    strike: float


# Strict, because it is build_spx_code's inverse and nothing else: a leading-zero strike parses to a
# number whose own code is a different string, so it is refused rather than round-tripped.
_SPX_CODE = re.compile(r"US\.SPXW(\d{2})(\d{2})(\d{2})([CP])(0|[1-9]\d*)000")
_SHORT_CODE = re.compile(r"(\d{2})(\d{2})(\d{2})([CP])(0|[1-9]\d*)")


def parse_spx_code(code: str) -> SpxContract | None:
    """build_spx_code read backwards, or None for any string it could not have written.

    None and not a raise: the strings arriving here come from a provider, the database or a person
    typing into Telegram, and every caller's answer to one it does not recognise is to leave it
    alone. The code carries two year digits, so this reads them as 20YY — which is what
    build_spx_code wrote, and the only reading that round-trips (ADR 0015).
    """
    m = _SPX_CODE.fullmatch(code)
    if not m:
        return None
    yy, mo, d, letter, strike = m.groups()
    try:
        # a well-formed code can still name 2026-02-30, and a day nothing expires on is worse than None
        strike_date = normalize_strike_date(f"20{yy}{mo}{d}")
    except ValueError:
        return None
    return SpxContract(
        strike_date=strike_date,
        option_type="CALL" if letter == "C" else "PUT",
        strike=float(strike),
    )


def short_spx_code(code: str) -> str:
    """`US.SPXW261030C8100000` as `261030 C8100`. The SPXW and the trailing 000 are on every contract
    this service can create, so they carry no information and cost twelve of the bot's forty
    characters. Anything this cannot read is returned untouched."""
    c = parse_spx_code(code)
    if c is None:
        return code
    letter = "C" if c.option_type == "CALL" else "P"
    return f"{compact_strike_date(c.strike_date)} {letter}{int(c.strike)}"


def expand_spx_short(short: str) -> str | None:
    """short_spx_code read backwards: what the bot prints is what /unwatch accepts. Spaces and case
    are a person's, not the grammar's, so they are stripped before matching."""
    m = _SHORT_CODE.fullmatch(re.sub(r"\s+", "", short).upper())
    if not m:
        return None
    yy, mo, d, letter, strike = m.groups()
    try:
        return build_spx_code(f"20{yy}{mo}{d}", "CALL" if letter == "C" else "PUT", float(strike))
    except ValueError:
        return None
