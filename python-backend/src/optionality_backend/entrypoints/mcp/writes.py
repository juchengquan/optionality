"""The MCP door's writes (ADR 0028, #456): `add_rule` and `edit_rule`, behind `MCP_WRITES`, capped by
`MCP_WRITES_PER_10_MIN`, each one said to the owner's phone and in the log. Port of
backend/src/entrypoints/mcp/writes.ts.

**What this module can write is two routes, and nothing else.** It is handed a `Write` of the app's own
(`app.py`) and wraps it at once in `allowed_write`, which lets through only the method and path pairs
`schema/mcp/server.json` lists for a write tool — `POST /monitors` and `PATCH /monitors/{id}`, the id one
of the service's own — and refuses any other before the app is asked. No service, query or engine is
imported here, as none is in `tools.py` (`tests/entrypoints/mcp/test_server.py` holds both): a rule is
written by the very routes the dashboard writes it through, their probe, their checks and their words, and
this door adds only what an agent must not be able to do that the page may.

**What the door refuses itself**, before any route is asked and without counting against the cap: every
write while the switch is off; arguments that are not the tool's shape; a `qty` other than 1 (a rule on a
structure with quantities is made on the page); a combo with no name, or a name on one contract; an edit
of nothing; and unmuting a rule the service switched off — only a rule muted by hand (`manual`) may be
unmuted here. Everything else is the route's to refuse, and is said in its words, and counted: a refused
probe still asked the Provider.

**The notice** is the library's `agent_notice`, from the rule before (the `GET /monitors` row the lookup
read) and after (the route's answer), sent through the `Notify` `__main__` hands the door — the service's
`delivery`, which logs a Telegram that is not configured or refuses; the write stands either way. The log
line is this module's, one per write attempted.

**Where the Python differs, and why.**

- **A fault is raised (`_Fault`) rather than returned**, as `tools.py`'s query writer raises one.
- **A number is checked as `typeof` checks one** (`_is_number`): a bool is not a number, and is not a
  threshold either; `enabled` must be a bool, which a 1 is not.
- **The path's id is encoded as `encodeURIComponent` encodes it**, though the id is already held to the
  service's own alphabet, which neither encodes.
"""

import json
import logging
import math
import re
from collections.abc import Callable
from datetime import datetime
from typing import Any
from urllib.parse import quote

from optionality.alarm import AgentRule, agent_notice
from optionality.js import js_string
from optionality.timefmt import display_time

from ...ports import Notify, Read, Write
from .tools import (
    _EXPIRY_PATTERN,
    _JS_WHITESPACE,
    _LOOKUPS,
    DESCRIBED,
    Row,
    Tool,
    ToolResult,
    _detail_of,
    _failed,
    _is_number,
    _keys_fault,
    _utf16,
    argument_fault,
    canonical,
    is_row,
    resolve_row,
    rounded,
)

log = logging.getLogger(__name__)

#: The writes `server.json` lists, one per write tool: the whole of what this door may write.
WRITES: list[dict[str, str]] = [
    {"tool": t["name"], "method": t["method"], "path": t["path"]} for t in DESCRIBED["tools"] if "method" in t
]

#: What `{id}` in a write's path may be: one of the service's own ids, as a history tool's is.
_AN_ID = "[A-Za-z0-9_-]{1,64}"

_PAIRS = [(w["method"], re.compile(re.sub(r"\\\{\w+\\\}", _AN_ID, re.escape(w["path"])), re.ASCII)) for w in WRITES]


def allowed_write(write: Write) -> Write:
    """`write`, letting through only the pairs `WRITES` lists — the method exactly, the path whole with `{id}`
    one of the service's ids — and refusing any other before the app is asked anything. The only write the
    rest of this door is given."""
    listed = " and ".join(f"{w['method']} {w['path']}" for w in WRITES)

    async def allowed(method: str, path: str, body: Any, authorization: str | None) -> tuple[int, str]:
        if not any(m == method and p.fullmatch(path) is not None for m, p in _PAIRS):
            raise PermissionError(f"the MCP door may not {method} {path}: it writes only {listed}")
        return await write(method, path, body, authorization)

    return allowed


#: The window `MCP_WRITES_PER_10_MIN` counts writes over, in milliseconds.
CAP_WINDOW_MS = 600_000

WRITES_OFF = (
    "writes are off on this service: add_rule and edit_rule need MCP_WRITES=1 in its .env, which only its owner sets"
)


class _Fault(Exception):
    """Why an agent's arguments cannot be written as a route's body, in words it can correct itself from."""


def _given(value: object) -> bool:
    """Absent and None are both "not given", as `price_spreads`' optional arguments are."""
    return value is not None


