"""The MCP door's protocol (ADR 0026): MCP's Streamable HTTP transport, stateless, on the API's own port —
one JSON-RPC message per POST, answered with one JSON body. Port of backend/src/entrypoints/mcp/server.ts.

**Written by hand rather than with the official SDK**, and the reason is the second backend. ADR 0021
holds the two to the same answers at the door, and the door scenarios compare them exactly: two SDKs,
one per language, word their own refusals, validate in their own order and carry their own defaults, and
every difference would be a scenario that fails for a reason neither backend chose. The subset a
read-only server needs is small — `initialize`, `ping`, `tools/list`, `tools/call` and the notifications
— and written twice from one description it answers the same in both. It also keeps a dependency, in
each language, out of the service.

**Stateless.** No session id is issued and none is read, and there is no event stream: `GET` answers
405, which the transport defines as "this server offers no stream". Every tool is a read whose answer
stands alone, so there is nothing to keep between two requests — the shared cache in `tools.py` is the
service's, not a session's.

**What reaches it** has already passed the HTTP door's token check: `app.py` mounts it behind the same
guard as every route, so the token that reads `/quotes` is the token that reads this. A request carrying
an `Origin` is refused: only a browser sends one, no page of this service speaks MCP, and refusing it is
what the transport asks of a server to stop DNS rebinding.

**Where the Python differs, and why.**

- **It takes Starlette's request and answers Starlette's response**, where the TypeScript takes the web
  platform's: each is what its HTTP layer hands a handler.
- **An integral id is echoed as an integer** (`1.0` as `1`): `JSON.parse` keeps no difference between
  the two and the TypeScript echoes `1`, where Python's reader keeps the float.
- **`NaN` and `Infinity` are refused as JSON**, which Python's reader accepts and `JSON.parse` does not,
  and the body is read as UTF-8 with replacement, as `Request.text()` reads it.
"""

import json
import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from ...ports import Read
from .tools import DESCRIBED, Toolbox


@dataclass(frozen=True)
class McpOptions:
    #: a GET of the API's own (`app.py`); the only way this door reaches anything
    read: Read
    #: the clock, injected as the routes' is, for the cache and every answer's `read_at`
    now: Callable[[], datetime]
    #: the zone `read_at` is written in, the API's `DISPLAY_TZ`
    display_tz: str


# JSON-RPC's own error codes, and the one the transport leaves to the server
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
REFUSED = -32000

type Id = str | int | float | None


def _json(status: int, body: Any, headers: dict[str, str] | None = None) -> Response:
    return JSONResponse(body, status_code=status, headers=headers)


def _failure(id_: Id, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}


def _is_id(id_: object) -> bool:
    """An id JSON-RPC allows on a request: a string or a number, never null on one that wants an answer."""
    if isinstance(id_, bool):
        return False
    return isinstance(id_, str) or (isinstance(id_, int | float) and math.isfinite(id_))


def _id_of(message: object) -> Id:
    """What a refused message is answered with an id of: its own, where it had a usable one."""
    if isinstance(message, dict) and _is_id(message.get("id")):
        return message["id"]
    return None


def _as_javascript_reads(id_: str | float) -> str | int | float:
    """An id as `JSON.parse` reads it: `1.0` is the number 1, and the TypeScript echoes `1`. Python reads
    it as a float and would echo `1.0`; an integral float within a double's exact range is made the int."""
    if isinstance(id_, float) and id_.is_integer() and abs(id_) <= 2**53:
        return int(id_)
    return id_


def _no_constants(name: str) -> None:
    raise ValueError(f"{name} is not JSON")


