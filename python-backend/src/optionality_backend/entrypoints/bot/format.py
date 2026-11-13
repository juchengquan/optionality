"""How the bot writes things (ADR 0009, phase 7). Port of backend/src/entrypoints/bot/format.ts.

Telegram has no table markup, so a `<pre>` block with space-aligned columns is the idiom. The rules
are ratified (CLAUDE.md): about forty monospace characters a row, four columns at most, and a new
question gets a new command rather than a fifth column. `<pre>` with HTML parse mode is used ONLY for
table replies — a plain reply must not be parsed as HTML, or a threshold written `<0.6` would vanish
into a tag.

Every string here is asserted character for character in the tests, because they are read on a phone
and a column that wraps is a table that cannot be read at all.

**Where the Python differs, and why.**

- **A cell is measured in UTF-16 code units**, as JavaScript's `.length` and `padEnd` measure it. The
  bell is one code point and two units, and `/quotes` puts it in the FIRST column, so `len` would make
  every row below it a space narrower than the TypeScript's.
- **`/\\s+$/`, `trim` and `split(/\\s+/)` are JavaScript's whitespace** (`JS_WHITESPACE`), not
  `str.strip`'s: the BOM is whitespace to JavaScript and not to Python, and \\x1c-\\x1f the reverse.
- **`py_number` is Python's own `str` of a float**, which is what the TypeScript's `pyNumber`
  reimplements: the bot's figures were written by the old Python's `str()` and the TypeScript kept
  them. So here, and only here, the number is NOT `optionality.js.js_string`.
- **`toFixed` is `fixed`**: the library's `to_fixed` answers `Number(x.toFixed(d))`, a float, and the
  bot wants the TEXT — JavaScript's rounding, and JavaScript's spelling of -0, NaN and 1e21. A pace gap
  of exactly 0.125 is "0.13" in `standing_note`, where Python's format would say "0.12".
- **`String(value)` of a value whose type is not known is `js_text`**, so a boolean is "true" and a
  whole number "4", as JavaScript writes them.
- `escape_html` is the standard library's `html.escape`, which is what the TypeScript's reproduces.
- `BOT_COMMANDS` is a tuple of frozen `BotCommand` records, the TypeScript's `as const`.
"""

import html
import math
from dataclasses import dataclass

from optionality.js import js_string, to_fixed
from optionality.monitor import threshold_fault

from ...holdings import HoldingValue

HELP_TEXT = """Commands:
/holdings — where each Position stands: cost, P&L, pace
/monitors — list the watchlist with live state
/quotes — live prices (mid, bid/ask) for every watched code
/greeks — live delta/gamma/theta for every watched code
/vol — live IV/vega for every watched code
/watch <date> <CALL|PUT> <strike> <threshold> [field] [above|below] [signed] — add a monitor
/watchcombo <name> <date> <±C|Pstrike ...> <threshold> [field] [above|below] [signed] — watch a combo
/unwatch <name, code, id prefix, or contract like 260918 C8100> — remove a monitor
/combo <name> — per-leg breakdown of a combo
/threshold <name or contract> <value> — change a monitor's threshold
/rename <old> <new> — rename a combo (keeps its alarm state and history)
/snapshot <date> <CALL|PUT> <strike> — live quote
(leg signs: − short, the leg you sold; + long)
(dates: YYYY-MM-DD or YYYYMMDD)
/health — service status
/help — this message"""


@dataclass(frozen=True)
class BotCommand:
    command: str
    description: str


#: The "/" autocomplete menu in the Telegram client.
BOT_COMMANDS = (
    BotCommand("holdings", "Where each Position stands: cost, P&L, pace"),
    BotCommand("monitors", "List the watchlist with live state"),
    BotCommand("quotes", "Live prices (mid, bid/ask) for every watched code"),
    BotCommand("greeks", "Live delta/gamma/theta for every watched code"),
    BotCommand("vol", "Live IV/vega for every watched code"),
    BotCommand("watch", "Add a monitor: DATE CALL|PUT strike threshold"),
    BotCommand("watchcombo", "Watch a combo: NAME DATE −short +long Cstrike Pstrike ... threshold"),
    BotCommand("unwatch", "Remove a monitor by name, code, or id prefix"),
    BotCommand("combo", "Per-leg breakdown of a combo"),
    BotCommand("threshold", "Change a monitor's threshold: NAME|contract value"),
    BotCommand("rename", "Rename a combo: OLD NEW"),
    BotCommand("snapshot", "Live quote: DATE CALL|PUT strike"),
    BotCommand("health", "Alarm sweep status"),
    BotCommand("help", "Show usage"),
)

#: Fields the bot prints to three places rather than four.
_FIELD_FORMATS = {
    "option_delta": 3,
    "option_implied_volatility": 3,
}

#: Column headings short enough for forty characters.
FIELD_SHORT = {
    "option_delta": "delta",
    "mid_price": "mid",
    "option_implied_volatility": "IV",
}

#: JavaScript's whitespace — `\s`, and what `trim` removes: WhiteSpace and LineTerminator, which are
#: the ASCII controls, the space, NBSP, the BOM, every Unicode space separator and the two Unicode
#: line terminators. The bot splits and trims typed words with it too (`bot.py`).
JS_WHITESPACE = "\t\n\v\f\r \xa0 " + "".join(map(chr, range(0x2000, 0x200B))) + "    　﻿"


