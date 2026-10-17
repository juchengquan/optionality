"""SPX contract codes. Mirrors backend/src/domain/contract.ts."""

import re
from datetime import date

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
