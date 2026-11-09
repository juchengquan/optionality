"""Sending one message to the owner's phone (ADR 0009, phase 6c). Port of backend/src/telegram.ts.

Just `sendMessage`, and the one call the bot's long poll makes through (`telegram_api`). An HTTPS
POST and nothing more, through `httpx2`, Pydantic's maintained continuation of `httpx` (ADR 0021,
Decision 6).

**Where the Python differs, and why.**

- JavaScript's `fetch` is a global a test can replace; a client here is not. So each function takes
  a keyword-only `transport`, `None` meaning the network, and the suite passes `httpx2.MockTransport`:
  no test may reach api.telegram.org.
- `AbortSignal.timeout(ms)` is ONE deadline on the whole exchange. httpx2's timeouts are per phase
  instead and default to five seconds each, which would abort every 25-second long poll that found
  nothing to say. So the client's own are switched off and `asyncio.timeout` keeps the TypeScript's.
- A client per call. `fetch` shares one pool for the life of the process and nothing closes it; a
  client opened and closed with each call costs a TLS handshake per send and per 25-second poll, and
  saves a lifecycle that nobody in the TypeScript owns either.
- Redirects are followed, as `fetch` follows them; httpx2 would not.
"""

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

import httpx2
from optionality.js import truthy

API = "https://api.telegram.org/bot"

# seconds. The send's is the TypeScript's 10_000 ms. The bot's is longer than the long poll it
# carries: getUpdates is asked to wait 25 seconds, so a 30-second deadline would abort a healthy
# poll. The service before the cutover used 35 for the same reason, and so does the TypeScript.
_SEND_TIMEOUT = 10.0
_API_TIMEOUT = 35.0


@dataclass(frozen=True)
class TelegramConfig:
    token: str
    chat_id: str
    #: `<pre>` with HTML parse mode, only for table replies (CLAUDE.md)
    parse_mode: Literal["HTML"] | None = None


async def _post(url: str, params: dict[str, str], deadline: float, transport: httpx2.AsyncBaseTransport | None) -> Any:
    """POST `params` as a form and answer the parsed JSON, all of it inside `deadline`."""
    async with (
        asyncio.timeout(deadline),
        httpx2.AsyncClient(transport=transport, timeout=None, follow_redirects=True) as client,
    ):
        response = await client.post(url, data=params)
        return response.json()


def _ok(payload: Any) -> bool:
    """`payload.ok`, read as JavaScript reads it off whatever JSON came back. A `null` answer throws a
    TypeError there and is a refusal here: either way, a failed send."""
    return isinstance(payload, dict) and truthy(payload.get("ok"))


def _stringify(payload: Any) -> str:
    """`JSON.stringify`'s separators, so the line a refusal logs reads as the TypeScript's. Telegram
    answers with strings, integers and booleans, which the two spell alike; stored JSON, where every
    byte counts and floats occur, is `db/values.to_sqlite_json`."""
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


async def send_message(
    config: TelegramConfig, text: str, *, transport: httpx2.AsyncBaseTransport | None = None
) -> None:
    """Send, or say why not. Raises on a refusal, because the caller decides whether a failed send is
    worth recording — the notifier swallows it and answers False."""
    body = {"chat_id": config.chat_id, "text": text}
    if config.parse_mode:
        body["parse_mode"] = config.parse_mode
    payload = await _post(f"{API}{config.token}/sendMessage", body, _SEND_TIMEOUT, transport)
    if not _ok(payload):
        raise RuntimeError(f"telegram sendMessage failed: {_stringify(payload)}")


def telegram_sender(
    token: str, chat_id: str, *, transport: httpx2.AsyncBaseTransport | None = None
) -> Callable[[str], Awaitable[None]]:
    """A sender bound to its credentials, or one that refuses when they are not configured.

    The token allows ONE getUpdates consumer and must never be exercised by two service instances
    (CLAUDE.md) — but sendMessage is not getUpdates, and this is the safe half."""

    async def send(text: str) -> None:
        if not token or not chat_id:
            raise RuntimeError("telegram is not configured")
        await send_message(TelegramConfig(token=token, chat_id=chat_id), text, transport=transport)

    return send


def telegram_api(
    token: str, *, transport: httpx2.AsyncBaseTransport | None = None
) -> Callable[[str, dict[str, str]], Awaitable[Any]]:
    """One call to the Telegram HTTP API, for the bot: the `result` Telegram answered, or a raise."""

    async def call(method: str, params: dict[str, str]) -> Any:
        payload = await _post(f"{API}{token}/{method}", params, _API_TIMEOUT, transport)
        if not _ok(payload):
            raise RuntimeError(f"telegram {method} failed: {_stringify(payload)}")
        return payload.get("result")

    return call
