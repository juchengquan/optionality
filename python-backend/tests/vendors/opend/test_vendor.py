"""moomoo as a vendor: the library's OpenD client, asked from a worker thread inside two deadlines.

backend/src/vendors/opend/vendor.ts has no test of its own, and the client it wraps is the library's.
What its callers' tests rely on is held here: `vendors/index.test.ts`'s "builds moomoo without
reaching for a socket" (opening is inert), and what the sweep, `/quotes` and the creation probes
read from a Provider — a batch with moomoo's unknown codes contained, a failure as a raise with
moomoo's own words, and `reachable` for `/health`. The deadlines are `opend/client.ts`'s, whose
suite holds the same two sentences.

Nearly all of it is the Python's own, because the TypeScript has no thread: that the SDK never runs
on the loop's thread, that a call which outlives its deadline still closes what it opened, and that
a dead OpenD costs one thread rather than one per sweep and poll.

The SDK is never reached: every test passes `connect`, a fake context, because the real one retries
a dead port for ever and a missing fake looks like a hung suite (CLAUDE.md).
"""

import asyncio
import contextlib
import threading
from datetime import UTC, datetime

import pytest
from optionality.opend import DEFAULT_PORT

from optionality_backend.env import settings_for
from optionality_backend.ports import GradeRead, ProviderClient, QuoteGradeReading
from optionality_backend.vendors import ProviderVendor
from optionality_backend.vendors.opend.vendor import MoomooClient, moomoo_vendor

A, B = "US.SPXW261120P6500000", "US.SPXW261120C7100000"


class Frame:
    """The SDK answers a pandas frame; the library reads it with `to_dict("records")`."""

    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows

    def to_dict(self, orient: str) -> list[dict]:
        assert orient == "records"
        return [dict(r) for r in self.rows]


class Context:
    """A fake `OpenQuoteContext`: what it was asked, on which thread, and whether it was closed."""

    def __init__(
        self,
        *,
        refuse: str | None = None,
        unknown: str | None = None,
        hold: threading.Event | None = None,
        grade: tuple[int, object] = (0, {"us_option_qot_right": "LV1"}),
        grade_hold: threading.Event | None = None,
    ):
        self.refuse, self.unknown, self.hold = refuse, unknown, hold
        #: what `get_user_info` answers (#464): the SDK's `(ret, data)`, data moomoo's words on a refusal
        self.grade, self.grade_hold = grade, grade_hold
        self.asked: list[list[str]] = []
        self.threads: list[str] = []
        self.user_info_asked: list[list[int]] = []
        self.closed = threading.Event()

    def get_user_info(self, info_field=()):
        self.user_info_asked.append(list(info_field))
        if self.grade_hold is not None:
            self.grade_hold.wait(5)
        return self.grade

    def get_market_snapshot(self, codes: list[str]):
        self.threads.append(threading.current_thread().name)
        self.asked.append(list(codes))
        if self.hold is not None:
            self.hold.wait(5)
        if self.refuse is not None:
            return -1, self.refuse
        if self.unknown is not None and self.unknown in codes:
            return -1, f"Unknown stock. {self.unknown.removeprefix('US.')}"
        return 0, Frame([{"code": c, "bid_price": 1.0, "ask_price": 2.0} for c in codes])

    def close(self) -> None:
        self.closed.set()


def connecting(ctx: Context, *, hold: threading.Event | None = None, refuse: Exception | None = None):
    """A `connect` that answers `ctx` — after `hold` is set, or by raising `refuse`."""
    made: list[tuple[str, int]] = []

    def connect(host: str, port: int) -> Context:
        made.append((host, port))
        if hold is not None:
            hold.wait(5)
        if refuse is not None:
            raise refuse
        return ctx

    connect.made = made  # type: ignore[attr-defined]
    return connect


async def closed(ctx: Context) -> bool:
    """Whether the connection is closed within a second — it closes on the worker, not on the loop."""
    return await asyncio.to_thread(ctx.closed.wait, 1)


class TestTheDescriptor:
    def test_is_a_provider_candidate_that_needs_no_configuration(self):
        # OpenD's host has a default that is right on this machine, so there is nothing to gate on
        assert isinstance(moomoo_vendor, ProviderVendor)
        assert moomoo_vendor.name == "moomoo"
        assert moomoo_vendor.configured_by is None

    def test_opens_inertly_on_the_settings_host_and_the_api_port(self):
        before = threading.active_count()
        client = moomoo_vendor.open(settings_for(opend_host="10.0.0.7"))
        assert isinstance(client, MoomooClient)
        assert isinstance(client, ProviderClient)
        assert (client.name, client.host, client.port) == ("moomoo", "10.0.0.7", DEFAULT_PORT)
        # no connection and no thread until something is asked
        assert threading.active_count() == before
        client.close()


