"""The service's three doors (ADR 0020), opened on a scenario's world: one request, one Telegram
update, or one tick of the sweep, and what each did (ADR 0021, Decision 4).

The Python's half of the replay, step for step with `backend/testing/scenarios/doors.ts`, so it is
kept to the steps the README names and nothing clever:

  1. open the world (`world.py`) and build the backend on it (`backend.build`, the seam);
  2. run the earlier sweeps, each at its own instant, then an HTTP scenario's earlier requests, and check
     they left the tables alone;
  3. set the clock to the event, forget the earlier calls, messages and replies, and dump the tables;
  4. do the one thing, dump again, and report the difference with what was said and asked.

Each `run_*` returns what its door's `expect` holds, built from what the backend did, and takes the
builder as an argument so the runner's own suite can drive it with a fake backend.
"""

import json
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from . import backend
from .backend import Service
from .world import Calls, OpenWorld, Tables, diff_tables, dump_tables, instant, json_text, open_world

type Builder = Callable[[OpenWorld], Service]

__all__ = ["RUN", "ScenarioError", "json_text", "run_bot", "run_http", "run_sweep"]


class ScenarioError(Exception):
    """A scenario that cannot be replayed as written, whichever backend runs it."""


@dataclass
class Opened:
    world: OpenWorld
    service: Service
    before: Tables


def ordered(calls: Calls) -> Calls:
    """Calls in a stable order: vendors by name, each vendor's calls as they were made."""
    return {name: calls[name] for name in sorted(calls)}


@contextmanager
def opened(
    world: dict[str, Any], build: Builder | None, requests: list[dict[str, Any]] | None = None
) -> Iterator[Opened]:
    """Steps 1 to 3: the backend built on the world, with its memory, at the event's instant. The
    backend is closed before the world it was built on. `requests` are an HTTP scenario's `earlier`, made
    before the event, after the earlier sweeps, each at its own instant: a memory no table holds.

    `build` is looked up when called rather than bound as a default, so a test that replaces
    `backend.build` replaces it here too."""
    w = open_world(world)
    service: Service | None = None
    try:
        service = (build or backend.build)(w)
        for earlier in world["sweeps"]:
            w.clock.now = instant(earlier["at"])
            w.outage.down = earlier["down"]
            service.sweep()
        w.outage.down = world["provider"]["down"]
        for e in requests or []:
            w.clock.now = instant(e["at"])
            _send(service, e["request"])
        before = dump_tables(w.db)
        touched = diff_tables(w.db, world["tables"], before)
        if touched:
            raise ScenarioError(
                "an earlier sweep or request changed the tables; state them as the event finds them and "
                f"keep those for the service's memory:\n{json.dumps(touched, indent=2, ensure_ascii=False)}"
            )
        w.clock.now = instant(world["clock"])
        w.outage.down = world["provider"]["down"]
        w.calls.clear()
        w.sent.clear()
        w.replies.clear()
        yield Opened(w, service, before)
    finally:
        try:
            if service is not None:
                service.close()
        finally:
            w.close()


def _after(o: Opened) -> dict[str, Any]:
    return {"rows": diff_tables(o.world.db, o.before, dump_tables(o.world.db)), "calls": ordered(o.world.calls)}


def _send(service: Service, request: dict[str, Any]) -> Any:
    """A request as the README says to send one: the body as JSON with its Content-Type, or none."""
    headers = dict(request["headers"])
    body = None
    if request["body"] is not None:
        body = json_text(request["body"])
        headers["Content-Type"] = "application/json"
    return service.request(request["method"], request["path"], headers, body)


def run_http(scenario: dict[str, Any], build: Builder | None = None) -> dict[str, Any]:
    """One request through the HTTP door, after any earlier ones through the same service. The body goes
    as JSON with its Content-Type, or not at all when it is null; the answer is parsed JSON, null when
    empty, the raw text when not JSON."""
    with opened(scenario["world"], build, scenario.get("earlier")) as o:
        answer = _send(o.service, scenario["request"])
        is_json = "application/json" in answer.content_type
        parsed = None if answer.text == "" else json.loads(answer.text) if is_json else answer.text
        return {"response": {"status": answer.status, "body": parsed}, **_after(o)}


def run_bot(scenario: dict[str, Any], build: Builder | None = None) -> dict[str, Any]:
    """One Telegram update through the bot door, answered through the world's fake Telegram API."""
    with opened(scenario["world"], build) as o:
        o.service.handle_update(scenario["update"])
        if len(o.world.replies) > 1:
            raise ScenarioError("the bot answered one message twice")
        sent = o.world.replies[0] if o.world.replies else None
        reply = (
            None
            if sent is None
            else {"chat_id": sent.get("chat_id"), "text": sent.get("text"), "parse_mode": sent.get("parse_mode")}
        )
        return {"reply": reply, **_after(o)}


def run_sweep(scenario: dict[str, Any], build: Builder | None = None) -> dict[str, Any]:
    """One tick of the sweep, at the world's clock."""
    with opened(scenario["world"], build) as o:
        o.service.sweep()
        return {"messages": list(o.world.sent), **_after(o)}


RUN: dict[str, Callable[[dict[str, Any], Builder | None], dict[str, Any]]] = {
    "http": run_http,
    "bot": run_bot,
    "sweep": run_sweep,
}
