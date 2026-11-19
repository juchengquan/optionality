"""The MCP door's tools (ADR 0026): what each one reads, how its arguments are checked, the short shared
cache in front of the live ones, and the one way an answer is written. Port of
backend/src/entrypoints/mcp/tools.ts.

**A tool is a GET of the API's own, and nothing else.** Each names one path the HTTP door already
serves, and its answer's `data` is that GET's body, its figures rounded by key (#454: `by_key`, by the
table in `server.json`, the one change it makes). The tool cannot compute anything of its own, so it
cannot disagree with the route — or with the dashboard, which reads the same route — and it cannot
write: the only thing this module is handed is `read`, which `app.py` builds to issue a GET and nothing
else. No service, no query and no engine is imported here; a test (`tests/entrypoints/mcp/test_server.py`)
holds this package's imports to that.

**The table is shared ground**, `schema/mcp/server.json`, read by both backends (ADR 0021): the names,
the descriptions an agent reads, the input schemas and which tools are live are written once, so the
two cannot describe the same tool in two ways. What is CODE is here: the argument check, how a history
tool's name becomes an id (`_LOOKUPS`), the path a call becomes, the cache, the rounding and the text.
Which key is rounded to how many places is the table's (each tool's `round`, and `rounding.by_field`), so
the two backends round exactly the same figures.

**The cache** is the owner's decision 7 on #447: the live reads — `/quotes`, `/positions/values`,
`/references` — ask the Provider, whose snapshot limit (60 per 30 seconds) is shared with the sweep and
the page, so an agent in a loop could otherwise starve the alarms. Every caller within `LIVE_FOR_MS` of a
read gets that read, with the time it was made; a read still in flight is joined rather than repeated.
Keyed by the path alone — those three take no arguments — so no argument can bust it. The page and the
sweep never pass through here.

**`price_spreads` is live and NOT cached here** (ADR 0027, `"cached_by": "route"`): its route,
`GET /spreads/quote`, shares its batch for 5 seconds and caps its calls whoever asks, so a second window
in front of it would only serve a batch up to ten seconds old. Its arguments are the one structured input
a tool takes: `_QUERIES` writes them as the route's query, checking only what it must to write it, and
every other refusal is the route's 422 in the route's words.

**Where the Python differs, and why.**

- **The text is written by hand, with `js_string` for every number**: the scenarios compare an
  answer's TEXT exactly, and Python's `json.dumps` writes `1.0` and `1e-05` where JavaScript writes `1`
  and `0.00001`. Keys are sorted in both languages, which is what makes the two bodies' key orders —
  which the HTTP scenarios do not compare — not matter.
- **The argument pattern is matched against the string as JavaScript holds it**, in UTF-16 code units: a
  character beyond the Basic Multilingual Plane is two of them there, so `{1,64}` counts it twice and the
  pattern's surrogate range refuses it, where Python would count one code point and accept it.
- **A name is trimmed with JavaScript's whitespace** (`_JS_WHITESPACE`), not `str.strip()`'s, which takes
  U+001C–U+001F and U+0085 that `trim` does not and would answer a name the TypeScript does not find.
- **A number is written into a query as JavaScript writes it** (`js_string`), and the query is encoded as
  `encodeURIComponent` encodes it (`quote` with `!*'()` kept), because the `source` an answer names is
  compared as text. A bool is not a number, as `typeof` says.
- **A figure is rounded with `to_fixed`, never `round()`**: `round()` takes an exact half to the even
  neighbour (0.125 to 0.12) where `toFixed` goes away from zero (0.13), and a bool is no number to round.
- **A shared read is an `asyncio.Task`**, which every caller awaits through `asyncio.shield`: awaiting a
  task directly cancels it when the awaiting request is cancelled, which would cancel it for everyone
  else sharing it. A JavaScript promise has no such reach.
"""

import asyncio
import json
import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, NotRequired, TypedDict
from urllib.parse import quote

from optionality.alarm import RuleShape, rule_short
from optionality.contract import expand_spx_short
from optionality.js import js_string, to_fixed
from optionality.timefmt import display_time

from ...ports import Read

#: How long a live read is shared, in milliseconds (#447, decision 7: "~5s").
LIVE_FOR_MS = 5000


class Tool(TypedDict):
    """One tool as `schema/mcp/server.json` states it."""

    name: str
    title: str
    description: str
    #: the API path it GETs, with `{id}` where its one argument goes
    path: str
    #: whether it asks the Provider, and so is shared for `LIVE_FOR_MS` — unless `cached_by` says its route
    #: shares it already
    live: bool
    #: "route" where the route shares its own answers (ADR 0027), so this door does not
    cached_by: NotRequired[str]
    #: how its answer's figures are rounded, by key (#454): see `by_key`
    round: "Rounding"
    inputSchema: dict[str, Any]