class TestAsking:
    async def test_answers_the_batch_with_the_mid_and_closes_the_connection(self):
        ctx = Context()
        connect = connecting(ctx)
        client = MoomooClient("127.0.0.1", connect=connect)
        batch = await client.fetch_quotes([A, B])
        assert batch.records == [
            {"code": A, "bid_price": 1.0, "ask_price": 2.0, "mid_price": 1.5},
            {"code": B, "bid_price": 1.0, "ask_price": 2.0, "mid_price": 1.5},
        ]
        assert batch.unknown == []
        assert connect.made == [("127.0.0.1", DEFAULT_PORT)]
        # a connection per ask, closed by the ask that opened it
        assert await closed(ctx)

    async def test_contains_a_contract_moomoo_names_as_unknown(self):
        # the library's containment, reached through the vendor: one bad code cannot take the
        # watchlist hostage, and the port carries which codes could not be priced (ADR 0015)
        ctx = Context(unknown=B)
        batch = await MoomooClient("127.0.0.1", connect=connecting(ctx)).fetch_quotes([A, B])
        assert [r["code"] for r in batch.records] == [A]
        assert batch.unknown == [B]
        assert ctx.asked == [[A, B], [A]]

    async def test_raises_a_refusal_in_moomoos_own_words(self):
        # an index is refused as a CLASS, naming no code, so nothing is contained (ADR 0018)
        ctx = Context(refuse="US stock indices are not supported")
        with pytest.raises(RuntimeError, match=r"^snapshot API failed: US stock indices are not supported$"):
            await MoomooClient("127.0.0.1", connect=connecting(ctx)).fetch_quotes(["US..SPX"])
        assert await closed(ctx)

    async def test_raises_a_connection_it_could_not_make_with_its_reason(self):
        connect = connecting(Context(), refuse=ConnectionRefusedError("connect ECONNREFUSED 127.0.0.1:11111"))
        with pytest.raises(RuntimeError, match=r"^snapshot API failed: connect ECONNREFUSED 127.0.0.1:11111$"):
            await MoomooClient("127.0.0.1", connect=connect).fetch_quotes([A])

    async def test_asks_nothing_for_nothing(self):
        # an empty watchlist is not a reason to log in, as `batch([])` is not in the TypeScript
        connect = connecting(Context())
        assert await MoomooClient("127.0.0.1", connect=connect).fetch_quotes([]) == ([], [])
        assert connect.made == []


class TestTheDeadlines:
    async def test_a_login_that_never_completes_fails_at_its_deadline_and_still_closes(self):
        # the SDK retries a dead port inside its constructor for as long as OpenD is down: the fetch
        # must fail and be counted, and the connection made once OpenD is back must not be leaked
        hold, ctx = threading.Event(), Context()
        client = MoomooClient("127.0.0.1", connect=connecting(ctx, hold=hold), login_timeout_ms=50)
        try:
            with pytest.raises(RuntimeError, match=r"^snapshot API failed: OpenD login timed out after 50ms$"):
                await client.fetch_quotes([A])
        finally:
            hold.set()
        assert await closed(ctx)

    async def test_a_request_that_is_never_answered_fails_at_its_deadline_and_still_closes(self):
        # a logged-in OpenD can accept a request and never answer it, which stopped the alarm engine
        # dead on 2026-10-16 (opend/client.ts)
        hold = threading.Event()
        ctx = Context(hold=hold)
        client = MoomooClient("127.0.0.1", connect=connecting(ctx), request_timeout_ms=50)
        try:
            with pytest.raises(RuntimeError, match=r"^snapshot API failed: OpenD request timed out after 50ms$"):
                await client.fetch_quotes([A])
        finally:
            hold.set()
        assert await closed(ctx)

    def test_are_the_typescripts(self):
        client = MoomooClient("127.0.0.1")
        assert (client.login_timeout_ms, client.request_timeout_ms) == (8000, 10_000)