def _rule_body(args: dict[str, Any]) -> dict[str, Any]:
    """`POST /monitors`' body for `add_rule`'s arguments, or `_Fault` saying why there is none: a structure
    as `price_spreads` takes one, its one leg the single-contract body and its several a combo's, each side
    its sign. Only the shape and the types, and what the door refuses itself; the rest is the route's."""
    expiry, legs, threshold, name = args.get("expiry"), args.get("legs"), args.get("threshold"), args.get("name")
    if not isinstance(expiry, str) or re.fullmatch(_EXPIRY_PATTERN, _utf16(expiry), re.ASCII) is None:
        raise _Fault(f'"expiry" must be a string matching {_EXPIRY_PATTERN}')
    if not isinstance(legs, list):
        raise _Fault('"legs" must be a list of legs')
    if not legs:
        raise _Fault('"legs" must hold one leg or more')
    out: list[dict[str, Any]] = []
    for i, leg in enumerate(legs):
        where = f"legs[{i}]"
        if not isinstance(leg, dict):
            raise _Fault(f"{where} must be an object")
        fault = _keys_fault(
            leg, where, "leg", ["side", "option_type", "strike", "qty"], ["side", "option_type", "strike"]
        )
        if fault is not None:
            raise _Fault(fault)
        side, type_, strike, qty = leg["side"], leg["option_type"], leg["strike"], leg.get("qty")
        if not isinstance(side, str) or side not in ("short", "long"):
            raise _Fault(f'{where}.side must be "short" or "long"')
        if not isinstance(type_, str) or type_ not in ("CALL", "PUT"):
            raise _Fault(f'{where}.option_type must be "CALL" or "PUT"')
        if not _is_number(strike):
            raise _Fault(f"{where}.strike must be a number")
        if _given(qty):
            if not _is_number(qty):
                raise _Fault(f"{where}.qty must be a number")
            if qty != 1:
                raise _Fault(
                    f"{where}.qty is {js_string(float(qty))}: a rule here watches one of each contract — "
                    "a rule on a structure with quantities is made on the page"
                )
        out.append({"sign": -1 if side == "short" else 1, "option_type": type_, "strike": strike})
    if not _is_number(threshold):
        raise _Fault('"threshold" must be a number')
    for key in ("field", "direction", "compare", "name"):
        value = args.get(key)
        if _given(value) and not isinstance(value, str):
            raise _Fault(f'"{key}" must be a string')
    if len(out) == 1 and _given(name):
        raise _Fault('a rule on one contract takes no "name": its code is the contract\'s')
    if len(out) > 1 and not _given(name):
        raise _Fault(
            f'a rule on {len(out)} legs is a combo, and a combo needs a "name": it becomes the rule\'s code ("1218-6750")'
        )
    # only what was given, so the route's own defaults apply to the rest
    optional = {k: args[k] for k in ("field", "direction", "compare") if _given(args.get(k))}
    if len(out) == 1:
        leg = out[0]
        return {
            "strike_date": expiry,
            "option_type": leg["option_type"],
            "strike": leg["strike"],
            "threshold": threshold,
            **optional,
        }
    return {"name": name, "strike_date": expiry, "legs": out, "threshold": threshold, **optional}


#: What `edit_rule` may change, in the order `server.json` lists them. `field` is not one.
_EDITABLE = ("threshold", "direction", "compare", "name", "enabled")


def _edit_body(args: dict[str, Any]) -> dict[str, Any]:
    """`PATCH /monitors/{id}`'s body for `edit_rule`'s arguments, or `_Fault` saying why there is none."""
    change: dict[str, Any] = {}
    for key in _EDITABLE:
        value = args.get(key)
        if not _given(value):
            continue
        if key == "threshold" and not _is_number(value):
            raise _Fault('"threshold" must be a number')
        if key == "enabled" and not isinstance(value, bool):
            raise _Fault('"enabled" must be true or false')
        if key not in ("threshold", "enabled") and not isinstance(value, str):
            raise _Fault(f'"{key}" must be a string')
        change[key] = value
    if not change:
        raise _Fault("edit_rule needs at least one change: threshold, direction, compare, name or enabled")
    return change


def _agent_rule(row: dict[str, Any]) -> AgentRule:
    """A rule as the route serves it, as `agent_notice` reads it."""
    legs = row.get("legs")
    return AgentRule(
        code=str(row.get("code")),
        field=str(row.get("field")),
        combo=isinstance(legs, list) and len(legs) > 0,
        compare=str(row.get("compare")),
        direction=str(row.get("direction")),
        threshold=float(row.get("threshold")),  # type: ignore[arg-type]
        enabled=row.get("enabled") is True,
    )