class _Refusal(Exception):
    """A request refused with a JSON-RPC error rather than a result."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def mcp_server(options: McpOptions) -> Callable[[Request], Awaitable[Response]]:
    """The handler `app.py` mounts at `/mcp`."""
    tools = Toolbox(options.read, options.now, options.display_tz)
    server = DESCRIBED["server"]
    listed = DESCRIBED["tools"]

    async def initialize(params: dict[str, Any], authorization: str | None) -> Any:
        asked = params.get("protocolVersion")
        # the version the client asked for where this server speaks it, else the newest it does — the
        # client then decides whether it can go on (the lifecycle's negotiation)
        versions = server["protocol_versions"]
        protocol_version = asked if isinstance(asked, str) and asked in versions else versions[0]
        return {
            "protocolVersion": protocol_version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": server["name"], "title": server["title"], "version": server["version"]},
            "instructions": server["instructions"],
        }

    async def ping(params: dict[str, Any], authorization: str | None) -> Any:
        return {}

    async def tools_list(params: dict[str, Any], authorization: str | None) -> Any:
        return {
            "tools": [
                {
                    "name": t["name"],
                    "title": t["title"],
                    "description": t["description"],
                    "inputSchema": t["inputSchema"],
                    # what a client may tell its user before calling: nothing here changes anything
                    "annotations": {
                        "readOnlyHint": True,
                        "destructiveHint": False,
                        "idempotentHint": True,
                        "openWorldHint": False,
                    },
                }
                for t in listed
            ]
        }

    async def tools_call(params: dict[str, Any], authorization: str | None) -> Any:
        name = params.get("name")
        if not isinstance(name, str):
            raise _Refusal(INVALID_PARAMS, "tools/call needs the tool's name")
        if not tools.has(name):
            raise _Refusal(INVALID_PARAMS, f"Unknown tool: {name}")
        return await tools.call(name, params.get("arguments"), authorization)

    methods: dict[str, Callable[[dict[str, Any], str | None], Awaitable[Any]]] = {
        "initialize": initialize,
        "ping": ping,
        "tools/list": tools_list,
        "tools/call": tools_call,
    }

    async def serve(request: Request) -> Response:
        if request.headers.get("origin") is not None:
            return _json(
                403, _failure(None, REFUSED, "Forbidden: /mcp answers no browser page (a request with an Origin)")
            )
        if request.method != "POST":
            return _json(
                405,
                _failure(
                    None, REFUSED, "Method not allowed: /mcp takes one JSON-RPC message per POST, and offers no stream"
                ),
                {"Allow": "POST"},
            )
        # the transport's rule for a request after initialization: a version this server does not speak
        # is a 400, never answered as though it were one it does
        version = request.headers.get("mcp-protocol-version")
        if version is not None and version not in server["protocol_versions"]:
            spoken = ", ".join(server["protocol_versions"])
            return _json(
                400,
                _failure(
                    None,
                    INVALID_REQUEST,
                    f"Bad Request: unsupported MCP-Protocol-Version {version}; this server speaks {spoken}",
                ),
            )
        try:
            message = json.loads((await request.body()).decode("utf-8", errors="replace"), parse_constant=_no_constants)
        except ValueError:
            return _json(400, _failure(None, PARSE_ERROR, "Parse error: the body is not JSON"))
        if isinstance(message, list):
            return _json(
                400, _failure(None, INVALID_REQUEST, "Invalid Request: one message per POST; batches are not supported")
            )
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            return _json(400, _failure(_id_of(message), INVALID_REQUEST, "Invalid Request: not a JSON-RPC 2.0 message"))
        # a response or an error from the client — to nothing this server asked — is accepted, and so is
        # any notification: neither wants an answer, and this server acts on none
        if "method" not in message or "id" not in message:
            if "method" in message and not isinstance(message["method"], str):
                return _json(400, _failure(None, INVALID_REQUEST, "Invalid Request: the method must be a string"))
            return Response(status_code=202)
        if not isinstance(message["method"], str) or not _is_id(message["id"]):
            return _json(
                400,
                _failure(
                    _id_of(message),
                    INVALID_REQUEST,
                    "Invalid Request: a request needs a string method and a string or number id",
                ),
            )
        id_ = _as_javascript_reads(message["id"])
        params = message.get("params")
        if params is None:
            params = {}
        if not isinstance(params, dict):
            return _json(200, _failure(id_, INVALID_PARAMS, "Invalid params: params must be an object"))
        method = methods.get(message["method"])
        if method is None:
            return _json(200, _failure(id_, METHOD_NOT_FOUND, f"Method not found: {message['method']}"))
        try:
            result = await method(params, request.headers.get("authorization"))
        except _Refusal as refusal:
            return _json(200, _failure(id_, refusal.code, refusal.message))
        return _json(200, {"jsonrpc": "2.0", "id": id_, "result": result})

    return serve
