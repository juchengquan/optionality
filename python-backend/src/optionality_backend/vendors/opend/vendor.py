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
- **The quote grade's episode** (#464). The TypeScript reads the account's grade once per LOGIN, on
  the websocket it holds: after its first fetch, after every failed fetch (each hangs up), and after
  the npm library logs in again BY ITSELF — which it does when the socket drops, so OpenD restarting
  between two fetches is a new login there with no fetch having failed. Connecting per fetch, this
  has no login that outlives a fetch and cannot see such a restart: a read after the first fetch
  that succeeds, and after the first that succeeds following one that failed — kept between
  fetches, never one per sweep or poll. So an OpenD restarted between two fetches is re-read by the
  TypeScript and not by this, until a fetch fails. The read is an ask of its own, on its own
  connection and its own thread (`moomoo-grade`): the SDK blocks, and a GetUserInfo that hangs on the
  fetches' one thread would hold every fetch behind it past its login deadline, which is the one
  thing a grade must never do. A read happens once per episode, so the extra connection is one per
  outage, not one per sweep.
- **No read overwrites a newer one**, which the TypeScript must number its reads to prevent (#465):
  a read sent there before the socket drops is never answered and ends only at its deadline, after
  the next read may have answered. Here every read runs on the one `moomoo-grade` thread, so a later
  read cannot even start until the earlier one's ask has returned — and the earlier one settles the
  moment it does, if its deadline has not already settled it. `close` cancels the read in flight.
"""

import asyncio
import contextlib
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from optionality.opend import DEFAULT_PORT, OpenD, is_realtime
from optionality.quote import Batch

from ...env import Settings
from ...ports import GradeRead, QuoteGradeReading
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
    """moomoo, opened: one bounded batched snapshot call, through the library's OpenD client — and the
    account's quote grade for US options, read once per connection episode (#464).

    `connect` is the library's own seam, `OpenD(connect=...)`: a test passes a fake context, and None
    is the SDK. `now` says when a grade was read. Constructing opens nothing and starts no thread.
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
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.host, self.port = host, port
        self.login_timeout_ms = login_timeout_ms
        self.request_timeout_ms = request_timeout_ms
        self._connect = connect
        self._now = now
        self._worker = Worker("moomoo")
        #: the quote grade's own thread, so a GetUserInfo that hangs holds no fetch behind it (#464)
        self._grade_worker = Worker("moomoo-grade")
        self._grade = QuoteGradeReading(read=None, failure=None)
        #: whether the next fetch that succeeds must read the grade: until the first has, and again
        #: after every one that fails
        self._grade_due = True
        #: the read in flight, held so the loop does not drop it, and cancelled by `close`
        self._reading: asyncio.Task[None] | None = None

    async def _ask[T](self, worker: Worker, question: Callable[[OpenD], T], prefix: str, asking: str) -> T:
        """`question` on a connection of its own, on `worker`, inside `opend/client.ts`'s two deadlines:
        the login's, then the request's. A deadline or a connect that failed raises with `prefix` before
        its words; whatever `question` raises is raised as it is."""
        loop = asyncio.get_running_loop()
        logged_in: asyncio.Future[None] = loop.create_future()

        def ask() -> T:
            # the whole exchange on the worker: the SDK's context is made, used and closed on one
            # thread, whether or not anyone is still waiting for the answer
            with OpenD(self.host, self.port, connect=self._connect) as od:
                loop.call_soon_threadsafe(_settle, logged_in)
                return question(od)

        answer = worker.submit(ask)
        try:
            await asyncio.wait(
                {answer, logged_in}, timeout=self.login_timeout_ms / 1000, return_when=asyncio.FIRST_COMPLETED
            )
            if not logged_in.done():
                if not answer.done():
                    raise RuntimeError(f"{prefix}OpenD login timed out after {self.login_timeout_ms}ms")
                # it ended before it had a connection: the connect itself failed
                failure = answer.exception()
                if failure is not None:
                    raise RuntimeError(f"{prefix}{failure}") from failure
            await asyncio.wait({answer}, timeout=self.request_timeout_ms / 1000)
            if not answer.done():
                raise RuntimeError(f"{prefix}OpenD {asking} timed out after {self.request_timeout_ms}ms")
            return answer.result()
        finally:
            # still queued: dropped. Already running: it finishes on the thread and closes there.
            answer.cancel()
            logged_in.cancel()

    async def fetch_quotes(self, codes: list[str]) -> Batch:
        """Every quote moomoo has for these codes, and the codes it refused as unknown — the single
        bounded call the invariant names. The library contains a code moomoo names as unknown; any
        other failure raises, and an outage is never presented as a watchlist of unknown contracts."""
        if not codes:
            return Batch(records=[], unknown=[])
        asked = list(codes)
        try:
            # the library's own refusal already reads "snapshot API failed: <moomoo's words>"
            batch = await self._ask(self._worker, lambda od: od.quotes(asked), "snapshot API failed: ", "request")
        except BaseException:
            self._grade_due = True
            raise
        # the first of an episode reads the grade. Not awaited: the batch is the answer the caller
        # asked for, and the grade must never delay or fail it
        if self._grade_due:
            self._grade_due = False
            self._reading = asyncio.get_running_loop().create_task(self._read_grade())
        return batch

    def quote_grade(self) -> QuoteGradeReading:
        """The account's grade for US options as last read, and why the latest read failed if it did.
        Asks nothing: `/health` reads it and must never cause a read (#464)."""
        return self._grade

    async def _read_grade(self) -> None:
        """GetUserInfo, asked for the quote rights alone, kept for `/health`. NOT market data — it prices
        nothing — but bounded all the same, by the snapshot's own deadlines. A failure is kept beside
        whatever grade an earlier read found, and the next episode tries again."""
        try:
            us_option = await self._ask(self._grade_worker, OpenD.us_option_grade, "", "GetUserInfo")
        except Exception as err:  # noqa: BLE001 — a grade that did not come fails nothing; it is said
            self._grade = QuoteGradeReading(read=self._grade.read, failure=str(err))
            return
        self._grade = QuoteGradeReading(
            read=GradeRead(us_option=us_option, realtime=is_realtime(us_option), at=self._now()), failure=None
        )

    async def reachable(self) -> bool:
        # the API port, which is the one this client speaks — not the websocket one the TypeScript's
        return await probe_opend(self.host, self.port)

    def close(self) -> None:
        """Hang up, so the next call reconnects. Nothing is held between fetches, so this drops what
        is still queued for the workers, and stops waiting for a grade."""
        self._worker.close()
        self._grade_worker.close()
        if self._reading is not None:
            self._reading.cancel()


def _open(settings: Settings) -> MoomooClient:
    return MoomooClient(settings.opend_host)


moomoo_vendor = ProviderVendor(name="moomoo", open=_open)