class TestOneThread:
    """The SDK blocks, so it runs off the loop — on ONE thread per client, never one per call."""

    async def test_never_runs_the_sdk_on_the_loops_thread(self):
        ctx = Context()
        await MoomooClient("127.0.0.1", connect=connecting(ctx)).fetch_quotes([A])
        assert ctx.threads and threading.main_thread().name not in ctx.threads

    async def test_asks_one_at_a_time_however_many_callers_arrive_together(self):
        # the sweep, a /quotes poll and a creation probe can overlap; the SDK sees them in turn
        ctx = Context()
        client = MoomooClient("127.0.0.1", connect=connecting(ctx))
        await asyncio.gather(*(client.fetch_quotes([f"US.X{i}"]) for i in range(5)))
        assert len(ctx.asked) == 5
        assert len(set(ctx.threads)) == 1

    async def test_a_call_queued_behind_a_stuck_one_fails_at_its_own_deadline_and_never_runs(self):
        # a dead OpenD holds the one thread; everything behind it fails in time and is dropped from
        # the queue, so the backlog cannot grow while OpenD is down
        hold, first = threading.Event(), Context()
        second = Context()
        made = iter([connecting(first, hold=hold), connecting(second)])
        client = MoomooClient("127.0.0.1", connect=lambda host, port: next(made)(host, port), login_timeout_ms=50)
        try:
            for _ in range(2):
                with pytest.raises(RuntimeError, match="login timed out"):
                    await client.fetch_quotes([A])
            # the loop drops a cancelled call from the queue on its next turn; give it that turn before
            # the stuck one is released, or the worker could reach the queue first
            await asyncio.sleep(0)
        finally:
            hold.set()
        assert await closed(first)
        assert second.asked == []
        # and the next ask, once OpenD is back, is answered
        assert (await client.fetch_quotes([B])).records[0]["code"] == B

    async def test_close_drops_what_is_queued_and_the_next_ask_starts_again(self):
        ctx = Context()
        client = MoomooClient("127.0.0.1", connect=connecting(ctx))
        await client.fetch_quotes([A])
        client.close()
        # "hang up, so the next call reconnects"
        assert (await client.fetch_quotes([B])).records[0]["code"] == B


async def until(done, seconds: float = 2) -> None:
    """Wait for a grade read, which runs on a thread of its own after the fetch has returned."""
    for _ in range(int(seconds / 0.01)):
        if done():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("it never happened")


async def quiet() -> None:
    """Long enough for a read that WAS started to have been asked: asserting that none was needs it."""
    await asyncio.sleep(0.05)


T1 = datetime(2026, 11, 20, 9, 41, 34, tzinfo=UTC)
T2 = datetime(2026, 11, 20, 10, 0, tzinfo=UTC)


