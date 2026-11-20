"""Live quotes from moomoo's OpenD, through the Python SDK. Needs the `opend` extra.

    with OpenD() as od:                   # one connection for the whole block, closed even on error
        records, unknown = od.quotes([code, ...])
        problem = od.verify([code])
        grade = od.us_option_grade()      # the account's grade for US options: "LV1", ...

    records, unknown = quotes([code])     # one-shot: opens, asks, closes

The connection is ALWAYS closed on the way out. The TypeScript client learned that the hard way
(#128): every OpenD failure leaked a connection that reconnected for ever. This speaks the SDK's TCP
protocol (port 11111 by default); the service's own client speaks the websocket one.
"""

import math
import re
from collections.abc import Callable
from typing import Any, Self

from optionality.quote import Batch, Quote, mid_price
from optionality.quotes import verify_contracts

#: moomoo rejects the WHOLE batch when any code is unknown, naming the culprit in its error text —
#: without the market prefix. Reading that prose is moomoo's business and so it is done HERE, inside
#: the provider: the port carries the ANSWER, which codes could not be priced (ADR 0015, #168). It
#: lived above the port in `quotes.fetch_resilient` until ADR 0017 noticed the TypeScript had moved.
_UNKNOWN_CODE = re.compile(r"Unknown stock\.?\s+([A-Z0-9.]+)")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 11111
_MISSING = "optionality.opend needs the moomoo SDK: uv add 'optionality[opend]'"


def _moomoo_connect(host: str, port: int) -> Any:
    try:
        # imported here, not at the top: it is heavy and only wanted when asked for
        from moomoo import OpenQuoteContext
    except ModuleNotFoundError as err:
        raise ImportError(_MISSING) from err
    return OpenQuoteContext(host=host, port=port)


# replaced in tests; None stands for "the SDK is not installed"
_sdk_connect: Callable[[str, int], Any] | None = _moomoo_connect


#: the record's fields, exactly the TypeScript's (`typescript/src/vendors/opend/fields.ts`, recorded in
#: `testdata/vendors/opend-fields.json`). The SDK's frame has 143 columns and this kept them all
#: until a side-by-side run of both backends on 2026-11-17 found `/quotes` serving 107 keys the
#: TypeScript does not, and missing one it does.
RECORD_FIELDS: tuple[str, ...] = (
    "code", "name", "update_time", "lot_size", "suspension",
    "last_price", "open_price", "high_price", "low_price", "prev_close_price",
    "ask_price", "bid_price", "ask_vol", "bid_vol", "volume",
    "turnover", "turnover_rate", "amplitude", "avg_price", "bid_ask_ratio",
    "option_type", "stock_owner", "option_strike_time", "option_strike_price",
    "option_contract_size", "option_contract_multiplier", "option_open_interest",
    "option_implied_volatility", "option_premium",
    "option_delta", "option_gamma", "option_vega", "option_theta", "option_rho",
    "option_expiry_date_distance", "option_area_type",
    "mid_price",
)  # fmt: skip

#: where the SDK's column name is not the record's; every other field is read under its own name
_SDK_NAMES = {"option_strike_time": "strike_time"}


#: GetUserInfo's flag for the quote rights alone (`UserInfoField.QOTRIGHT`, #464): what is asked of the
#: account, and nothing else of it. The TypeScript's `USER_INFO_QOT_RIGHT`, recorded in
#: `testdata/vendors/opend-fields.json`.
USER_INFO_QOT_RIGHT = 4

#: moomoo's quote grades (`Qot_Common.QotRight`), by the number OpenD sends, under the SDK's names for
#: them. The TypeScript reads the number off the websocket and translates it with this table; this
#: package reads the SDK's name, and `tests/test_opend.py` holds the SDK's table to this one.
QOT_RIGHTS: dict[int, str] = {0: "N/A", 1: "BMP", 2: "LV1", 3: "LV2", 4: "SF", 5: "NO", 6: "LV3"}


def grade_name(right: Any) -> str:
    """A grade OpenD sent, as the SDK names it (`QotRight.to_string2`): "N/A", moomoo's Unknow, for
    anything that is not one of the listed numbers, an absent field included. Port of `gradeName`."""
    # a bool is an int in Python and not a number in JavaScript, where the TypeScript's test is `typeof`
    if isinstance(right, int) and not isinstance(right, bool) and right in QOT_RIGHTS:
        return QOT_RIGHTS[right]
    return "N/A"


