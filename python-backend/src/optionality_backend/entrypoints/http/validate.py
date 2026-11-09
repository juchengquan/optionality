"""Request validation that answers the way FastAPI does (ADR 0009, phase 5). Port of
backend/src/entrypoints/http/validate.ts.

Two things have to match, and neither is a default. A payload that fails validation is a 422, and the
body is `{"detail": ...}` — which the dashboard reads on every failure path, and prints. Wrapped once
here so no route can get either wrong.

One consequence shapes every schema in `schemas/`: optional fields are optional, with no default in
the schema, and their defaults are applied where the value is used, named once. The schema then says
what the API actually accepts.

**Where the Python differs, and why.** The TypeScript builds this on Hono's `validator`, a middleware;
here it is a FastAPI dependency, which a route takes as
`given: Annotated[PositionIn, Depends(valid("json", PositionIn))]`, and which raises where the
middleware returned. What Hono's validator does before the schema sees anything is done by hand,
because FastAPI's own body handling answers differently:

- a body is read only under a JSON content type, by Hono's own pattern, and anything else is validated
  as `{}` — so a body sent as text is refused for the keys it lacks, not for its type;
- a body that is not JSON is Hono's 400, "Malformed JSON in request body", in plain text, and not a
  `{"detail"}`: Hono throws its own HTTPException there, which `app.py` renders as Hono renders one.
  Not JSON is what `JSON.parse` refuses — so `NaN` and `Infinity` too, which Python's `json` reads —
  after the body is decoded as the Fetch API decodes one, a leading byte-order mark dropped;
- a JSON number is a JavaScript number, which `schemas/zod.py` reads it as.

Only the `json` target: it is the only one any route validates. The tag the TypeScript attaches for
`openapi.ts` is the dependency's `target` and `schema`.
"""

import json
import re
from collections.abc import Awaitable, Callable
from typing import Any, Literal

from fastapi import Request
from starlette.exceptions import HTTPException as HonoHTTPException

from ...schemas.zod import JS_WHITESPACE, ZodError, parse, prettify_error
from .errors import http_error

#: Hono's test for a JSON content type, as its validator writes it (`hono/validator`). `\s` is
#: JavaScript's, which is not Python's.
_JSON_TYPE = re.compile(
    rf"application/([a-z-.]+\+)?json(;[{JS_WHITESPACE}]*[a-zA-Z0-9\-]+=([^;]+))*", re.IGNORECASE | re.ASCII
)


def _not_json(token: str) -> Any:
    raise ValueError(f"not JSON: {token}")


def _read(body: bytes) -> Any:
    """`await c.req.json()`: the body decoded as the Fetch API decodes one, then `JSON.parse`."""
    try:
        return json.loads(body.decode("utf-8-sig", errors="replace"), parse_constant=_not_json)
    except ValueError:
        raise HonoHTTPException(400, "Malformed JSON in request body") from None


type Member = Callable[[Any], Any]


def valid(target: Literal["json"], schema: Any, member: Member | None = None) -> Callable[[Request], Awaitable[Any]]:
    """The dependency that validates a request's `target` against `schema`, or refuses it with a 422.

    `member`, for a UNION `schema`: the member this value is meant for, which then validates it alone.
    zod answers a union that every member refuses with "Invalid input" and no reason, so the member's
    own message is the only useful one. `schema` still documents the request, whole."""

    async def check(request: Request) -> Any:
        value: Any = {}
        kind = request.headers.get("content-type")
        if kind and _JSON_TYPE.fullmatch(kind):
            value = _read(await request.body())
        try:
            return parse(member(value) if member else schema, value)
        except ZodError as err:
            raise http_error(422, prettify_error(err)) from None

    # the tag hono-openapi's own validator carries, so the docs can document this request from the very
    # schema that checks it (openapi.ts)
    check.target = target  # type: ignore[attr-defined]
    check.schema = schema  # type: ignore[attr-defined]
    return check