class TestTheQuoteGrade:
    """The account's grade for US options (#464): read once per connection episode and kept.

    The TypeScript holds its websocket, so its episode is a login. This connects per fetch, so the
    episode is the same rule written on the fetches themselves: a read after the first one that
    succeeds, and after the first that succeeds following one that failed — never one per sweep or
    page poll. The read is an ask of its own, on a thread of its own, so a GetUserInfo that hangs
    holds no fetch behind it: the SDK blocks, and the fetches have one thread between them.
    """

    async def test_is_unread_until_a_fetch_has_succeeded_and_a_failed_one_reads_nothing(self):
        ctx = Context(refuse="US stock indices are not supported")
        client = MoomooClient("127.0.0.1", connect=connecting(ctx))
        assert client.quote_grade() == QuoteGradeReading(read=None, failure=None)
        with pytest.raises(RuntimeError):
            await client.fetch_quotes(["US..SPX"])
        await quiet()
        assert ctx.user_info_asked == []
        assert client.quote_grade() == QuoteGradeReading(read=None, failure=None)

    async def test_asks_for_the_quote_rights_alone_after_the_first_fetch_that_succeeds(self):
        ctx = Context()
        client = MoomooClient("127.0.0.1", connect=connecting(ctx), now=lambda: T1)
        await client.fetch_quotes([A])
        await until(lambda: client.quote_grade().read is not None)
        assert ctx.user_info_asked == [[4]]
        assert client.quote_grade() == QuoteGradeReading(
            read=GradeRead(us_option="LV1", realtime=True, at=T1), failure=None
        )

    async def test_reads_once_per_episode_none_after_later_successes_one_after_a_failures_end(self):
        ctx = Context()
        client = MoomooClient("127.0.0.1", connect=connecting(ctx))

        async def fetch() -> None:
            with contextlib.suppress(RuntimeError):
                await client.fetch_quotes([A])
            await quiet()

        await fetch()
        await until(lambda: len(ctx.user_info_asked) == 1)
        await fetch()
        await fetch()
        assert len(ctx.user_info_asked) == 1
        ctx.refuse = "Client connection failed!"
        await fetch()
        await fetch()
        assert len(ctx.user_info_asked) == 1
        ctx.refuse = None
        await fetch()
        await until(lambda: len(ctx.user_info_asked) == 2)
        await fetch()
        assert len(ctx.user_info_asked) == 2

    async def test_reads_once_when_fetches_succeed_together(self):
        ctx = Context()
        client = MoomooClient("127.0.0.1", connect=connecting(ctx))
        await asyncio.gather(*(client.fetch_quotes([A]) for _ in range(3)))
        await until(lambda: client.quote_grade().read is not None)
        await quiet()
        assert len(ctx.user_info_asked) == 1

    async def test_says_whether_a_grade_is_real_time(self):
        ctx = Context(grade=(0, {"us_option_qot_right": "BMP"}))
        client = MoomooClient("127.0.0.1", connect=connecting(ctx), now=lambda: T1)
        await client.fetch_quotes([A])
        await until(lambda: client.quote_grade().read is not None)
        assert client.quote_grade().read == GradeRead(us_option="BMP", realtime=False, at=T1)

    async def test_a_refused_read_fails_no_fetch_and_says_opends_words_where_none_was_read(self):
        ctx = Context(grade=(-1, "user info unavailable"))
        client = MoomooClient("127.0.0.1", connect=connecting(ctx))
        assert (await client.fetch_quotes([A])).unknown == []
        await until(lambda: client.quote_grade().failure is not None)
        assert client.quote_grade() == QuoteGradeReading(read=None, failure="user info unavailable")

    async def test_a_refused_read_leaves_the_last_grade_its_time_saying_how_old_it_is(self):
        ctx = Context()
        clock = [T1]
        client = MoomooClient("127.0.0.1", connect=connecting(ctx), now=lambda: clock[0])
        await client.fetch_quotes([A])
        await until(lambda: client.quote_grade().read is not None)
        ctx.refuse = "Client connection failed!"
        with pytest.raises(RuntimeError):
            await client.fetch_quotes([A])
        ctx.refuse, ctx.grade, clock[0] = None, (-1, "busy"), T2
        await client.fetch_quotes([A])
        await until(lambda: client.quote_grade().failure is not None)
        assert client.quote_grade() == QuoteGradeReading(
            read=GradeRead(us_option="LV1", realtime=True, at=T1), failure="busy"
        )

    async def test_a_read_that_never_answers_holds_no_fetch_and_gives_up_at_its_deadline(self):
        # the same deadline as the snapshot's request; and its own thread, so the fetches behind it
        # are answered while it hangs
        hold = threading.Event()
        ctx = Context(grade_hold=hold)
        client = MoomooClient("127.0.0.1", connect=connecting(ctx), request_timeout_ms=50)
        try:
            await client.fetch_quotes([A])
            await until(lambda: len(ctx.user_info_asked) == 1)
            for _ in range(3):
                assert (await client.fetch_quotes([B])).records[0]["code"] == B
            await until(lambda: client.quote_grade().failure is not None)
            assert client.quote_grade() == QuoteGradeReading(
                read=None, failure="OpenD GetUserInfo timed out after 50ms"
            )
        finally:
            hold.set()

    async def test_a_read_whose_connection_is_refused_fails_no_fetch(self):
        # its own ask, so its own connection: one that cannot be made is the read's failure alone
        good, made = Context(), []

        def connect(host: str, port: int) -> Context:
            made.append(host)
            if len(made) == 2:
                raise ConnectionRefusedError("connect ECONNREFUSED 127.0.0.1:11111")
            return good

        client = MoomooClient("127.0.0.1", connect=connect)
        await client.fetch_quotes([A])
        await until(lambda: client.quote_grade().failure is not None)
        assert client.quote_grade().failure == "connect ECONNREFUSED 127.0.0.1:11111"
        assert (await client.fetch_quotes([B])).records[0]["code"] == B

    async def test_reads_nothing_for_an_empty_batch(self):
        ctx = Context()
        client = MoomooClient("127.0.0.1", connect=connecting(ctx))
        await client.fetch_quotes([])
        await quiet()
        assert ctx.user_info_asked == []


class TestReachable:
    async def test_says_yes_to_a_port_that_accepts(self):
        server = await asyncio.start_server(lambda _r, w: w.close(), "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        try:
            assert await MoomooClient("127.0.0.1", port).reachable() is True
        finally:
            server.close()
            await server.wait_closed()

    async def test_says_no_rather_than_raising_when_nothing_is_there(self):
        # a health endpoint that raises because the probe raised tells you less than one that says no
        server = await asyncio.start_server(lambda _r, w: w.close(), "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        server.close()
        await server.wait_closed()
        assert await MoomooClient("127.0.0.1", port).reachable() is False