def is_realtime(grade: str) -> bool | None:
    """Whether a grade means the option prices are real-time (#464): Level 1, 2 or 3, or SF, are; BMP
    and NO are not; "N/A", or a name moomoo has not used, says nothing either way. A level, never a
    delay — moomoo states no minutes. Port of `isRealtime`."""
    if grade in ("LV1", "LV2", "LV3", "SF"):
        return True
    if grade in ("BMP", "NO"):
        return False
    return None


def _absent(value: Any) -> bool:
    # the SDK writes the STRING "N/A" where the protobuf had no value, and pandas a NaN where a column
    # had none; the TypeScript's `put` leaves such a key out, so "not there" reads as unknown, never 0
    return value is None or value == "N/A" or (isinstance(value, float) and math.isnan(value))


def _record(row: dict[str, Any]) -> Quote:
    """One SDK row as the TypeScript's `toRecord` builds one from the websocket's protobuf."""
    record: Quote = {}
    for field in RECORD_FIELDS:
        value = row.get(_SDK_NAMES.get(field, field))
        if field != "mid_price" and not _absent(value):
            record[field] = value
    return _with_mid(record)


def _with_mid(record: Quote) -> Quote:
    # the mid is derived, not reported, and only where there is a two-sided quote: both sides and an
    # offer above zero. Out of hours moomoo quotes every option 0/0, and a mid of 0 valued the book
    # at 0.00 (#380). The rule is the domain's, shared by every vendor in both languages.
    mid = mid_price(record.get("bid_price"), record.get("ask_price"))
    if mid is not None:
        record["mid_price"] = mid
    return record


class OpenD:
    def __init__(
        self,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
        connect: Callable[[str, int], Any] | None = None,
    ) -> None:
        self.host, self.port = host, port
        self._connect = connect
        self._ctx: Any = None

    def __enter__(self) -> Self:
        connect = self._connect or _sdk_connect
        if connect is None:
            raise ImportError(_MISSING)
        self._ctx = connect(self.host, self.port)
        return self

    def __exit__(self, *exc: object) -> None:
        if self._ctx is not None:
            self._ctx.close()
            self._ctx = None

    def fetch(self, codes: list[str]) -> list[Quote]:
        """One batch, as moomoo answers it. Raises with moomoo's own words on a refusal, which is what
        `quotes` reads to drop an unknown contract."""
        ret, data = self._ctx.get_market_snapshot(list(codes))
        if ret != 0:
            raise RuntimeError(f"snapshot API failed: {data}")
        return [_record(r) for r in data.to_dict("records")]

    def quotes(self, codes: list[str]) -> Batch:
        """Every quote moomoo has, and the codes it refused as unknown.

        Drops what moomoo names and asks again, so one bad contract cannot take the rest hostage.
        Any other failure — a dead gateway, a quota — is raised untouched: containment engages only
        on the deterministic named-culprit case, because retrying an outage one code at a time would
        present it as a watchlist full of unknown contracts.
        """
        remaining = list(codes)
        unknown: list[str] = []
        while remaining:
            try:
                return Batch(self.fetch(remaining), unknown)
            except Exception as err:
                match = _UNKNOWN_CODE.search(str(err))
                if not match:
                    raise
                culprit = match.group(1).rstrip(".")
                hits = [c for c in remaining if c == culprit or c.endswith(culprit)]
                if not hits:
                    raise  # cannot map the culprit to a code we asked for: a generic failure
                remaining = [c for c in remaining if c not in hits]
                unknown.extend(hits)
        return Batch([], unknown)

    def verify(self, codes: list[str]) -> str | None:
        """Why these contracts cannot be trusted to exist, or None."""
        return verify_contracts(codes, self.quotes)

    def us_option_grade(self) -> str:
        """The account's quote grade for US options, as the SDK names it (`LV1`, `BMP`, `N/A`, ...;
        `QOT_RIGHTS`), from OpenD's GetUserInfo asked for the quote rights alone. Raises with moomoo's
        own words on a refusal.

        `get_user_info` is what the SDK calls an internal reserved function; only `us_option_qot_right`
        is read from it. Not market data: it prices nothing, and `is_realtime` says what it means.
        """
        ret, data = self._ctx.get_user_info(info_field=[USER_INFO_QOT_RIGHT])
        if ret != 0:
            raise RuntimeError(str(data))
        return str(data["us_option_qot_right"])


def quotes(codes: list[str], host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> Batch:
    """One-shot: connect, ask, close."""
    with OpenD(host, port) as od:
        return od.quotes(codes)