class Rounding(TypedDict, total=False):
    """How one tool's figures are rounded (#454), by the KEY each figure is under: `keys` names a key and
    its places, for a number under it or each number in a list under it; `maps` names a key whose value is
    a map — a leg's reading by contract code — and the places of its every value; `by_field` names the keys
    a rule's figure is under, rounded by the places of the rule's own `field`."""

    keys: dict[str, int]
    maps: dict[str, int]
    by_field: list[str]


class Described(TypedDict):
    server: dict[str, Any]
    #: the places of a rule's figure, by the field it watches (#454)
    rounding: dict[str, Any]
    tools: list[Tool]


#: `schema/mcp/server.json`, resolved from this module as `db/open.py` resolves `schema/`.
DESCRIBED: Described = json.loads(
    (Path(__file__).resolve().parents[5] / "schema" / "mcp" / "server.json").read_text("utf-8")
)


class ToolResult(TypedDict):
    """What a `tools/call` answers (MCP's CallToolResult): the text, and `isError` only on a failure."""

    content: list[dict[str, str]]
    isError: NotRequired[bool]


def canonical(value: Any) -> str:
    """JSON with every object's keys sorted and nothing between the tokens, as JavaScript writes it.

    Sorted because the two backends build their bodies in their own key order, and the scenarios compare
    an answer's TEXT exactly (ADR 0021); `tools.ts` writes the same bytes by the same rule."""
    if value is None or value is True or value is False:
        return json.dumps(value)
    if isinstance(value, int | float):
        number = float(value)
        # JSON.stringify writes what JSON cannot hold as null
        return js_string(number) if math.isfinite(number) else "null"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return f"[{','.join(canonical(v) for v in value)}]"
    return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{canonical(value[k])}" for k in sorted(value)) + "}"


def round_to(value: float, places: int) -> float:
    """A figure to `places` decimals, half away from zero on the value the double holds — `toFixed`'s
    rule, which `to_fixed` reproduces, NEVER `round()`, which takes an exact half to the even neighbour —
    and a zero rounded from a negative made 0, so neither backend can write -0. Held to
    `testdata/mcp/rounding.json`, as `tools.ts`' `roundTo` is."""
    return to_fixed(float(value), places) + 0.0


def by_key(data: Any, rounding: Rounding, figure: Callable[[float, int | None], float]) -> Any:
    """`data` with every number replaced by `figure(number, places)`, where `places` is what `rounding`
    says for the key it is under, or None where the table names none (#454). `tools.ts`' `byKey`, rule for
    rule: a number takes its places from the key directly above it — `keys`, or for one of `by_field`'s
    keys from the object's own `field` through `DESCRIBED["rounding"]["by_field"]`; a list of numbers
    under a key takes that key's; a map under one of `maps`' keys takes its places for every value; and an
    object starts afresh, in a list or not."""
    keys = rounding.get("keys", {})
    maps = rounding.get("maps", {})
    by_field = rounding.get("by_field", [])
    # every watchable field, None where it is a count, a strike or a size and never rounded
    fields: dict[str, int | None] = DESCRIBED["rounding"]["by_field"]

    def each(value: Any, places: int | None) -> Any:
        if _is_number(value):
            return figure(value, places)
        if isinstance(value, list):
            return [figure(v, places) if _is_number(v) else walk(v) for v in value]
        return walk(value)

    def walk(value: Any) -> Any:
        if _is_number(value):
            return figure(value, None)
        if isinstance(value, list):
            return [walk(v) for v in value]
        if not isinstance(value, dict):
            return value
        field = value.get("field")
        field_places = fields.get(field) if isinstance(field, str) else None
        out: dict[str, Any] = {}
        for key, v in value.items():
            places = keys.get(key)
            if places is None and key in by_field:
                places = field_places
            if places is not None:
                out[key] = each(v, places)
            elif key in maps and isinstance(v, dict):
                out[key] = {code: each(x, maps[key]) for code, x in v.items()}
            else:
                out[key] = each(v, None)
        return out

    return walk(data)


def rounded(data: Any, rounding: Rounding) -> Any:
    """`data` with its figures rounded as `rounding` says, and every other value as it was."""
    return by_key(data, rounding, lambda value, places: value if places is None else round_to(value, places))


