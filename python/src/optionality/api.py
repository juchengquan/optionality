"""Positions and Monitors from the live optionality service, as this package's own types.

    from optionality import api
    held = api.positions()            # list[Position]
    rules = api.monitors()            # list[Monitor]

The address defaults to `http://127.0.0.1:31415`, the service on the machine it runs on. From
anywhere else on the tailnet, set `OPTIONALITY_API` to its URL there — `https://<host>/opt/api`;
the path prefix is kept. A token, if the service has one set, comes from `OPTIONALITY_API_TOKEN`.

This is the service's view of your book, so its figures and your notebook's start from the same
rows. A response in a shape this package does not know (an old field value, a missing field) is a
validation error, not data: read quietly, a renamed Side would invert every figure built on it.

Not in tests/golden: this is about the service's HTTP shapes, which the TypeScript's own typed
client (`hc`) already holds to the routes. Standard library only, for two GET requests.
"""

import json
import os
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pydantic import TypeAdapter

from optionality._ported import GOLDEN_CASES
from optionality.monitor import Monitor
from optionality.position import Position

DEFAULT_URL = "http://127.0.0.1:31415"
TIMEOUT_SECONDS = 10


class ApiError(RuntimeError):
    """The service refused, or could not be reached. `status` is None when nothing answered."""

    def __init__(self, url: str, status: int | None, detail: str) -> None:
        self.url, self.status, self.detail = url, status, detail
        super().__init__(f"{url}: {status if status is not None else 'unreachable'} {detail}")


def _get(path: str, base_url: str | None, token: str | None) -> Any:
    base = (base_url or os.environ.get("OPTIONALITY_API") or DEFAULT_URL).rstrip("/")
    url = f"{base}{path}"
    token = token if token is not None else os.environ.get("OPTIONALITY_API_TOKEN")
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        with urlopen(Request(url, headers=headers), timeout=TIMEOUT_SECONDS) as response:
            body = response.read()
    except HTTPError as err:
        # the service answers every failure as {"detail": ...}; say what it said
        try:
            detail = json.loads(err.read()).get("detail", err.reason)
        except (ValueError, AttributeError):
            detail = err.reason
        raise ApiError(url, err.code, str(detail)) from None
    except URLError as err:
        raise ApiError(url, None, str(err.reason)) from None
    try:
        return json.loads(body)
    except ValueError:
        # Caddy answers any unknown path under /opt with the dashboard's page, and a 200
        raise ApiError(
            url, 200, "answered with something that is not JSON — the dashboard? The API is under /opt/api"
        ) from None


def positions(base_url: str | None = None, token: str | None = None) -> list[Position]:
    """Every Position the service holds (`GET /positions`)."""
    return TypeAdapter(list[Position]).validate_python(_get("/positions", base_url, token))


def monitors(base_url: str | None = None, token: str | None = None) -> list[Monitor]:
    """Every Monitor, enabled or not (`GET /monitors`)."""
    return TypeAdapter(list[Monitor]).validate_python(_get("/monitors", base_url, token))


@dataclass(frozen=True)
class Agreement:
    """Whether this port and a running service hold the same golden cases.

    `agrees` is True, False, or None for "could not tell" — and the object is TRUTHY unless it is
    a definite no. A notebook on a plane must not report drift that is not there.
    """

    mine: str
    theirs: str | None
    agrees: bool | None

    def __bool__(self) -> bool:
        return self.agrees is not False

    def __str__(self) -> str:
        if self.agrees is True:
            return f"this port agrees with the service ({self.mine})"
        if self.agrees is False:
            return (
                f"the engine has moved on: it holds {self.theirs}, this port was cut against "
                f"{self.mine} — reinstall from a newer tag"
            )
        return f"no service to compare with; this port was cut against {self.mine}"


def agrees(base_url: str | None = None, token: str | None = None) -> Agreement:
    """Ask the running service which golden cases it is, and compare (`GET /health`, ADR 0016).

    The cases hold this port to the TypeScript at the moment it is WRITTEN. A notebook pins a tag
    and keeps it, so the staleness it cannot otherwise see is "the engine has moved since my port
    was cut" — the figures still compute, and still look right.

        from optionality import api
        print(api.agrees())        # first cell, once

    Never called on import, and never raises: ADR 0014 exists so this package works with no service
    running. No service, no verdict.
    """
    try:
        health = _get("/health", base_url, token)
    except ApiError:
        return Agreement(GOLDEN_CASES, None, None)
    # a service older than ADR 0016 answers without the field; that is not a disagreement
    theirs = health.get("golden_cases") if isinstance(health, dict) else None
    if not isinstance(theirs, str) or not theirs:
        return Agreement(GOLDEN_CASES, None, None)
    return Agreement(GOLDEN_CASES, theirs, theirs == GOLDEN_CASES)