def _is_number(value: object) -> bool:
    """`typeof value === "number"`: a boolean is an int to Python and not a number to JavaScript."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def js_text(value: object) -> str:
    """`String(value)` for what JSON can hold, as JavaScript writes it."""
    if isinstance(value, str):
        return value
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return js_string(float(value))
    if isinstance(value, (list, tuple)):
        # Array.prototype.join, which writes null as nothing
        return ",".join("" if v is None else js_text(v) for v in value)
    return "[object Object]"


def fixed(value: float, digits: int) -> str:
    """`value.toFixed(digits)`: JavaScript's rounding — the exact binary value, half away from zero —
    and JavaScript's text. -0 is "0.00" there, since the sign is taken from `value < 0`; a negative
    that rounds to zero keeps its sign; a value that is not finite, or is 1e21 or more, is written as
    `String` writes it."""
    if not math.isfinite(value) or abs(value) >= 1e21:
        return js_string(value)
    return f"{to_fixed(value + 0.0, digits):.{digits}f}"


def escape_html(value: str) -> str:
    """Python's html.escape, which is quote=True by default: & < > " ' all go — the ampersand first, or
    every entity would be escaped twice. The TypeScript writes it out; here it is the thing itself."""
    return html.escape(value)


def _width(cell: str) -> int:
    """`cell.length`: UTF-16 code units, which is what JavaScript counts."""
    return len(cell.encode("utf-16-le")) // 2


def table(headers: list[str], rows: list[list[str]]) -> str:
    """A `<pre>` table with space-aligned columns.

    Widths are measured on the ESCAPED text, as the old Python did. That is arguably wrong — `&amp;` is
    five characters of width for one character of content — but it is what shipped, and a contract
    code contains no escapable character, so the only rows it could affect are ones that do not occur.
    Faithful, and noted.
    """
    escaped = [[escape_html(js_text(cell)) for cell in row] for row in [headers, *rows]]
    widths = [max(_width(row[i]) if i < len(row) else 0 for row in escaped) for i in range(len(headers))]
    lines = [
        "  ".join(
            cell + " " * max(0, (widths[i] if i < len(widths) else 0) - _width(cell)) for i, cell in enumerate(row)
        ).rstrip(JS_WHITESPACE)
        for row in escaped
    ]
    return "<pre>" + "\n".join(lines) + "</pre>"


def standing_note(v: HoldingValue) -> str:
    """The one thing worth saying about a holding, in a cell.

    A Level reached outranks a pace gap: a Target or a Stop is a decision already made, while the gap
    is only a reading. The gap is said in WORDS, never as a bare sign — CONTEXT.md: "behind" is bad
    while a positive P&L is good, and a sign beside one invites reading the other. That rule is
    the dashboard's too (`frontend/src/next/pace.ts`), and this is its second home on purpose: forty
    characters cannot hold the sentence that one writes.
    """
    s = v.schedule
    if s is None:
        return "—"
    if s["reached"] == "stop":
        return "STOP"
    if s["reached"] == "target":
        return "TARGET"
    if s["manage_by_due"]:
        return "MANAGE"
    if s["pace_gap"] is None:
        return "—"
    return f"{'behind' if s['pace_gap'] > 0 else 'ahead'} {fixed(abs(s['pace_gap']), 2)}"


def has_format(field: str) -> bool:
    """Whether this field has a format of its own, which decides 3 places against 4."""
    return field in _FIELD_FORMATS


def fmt_value(key: str, value: object) -> str:
    """A figure, to the places its field deserves."""
    places = _FIELD_FORMATS.get(key)
    if places is not None and _is_number(value):
        return fixed(float(value), places)  # type: ignore[arg-type]
    # `str(value)` in the old Python, and for a float that is not String(value) — see py_number
    if _is_number(value):
        return py_number(float(value))  # type: ignore[arg-type]
    return js_text(value)


def threshold_error(compare: str, threshold: float) -> str | None:
    """The bot's wording for a threshold the rule refuses, or None.

    Longer than the API's, because it is read without the form that produced it. The rule is
    `threshold_fault` in the library's `monitor`. The arguments are `(compare, threshold)` like every
    other caller of it.
    """
    match threshold_fault(compare, threshold):
        case "abs-not-positive":
            return "Threshold must be positive — abs monitors compare magnitudes. Add 'signed' to compare raw values."
        case "signed-zero":
            return "Signed threshold cannot be 0 (zero-width hysteresis band); use e.g. ±0.01."
        case _:
            return None


def rule_text(prefix: str, field: str, threshold: float, direction: str, compare: str) -> str:
    """What a rule means, said back to the owner so a mistyped direction is visible at once."""
    sign = "≤" if direction == "below" else "≥"
    metric = field if compare == "signed" else f"abs({field})"
    return f"{prefix}: alarm when {metric} {sign} {js_string(threshold)}"


def py_number(value: float) -> str:
    """A float as Python's `str()` renders it — which, here, it is.

    The TypeScript reimplements it, because three differences from `String(value)` reach the owner's
    screen: an integral value keeps its point (`100.0`, where JavaScript writes `100`); below 1e-4
    Python goes exponential (`1.5e-05` against `0.000015`); and at 1e16 it goes exponential too, where
    JavaScript waits until 1e21. What holds those boundaries is the tests, which name each one.
    """
    return str(float(value))