def _failed(text: str) -> ToolResult:
    return {"content": [{"type": "text", "text": text}], "isError": True}


def argument_fault(tool: Tool, args: Any) -> str | None:
    """Why these arguments are not this tool's, in words an agent can correct itself from, or None."""
    if args is None:
        args = {}
    if not isinstance(args, dict):
        return "arguments must be an object"
    schema = tool["inputSchema"]
    properties: dict[str, dict[str, str]] = schema["properties"]
    required: list[str] = schema.get("required", [])
    named = list(properties)
    extra = sorted(k for k in args if k not in named)
    if extra:
        takes = "takes no arguments" if not named else "takes only " + ", ".join(f'"{n}"' for n in named)
        return f'unexpected argument "{extra[0]}": {tool["name"]} {takes}'
    for name in required:
        if name not in args:
            return f'missing argument "{name}"'
    for name in named:
        if name not in args:
            continue
        value = args[name]
        # a structured argument is its tool's to check, as it writes the query (`_QUERIES`)
        if properties[name].get("type") != "string" or "pattern" not in properties[name]:
            continue
        pattern = properties[name]["pattern"]
        # anchored with ^…$, so `fullmatch` with ASCII classes, as the README says of such a regex
        if not isinstance(value, str) or re.fullmatch(pattern, _utf16(value), re.ASCII) is None:
            return f'argument "{name}" must be a string matching {pattern}'
    return None


class _Fault(Exception):
    """Why an agent's arguments cannot be written as a query, in words it can correct itself from."""


def _is_number(value: object) -> bool:
    """A finite JSON number, as `typeof value === "number" && Number.isFinite(value)`: a bool is not one."""
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(float(value))


def _keys_fault(value: dict[str, Any], at: str, noun: str, keys: list[str], required: list[str]) -> str | None:
    """Why an object is not one with exactly these keys, these `required`, or None."""
    for key in required:
        if key not in value:
            return f'{at} is missing "{key}"'
    extra = sorted(k for k in value if k not in keys)
    if extra:
        return f'{at} has an unexpected "{extra[0]}": a {noun} takes only ' + ", ".join(f'"{k}"' for k in keys)
    return None


#: The pattern an expiry must match before it is written into a query: `server.json`'s, read there.
_EXPIRY_PATTERN = "^[0-9]{4}-?[0-9]{2}-?[0-9]{2}$"


def _structure_text(value: Any, at: str) -> str:
    """One structure as the route's `spread` reads it, `<expiry>:<legs>[@<entry>]`, or `_Fault` saying why
    it cannot be written. Only the shape and the types: what the route would refuse it refuses, in its
    words. A None `qty` or `entry` is one not given."""
    if not isinstance(value, dict):
        raise _Fault(f"{at} must be an object")
    fault = _keys_fault(value, at, "structure", ["expiry", "legs", "entry"], ["expiry", "legs"])
    if fault is not None:
        raise _Fault(fault)
    expiry, legs, entry = value["expiry"], value["legs"], value.get("entry")
    if not isinstance(expiry, str) or re.fullmatch(_EXPIRY_PATTERN, _utf16(expiry), re.ASCII) is None:
        raise _Fault(f"{at}.expiry must be a string matching {_EXPIRY_PATTERN}")
    if not isinstance(legs, list):
        raise _Fault(f"{at}.legs must be a list of legs")
    written: list[str] = []
    for i, leg in enumerate(legs):
        where = f"{at}.legs[{i}]"
        if not isinstance(leg, dict):
            raise _Fault(f"{where} must be an object")
        fault = _keys_fault(
            leg, where, "leg", ["side", "option_type", "strike", "qty"], ["side", "option_type", "strike"]
        )
        if fault is not None:
            raise _Fault(fault)
        side, type_, strike, qty = leg["side"], leg["option_type"], leg["strike"], leg.get("qty")
        if side not in ("short", "long") or not isinstance(side, str):
            raise _Fault(f'{where}.side must be "short" or "long"')
        if type_ not in ("CALL", "PUT") or not isinstance(type_, str):
            raise _Fault(f'{where}.option_type must be "CALL" or "PUT"')
        if not _is_number(strike):
            raise _Fault(f"{where}.strike must be a number")
        if qty is not None and not _is_number(qty):
            raise _Fault(f"{where}.qty must be a number")
        times = "" if qty is None else f"x{js_string(float(qty))}"
        written.append(f"{'-' if side == 'short' else '+'}{type_[0]}{js_string(float(strike))}{times}")
    if entry is not None and not _is_number(entry):
        raise _Fault(f"{at}.entry must be a number")
    tail = "" if entry is None else f"@{js_string(float(entry))}"
    return f"{expiry}:{','.join(written)}{tail}"


