"""The MCP door's tools (ADR 0026): what each one reads, how its arguments are checked, the short shared
cache in front of the live ones, and the one way an answer is written. Port of
backend/src/entrypoints/mcp/tools.ts.

**A tool is a GET of the API's own, and nothing else.** Each names one path the HTTP door already
serves, and its answer's `data` is that GET's body. The tool cannot compute anything of its own, so it
cannot disagree with the route — or with the dashboard, which reads the same route — and it cannot
write: the only thing this module is handed is `read`, which `app.py` builds to issue a GET and nothing
else. No service, no query and no engine is imported here; a test (`tests/entrypoints/mcp/test_server.py`)
holds this package's imports to that.

**The table is shared ground**, `schema/mcp/server.json`, read by both backends (ADR 0021): the names,
the descriptions an agent reads, the input schemas and which tools are live are written once, so the
two cannot describe the same tool in two ways. What is CODE is here: the argument check, how a history
tool's name becomes an id (`_LOOKUPS`), the path a call becomes, the cache and the text.

**The cache** is the owner's decision 7 on #447: the live reads — `/quotes`, `/positions/values`,
`/references` — ask the Provider, whose snapshot limit (60 per 30 seconds) is shared with the sweep and
the page, so an agent in a loop could otherwise starve the alarms. Every caller within `LIVE_FOR_MS` of a
read gets that read, with the time it was made; a read still in flight is joined rather than repeated.
Keyed by the path alone — the live tools take no arguments — so no argument can bust it. The page and
the sweep never pass through here.

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
from optionality.js import js_string
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
    #: whether it asks the Provider, and so is shared for `LIVE_FOR_MS`
    live: bool
    inputSchema: dict[str, Any]


class Described(TypedDict):
    server: dict[str, Any]
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
        pattern = properties[name]["pattern"]
        # anchored with ^…$, so `fullmatch` with ASCII classes, as the README says of such a regex
        if not isinstance(value, str) or re.fullmatch(pattern, _utf16(value), re.ASCII) is None:
            return f'argument "{name}" must be a string matching {pattern}'
    return None


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
        reading = self._live(path, authorization) if tool["live"] else self._fresh(path, authorization)
        status, body = await asyncio.shield(reading.answer)
        if status != 200:
            return _failed(f"GET {path} answered {status}: {_detail_of(body)}")
        answer = {
            "source": f"GET {path}",
            "read_at": display_time(reading.at, self._display_tz),
            "data": json.loads(body),
        }
        return {"content": [{"type": "text", "text": canonical(answer)}]}
