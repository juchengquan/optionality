"""moomoo as a vendor (ADR 0015, registered by the vendor door since ADR 0019).
Port of backend/src/vendors/opend/vendor.ts.

Nothing new: it is the library's OpenD client and a port probe, named and bundled so that the
service above holds one thing rather than two unrelated fields. Everything moomoo-specific — the
port, the SDK, the probe, the error prose its containment reads — stays below this line.

It needs no configuration gate. OpenD's host has a default that is right on this machine, and an
OpenD that refuses is a vendor that is down rather than one that is absent — which the sweep reports
and quarantine never acts on, because an unreachable Provider says nothing about whether a rule is
evaluable.

**Where the Python differs, and why.**

- **The transport.** The library's client, `optionality.opend.OpenD`, speaks the SDK's TCP protocol
  on OpenD's API port; the TypeScript's npm client speaks the websocket one, because that package
  speaks nothing else. Phase 0 of ADR 0009 compared the two field by field and found 0 of 56
  differing. So `MOOMOO_WS_PORT` and `MOOMOO_WS_KEY` are not read here — the TCP API takes no key —
  and the port is the library's `DEFAULT_PORT`, 11111: OpenD's own default, the one
  `deploy/macos/opend.sh` watches, and set by no variable in either backend. A blank key is
  therefore a login the TypeScript refuses and this does not need.
- **The probe** asks the port this client speaks, as the TypeScript's does: the API port here, the
  websocket port there. `typescript/src/vendors/opend/probe.ts` is the library's in the TypeScript;
  the Python library has no probe, so it is ported here, as `probe_opend`.
- **The SDK blocks.** Each fetch runs on this vendor's one worker thread (`vendors.Worker`) inside
  `opend/client.ts`'s two deadlines, 8 seconds to log in and 10 to answer, and fails with its words.
  Stopping waiting is not cancelling: the thread runs on until the SDK returns, and closes the
  connection it opened when it does.
- **A connection per fetch, not one held.** The TypeScript holds its websocket because a websocket
  login per sweep is a keyed handshake every minute for ever; over TCP that is cheap — its own words
  — and it is what the Python service did until the cutover (`fetch_snapshot`). Held, the SDK's
  context reconnects on its own after OpenD drops, and a request made meanwhile waits for that
  reconnect with no bound at all, which is the one wait a deadline here could never release.
- **What no deadline here releases.** The SDK's connect retries a dead port every six seconds,
  inside its constructor, for as long as OpenD is down. The fetch fails at its login deadline and is
  counted; the thread waits until OpenD is back, and every fetch meanwhile queues behind it, fails
  at its own deadline and is dropped from the queue — so an outage costs one thread, never one per
  sweep and poll. The SDK's own callback thread is not a daemon, so a process asked to stop while a
  connect is retrying waits for OpenD, or for launchd to kill it.
"""

import asyncio
import contextlib
from collections.abc import Callable
from typing import Any

from optionality.opend import DEFAULT_PORT, OpenD
from optionality.quote import Batch

from ...env import Settings
from .. import ProviderVendor, Worker

#: `opend/client.ts`'s `loginTimeoutMs` default: bounds the connect and its handshake
LOGIN_TIMEOUT_MS = 8000
#: `opend/client.ts`'s `requestTimeoutMs` default. Bounds the ASK, where the login's bounds the
#: handshake. A logged-in OpenD can accept a request and never answer it, which stopped the alarm
#: engine dead on 2026-10-16. Shorter than the sweep watchdog on purpose: the fetch should fail and
#: be counted, not be abandoned by the loop.
REQUEST_TIMEOUT_MS = 10_000
#: `probe.ts`'s default
PROBE_TIMEOUT_MS = 1000


async def probe_opend(host: str, port: int, timeout_ms: int = PROBE_TIMEOUT_MS) -> bool:
    """Whether OpenD is listening (ADR 0009, phase 5). Port of typescript/src/vendors/opend/probe.ts.

    A plain TCP connect — it answers "is the gateway up" without asking it anything, which is what
    `/health` wants. Any failure is a no: a health endpoint that raises because the probe raised
    tells you less than one that says no.
    """
    try:
        async with asyncio.timeout(timeout_ms / 1000):
            _reader, writer = await asyncio.open_connection(host, port)
    except Exception:  # noqa: BLE001 — whatever the failure, the answer is "no", which is the report
        return False
    writer.close()
    with contextlib.suppress(Exception):
        await writer.wait_closed()
    return True


def _settle(future: asyncio.Future[None]) -> None:
    if not future.done():
        future.set_result(None)


class MoomooClient:
    """moomoo, opened: one bounded batched snapshot call, through the library's OpenD client.

    `connect` is the library's own seam, `OpenD(connect=...)`: a test passes a fake context, and None
    is the SDK. Constructing opens nothing and starts no thread.
    """

    name = "moomoo"

    def __init__(
        self,
        host: str,
        port: int = DEFAULT_PORT,
        *,
        connect: Callable[[str, int], Any] | None = None,
        login_timeout_ms: int = LOGIN_TIMEOUT_MS,
        request_timeout_ms: int = REQUEST_TIMEOUT_MS,
    ) -> None:
        self.host, self.port = host, port
        self.login_timeout_ms = login_timeout_ms
        self.request_timeout_ms = request_timeout_ms
        self._connect = connect
        self._worker = Worker("moomoo")

    async def fetch_quotes(self, codes: list[str]) -> Batch:
        """Every quote moomoo has for these codes, and the codes it refused as unknown — the single
        bounded call the invariant names. The library contains a code moomoo names as unknown; any
        other failure raises, and an outage is never presented as a watchlist of unknown contracts."""
        if not codes:
            return Batch(records=[], unknown=[])
        loop = asyncio.get_running_loop()
        logged_in: asyncio.Future[None] = loop.create_future()
        asked = list(codes)

        def ask() -> Batch:
            # the whole exchange on the worker: the SDK's context is made, used and closed on one
            # thread, whether or not anyone is still waiting for the answer
            with OpenD(self.host, self.port, connect=self._connect) as od:
                loop.call_soon_threadsafe(_settle, logged_in)
                return od.quotes(asked)

        answer = self._worker.submit(ask)
        try:
            await asyncio.wait(
                {answer, logged_in}, timeout=self.login_timeout_ms / 1000, return_when=asyncio.FIRST_COMPLETED
            )
            if not logged_in.done():
                if not answer.done():
                    raise RuntimeError(f"snapshot API failed: OpenD login timed out after {self.login_timeout_ms}ms")
                # it ended before it had a connection: the connect itself failed
                failure = answer.exception()
                if failure is not None:
                    raise RuntimeError(f"snapshot API failed: {failure}") from failure
            await asyncio.wait({answer}, timeout=self.request_timeout_ms / 1000)
            if not answer.done():
                raise RuntimeError(f"snapshot API failed: OpenD request timed out after {self.request_timeout_ms}ms")
            # the library's own refusal already reads "snapshot API failed: <moomoo's words>"
            return answer.result()
        finally:
            # still queued: dropped. Already running: it finishes on the thread and closes there.
            answer.cancel()
            logged_in.cancel()

    async def reachable(self) -> bool:
        # the API port, which is the one this client speaks — not the websocket one the TypeScript's
        return await probe_opend(self.host, self.port)

    def close(self) -> None:
        """Hang up, so the next call reconnects. Nothing is held between fetches, so this drops what
        is still queued for the worker."""
        self._worker.close()


def _open(settings: Settings) -> MoomooClient:
    return MoomooClient(settings.opend_host)


moomoo_vendor = ProviderVendor(name="moomoo", open=_open)