def _encode_uri_component(text: str) -> str:
    """JavaScript's `encodeURIComponent`: every byte but the unreserved and `!*'()` escaped."""
    return quote(text, safe="!*'()")


def _price_spreads_query(given: dict[str, Any]) -> str:
    structures = given.get("structures")
    if not isinstance(structures, list):
        raise _Fault('"structures" must be a list of structures')
    return "&".join(
        f"spread={_encode_uri_component(_structure_text(s, f'structures[{i}]'))}" for i, s in enumerate(structures)
    )


#: The query a tool's structured arguments become, by tool: its path is the table's, and this is what
#: follows the `?`. Only `price_spreads` has one (ADR 0027).
_QUERIES: dict[str, Callable[[dict[str, Any]], str]] = {"price_spreads": _price_spreads_query}


def _utf16(text: str) -> str:
    """`text` as JavaScript holds it, one character per UTF-16 code unit: what a JavaScript regex sees."""
    units = text.encode("utf-16-le", "surrogatepass")
    return "".join(chr(int.from_bytes(units[i : i + 2], "little")) for i in range(0, len(units), 2))


#: JavaScript's whitespace and line terminators, what `String.prototype.trim` takes.
_JS_WHITESPACE = "\t\n\v\f\r \xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

#: What a resolved id must be before a path is built from it: the service's own ids are all this.
_AN_ID = re.compile(r"[A-Za-z0-9_-]{1,64}", re.ASCII)

Row = dict[str, Any]


@dataclass(frozen=True)
class _Lookup:
    """How a history tool's `id` — an id OR a name (#447's follow-up, decided 2026-11-18) — becomes the one
    id its path is built from: the list GET that holds every candidate, the rows `given` names, in order of
    precedence, and the words for each.

    Resolved through a GET the API already serves, never a query of its own, so the door still reads through
    `read` alone; and the INPUT never reaches a path — only an id read back from that list, held to `_AN_ID`
    — so a name like `../quotes` is looked up and not found, never followed."""

    list: str
    #: what one is called in the words, "rule" or "holding"
    noun: str
    #: the rows `given` names: by exact id first, and only where none has it, by name
    named: Callable[[list[Row], str], list[Row]]
    #: one candidate, as an agent picks between several
    label: Callable[[Row], str]
    #: what was tried, for the words when nothing matched
    tried: Callable[[str], str]
    #: the tool that lists every candidate's id
    lister: str


def _by_id(rows: list[Row], given: str) -> list[Row]:
    return [r for r in rows if r.get("id") == given]


def _holdings_named(rows: list[Row], given: str) -> list[Row]:
    # names are unique (`ix_positions_name`), and /positions lists the closed ones too
    return _by_id(rows, given) or [r for r in rows if r.get("name") == given]


def _rules_named(rows: list[Row], given: str) -> list[Row]:
    # a rule's code as stored — a combo's name, a contract's `US.SPXW…` — or a contract the way the page
    # and the bot write it, read by the bot's own `/unwatch` parser
    exact = _by_id(rows, given)
    if exact:
        return exact
    contract = expand_spx_short(given)
    return [r for r in rows if r.get("code") == given or (contract is not None and r.get("code") == contract)]


def _rule_label(r: Row) -> str:
    legs = r.get("legs")
    shape = RuleShape(
        field=str(r.get("field")),
        combo=isinstance(legs, list) and len(legs) > 0,
        compare=str(r.get("compare")),
        direction=str(r.get("direction")),
        threshold=r.get("threshold"),
    )
    return f"{r['id']} — {rule_short(shape)}"


def _rules_tried(given: str) -> str:
    contract = expand_spx_short(given)
    tail = "" if contract is None else f", and as the contract {contract}"
    return f"as a rule's id, as its code or combo name{tail}"


_LOOKUPS: dict[str, _Lookup] = {
    "holding_history": _Lookup(
        list="/positions",
        noun="holding",
        named=_holdings_named,
        label=lambda r: f"{r['id']} — {r.get('name')}",
        tried=lambda given: "as a holding's id and as its name",
        lister="positions",
    ),
    "monitor_history": _Lookup(
        list="/monitors",
        noun="rule",
        named=_rules_named,
        label=_rule_label,
        tried=_rules_tried,
        lister="watchlist",
    ),
}