#: What the log says of a notice, by how it went.
_NOTICE = {
    "sent": "notice sent",
    "unconfigured": "no notice: Telegram is not configured",
    "failed": "its notice not sent",
}


def _encode_uri_component(text: str) -> str:
    """JavaScript's `encodeURIComponent`: every byte but the unreserved and `!*'()` escaped."""
    return quote(text, safe="!*'()")


def _reason(value: object) -> str:
    """A `disabled_reason` as JavaScript's `String` writes it: None is "null"."""
    return "null" if value is None else str(value)


class Writer:
    """The write tools, bound to the app they write to: `call` answers one `tools/call` of either."""

    def __init__(
        self,
        read: Read,
        write: Write,
        notify: Notify,
        now: Callable[[], datetime],
        display_tz: str,
        on: bool,
        per_10_min: int,
    ) -> None:
        self._read = read
        self._write = allowed_write(write)
        self._notify = notify
        self._now = now
        self._display_tz = display_tz
        self._on = on
        self._per_10_min = per_10_min
        #: when each write that reached the route was made, in ms, oldest first: the cap's memory
        self._made: list[float] = []

    def has(self, name: str) -> bool:
        return any(w["tool"] == name for w in WRITES)

    def _log(self, tool: str, args: Any, outcome: str, refused: bool) -> None:
        line = f"mcp {tool} {canonical({} if args is None else args)}: {outcome}"
        (log.warning if refused else log.info)("%s", line)

    def _refuse(self, tool: str, args: Any, text: str) -> ToolResult:
        self._log(tool, args, f"refused by the door: {text}", True)
        return _failed(text)

    async def _send(
        self, tool: Tool, args: Any, path: str, body: dict[str, Any], before: Row | None, authorization: str | None
    ) -> ToolResult:
        """The write itself, once the door has nothing to refuse: counted, made, said and answered."""
        at = self._now()
        t = at.timestamp() * 1000
        while self._made and t - self._made[0] >= CAP_WINDOW_MS:
            self._made.pop(0)
        if len(self._made) >= self._per_10_min:
            wait = max(1, math.ceil((min(self._made) + CAP_WINDOW_MS - t) / 1000))
            text = f"agent writes are capped at {self._per_10_min} in ten minutes: the next is allowed in {wait}s"
            return self._refuse(tool["name"], args, text)
        self._made.append(t)
        source = f"{tool['method']} {path}"
        status, answer = await self._write(tool["method"], path, body, authorization)
        if status < 200 or status >= 300:
            text = f"{source} answered {status}: {_detail_of(answer)}"
            self._log(tool["name"], args, text, True)
            return _failed(text)
        data = json.loads(answer)
        went = await self._notify(agent_notice(None if before is None else _agent_rule(before), _agent_rule(data)))
        self._log(tool["name"], args, f"{source} answered {status}: rule {data.get('id')}, {_NOTICE[went]}", False)
        # the route's body with its figures rounded by key (#454), as every tool's answer is
        text = canonical(
            {"source": source, "read_at": display_time(at, self._display_tz), "data": rounded(data, tool["round"])}
        )
        return {"content": [{"type": "text", "text": text}]}

    async def call(self, name: str, args: Any, authorization: str | None) -> ToolResult:
        tool = next(t for t in DESCRIBED["tools"] if t["name"] == name)
        # the switch first: off, nothing is read, checked, written or counted
        if not self._on:
            return self._refuse(name, args, WRITES_OFF)
        fault = argument_fault(tool, args)
        if fault is not None:
            return self._refuse(name, args, fault)
        asked: dict[str, Any] = args or {}
        try:
            if name == "add_rule":
                return await self._send(tool, args, tool["path"], _rule_body(asked), None, authorization)
            change = _edit_body(asked)
        except _Fault as refused:
            return self._refuse(name, args, str(refused))
        # found exactly as monitor_history finds it, through the same GET
        row = await resolve_row(
            self._read, _LOOKUPS["monitor_history"], asked["id"].strip(_JS_WHITESPACE), authorization
        )
        if not is_row(row):
            return self._refuse(name, args, row["content"][0]["text"])  # type: ignore[index]
        if change.get("enabled") is True and row.get("enabled") is not True and row.get("disabled_reason") != "manual":
            return self._refuse(
                name,
                args,
                f'the rule "{row["id"]}" is off as "{_reason(row.get("disabled_reason"))}", not muted by hand: '
                'edit_rule unmutes only a rule muted by hand (disabled_reason "manual")',
            )
        # only the RESOLVED id is put in the path, as a history tool's is
        path = tool["path"].replace("{id}", _encode_uri_component(row["id"]))
        return await self._send(tool, args, path, change, row, authorization)