def _detail_of(body: str) -> str:
    """The `detail` of a refusal, as the dashboard reads it, or the body itself where it has none."""
    try:
        parsed = json.loads(body)
    except ValueError:
        return body  # not JSON: the body is the words
    if isinstance(parsed, dict) and isinstance(parsed.get("detail"), str):
        return parsed["detail"]
    return body


@dataclass(frozen=True)
class _Reading:
    at: datetime
    answer: "asyncio.Task[tuple[int, str]]"


class Toolbox:
    """The tools, bound to the API they read: `call` answers one `tools/call`."""

    def __init__(self, read: Read, now: Callable[[], datetime], display_tz: str) -> None:
        self._read = read
        self._now = now
        self._display_tz = display_tz
        #: the live reads, by path: one per path, shared until it is `LIVE_FOR_MS` old
        self._shared: dict[str, _Reading] = {}
        self.tools = DESCRIBED["tools"]

    def has(self, name: str) -> bool:
        return any(t["name"] == name for t in self.tools)

    def _fresh(self, path: str, authorization: str | None) -> _Reading:
        # begun at once, as a JavaScript promise is, so a caller that joins it joins one read
        return _Reading(self._now(), asyncio.create_task(self._read(path, authorization)))

    def _live(self, path: str, authorization: str | None) -> _Reading:
        at = self._now()
        held = self._shared.get(path)
        # a clock that went BACK is no reason to trust an old answer: read again
        if held is not None and held.at <= at and (at - held.at).total_seconds() * 1000 < LIVE_FOR_MS:
            return held
        reading = self._fresh(path, authorization)
        self._shared[path] = reading

        # a read that RAISED is not an answer to share; one that answered a refusal is, so a Provider
        # that is down is asked once per window rather than once per call
        def forget(task: "asyncio.Task[tuple[int, str]]") -> None:
            if (task.cancelled() or task.exception() is not None) and self._shared.get(path) is reading:
                del self._shared[path]

        reading.answer.add_done_callback(forget)
        return reading

    async def _resolve(self, lookup: _Lookup, given: str, authorization: str | None) -> "str | ToolResult":
        """The one id `given` names, or the tool error saying why there is not one."""
        status, body = await self._read(lookup.list, authorization)
        if status != 200:
            return _failed(f"GET {lookup.list} answered {status}: {_detail_of(body)}")
        named = lookup.named(json.loads(body), given)
        if not named:
            return _failed(
                f'no {lookup.noun} is "{given}": tried it {lookup.tried(given)}. '
                f"{lookup.lister} lists every {lookup.noun}'s id"
            )
        if len(named) > 1:
            return _failed(
                "\n".join(
                    [f'"{given}" names {len(named)} {lookup.noun}s; call again with one of their ids:']
                    + [lookup.label(r) for r in named]
                )
            )
        found = named[0]["id"]
        # the service's ids are all this; anything else is not put in a path whatever it is
        if not isinstance(found, str) or _AN_ID.fullmatch(found) is None:
            return _failed(f'the {lookup.noun} "{given}" has an id no path can carry')
        return found

    async def call(self, name: str, args: Any, authorization: str | None) -> ToolResult:
        tool = next(t for t in self.tools if t["name"] == name)
        fault = argument_fault(tool, args)
        if fault is not None:
            return _failed(fault)
        given = args or {}
        resolved: dict[str, str] = {}
        lookup = _LOOKUPS.get(tool["name"])
        if lookup is not None:
            found = await self._resolve(lookup, given["id"].strip(_JS_WHITESPACE), authorization)
            if not isinstance(found, str):
                return found
            resolved["id"] = found
        # only a RESOLVED id is ever put in a path, never what the caller typed
        path = re.sub(r"\{(\w+)\}", lambda m: quote(resolved[m.group(1)], safe=""), tool["path"])
        query = _QUERIES.get(tool["name"])
        if query is not None:
            try:
                path = f"{path}?{query(given)}"
            except _Fault as fault:
                return _failed(str(fault))
        # a tool whose route shares its own answers is read afresh here: one window, not two
        shared = tool["live"] and tool.get("cached_by") != "route"
        reading = self._live(path, authorization) if shared else self._fresh(path, authorization)
        status, body = await asyncio.shield(reading.answer)
        if status != 200:
            return _failed(f"GET {path} answered {status}: {_detail_of(body)}")
        answer = {
            "source": f"GET {path}",
            "read_at": display_time(reading.at, self._display_tz),
            # the GET's body with its figures rounded by key (#454); a refusal above is its words, unrounded
            "data": rounded(json.loads(body), tool["round"]),
        }
        return {"content": [{"type": "text", "text": canonical(answer)}]}
