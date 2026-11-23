"""The IB Gateway client's narrower claims, each with its reason — `client.test.ts` and
`contract.test.ts`, ported, and the stub's own rules.

`test_ibkr_gateway.py` holds what every recorded conversation comes to against the TypeScript's
answer. These are the claims a batch cannot show: that the conid cache saves a lookup, that a
close drops it, that an empty list asks nothing, that a gateway nobody can reach raises with words
that say so. Over a real loopback socket against `fake_gateway.py`, never a real gateway.
"""

import asyncio
import copy
import logging
import struct
import time
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from fake_gateway import FakeGateway, frame, load_conversation, read_frames, start_fake_gateway

from optionality.ibkr import (
    INDEX_EXCHANGE,
    IbkrAccountRefused,
    IbkrClient,
    IbkrUnreachable,
    TwsContract,
    contract_for,
)

OPTION = "US.SPXW261218C8100000"
#: the model's computation for OPTION, as the gateway sent it (tick 13, normal-with-greeks)
MODEL_DELTA, MODEL_THETA, MODEL_IV = 0.03210521375811607, -0.32748349484896266, 0.13795658209227243


def against(
    conversation: str | dict[str, Any],
    test: Callable[[IbkrClient, FakeGateway], Awaitable[Any]],
    server_version: str | None = None,
    *,
    pace: float | None = None,
    request_timeout_ms: int = 1000,
    quiet_ms: int | None = None,
) -> Any:
    """Run `test` against a fresh stub replaying `conversation`, closing both whatever happens."""

    async def run() -> Any:
        gateway = await start_fake_gateway(conversation, server_version, pace)
        client = IbkrClient(
            port=gateway.port,
            client_id=31419,
            connect_timeout_ms=1000,
            request_timeout_ms=request_timeout_ms,
            **({} if quiet_ms is None else {"quiet_ms": quiet_ms}),
        )
        try:
            return await test(client, gateway)
        finally:
            client.close()
            await gateway.close()

    return asyncio.run(run())


# --- one bounded ask ---------------------------------------------------------------------------


def test_an_option_is_answered_under_the_services_own_field_names() -> None:
    async def ask(client: IbkrClient, _: FakeGateway) -> Any:
        return await client.fetch_quotes([OPTION])

    batch = against("normal-with-greeks", ask)
    assert batch.unknown == []
    (q,) = batch.records
    assert (q["code"], q["bid_price"], q["ask_price"], q["prev_close_price"]) == (OPTION, 4.1, 4.5, 3.65)
    # derived, not sent; and the MODEL's greeks, not the bid's or the ask's sent alongside
    assert q["mid_price"] == 4.3
    assert (q["option_delta"], q["option_theta"]) == (MODEL_DELTA, MODEL_THETA)
    # the 100x that is not a rename: IBKR's 0.1368 is moomoo's 14.007
    assert q["option_implied_volatility"] == MODEL_IV * 100
    # the grade the gateway SERVED (live), not the one asked for (delayed-frozen)
    assert (q["delayed"], q["last_known"]) == (False, False)


def test_an_index_is_asked_as_a_stream_and_answered_by_its_first_burst() -> None:
    """A snapshot of SPX or VIX carries no figure at any hour — the account has no snapshot
    permission for an index — and a stream sends every figure it holds at once (recorded in the
    session on 2026-11-10). A replay delivers the whole three seconds at once, so SPX's last is its
    last update's."""

    async def ask(client: IbkrClient, _: FakeGateway) -> Any:
        return await client.fetch_quotes([OPTION, "SPX", "VIX"])

    batch = against("index-in-the-session", ask)
    assert batch.unknown == []
    by_code = {r["code"]: r for r in batch.records}
    assert by_code["SPX"] == {
        "code": "SPX",
        "delayed": False,
        "last_known": False,
        "last_price": 7499.46,
        "prev_close_price": 7549.94,
    }
    assert by_code["VIX"] == {
        "code": "VIX",
        "delayed": False,
        "last_known": False,
        "last_price": 20.49,
        "prev_close_price": 19.92,
    }


def test_every_stream_it_opens_is_cancelled_so_none_outlives_the_ask() -> None:
    """A stream left running is a running board of prices, which would make a dead session look like
    a calm market, and holds one of the account's market-data lines for ever."""

    async def ask(client: IbkrClient, gateway: FakeGateway) -> Any:
        await client.fetch_quotes(["SPX", "VIX"])
        await _until(lambda: sum(m[0] == "2" for m in gateway.received) >= 2)
        return list(gateway.received)

    received = against("index-in-the-session", ask)
    streams = [(m[2], m[17]) for m in received if m[0] == "1"]
    assert [snapshot for _, snapshot in streams] == ["0", "0"]
    assert sorted(m[2] for m in received if m[0] == "2") == sorted(req_id for req_id, _ in streams)


def test_an_empty_list_asks_nothing_and_does_not_even_connect() -> None:
    async def ask(client: IbkrClient, gateway: FakeGateway) -> Any:
        batch = await client.fetch_quotes([])
        return batch, list(gateway.received)

    batch, received = against("normal-with-greeks", ask)
    assert (batch.records, batch.unknown) == ([], [])
    assert received == []


# --- when an ask is finished (#257) --------------------------------------------------------------
# The replies are PACED here, each sent at its recorded time scaled down, because when a figure
# arrives is the whole question; the corpus replays everything at once.


async def _timed(client: IbkrClient, codes: list[str]) -> tuple[Any, float]:
    started = time.monotonic()
    batch = await client.fetch_quotes(codes)
    return batch, (time.monotonic() - started) * 1000


def _edited(name: str, symbol: str, sec_type: str, change: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    """A recording with one market-data exchange changed in place, for a claim no capture shows."""
    conversation = copy.deepcopy(load_conversation(name))
    conversation["conversation"] = f"{name}, edited"
    for exchange in conversation["exchanges"]:
        contract = exchange["contract"]
        if exchange["request"] == "reqMktData" and (contract["symbol"], contract["secType"]) == (symbol, sec_type):
            change(exchange)
    return conversation


def test_an_options_greeks_are_waited_for_through_a_pause_longer_than_the_quiet_window() -> None:
    """The model's greeks come 0.3 to 1.7 seconds after the book, and in five of six live captures a
    pause longer than the 250ms window came first, so the client finished without them. At a quarter
    of the recorded times the pause before them is still 364ms."""

    async def ask(client: IbkrClient, _: FakeGateway) -> Any:
        return await _timed(client, [OPTION])

    batch, ms = against("normal-with-greeks", ask, pace=0.25, request_timeout_ms=5000)
    assert batch.records[0]["option_delta"] == MODEL_DELTA
    # and on the greeks and the quiet after them: the snapshot's end is 2.8s away at this pace
    assert ms < 2000


def test_a_delayed_options_model_greeks_are_tick_83_and_are_waited_for() -> None:
    """Graded delayed, the gateway sends the delayed ids: 66/67/75 for the book and close, 80-83 for
    the computations, 83 the model's. This once read 53 as the delayed model, which is the CUSTOM
    computation, so a delayed option waited out the timeout for greeks it already had. Constructed
    from normal-with-greeks: no capture holds a delayed option, and the ids are IBKR's and
    ib_async's."""
    delayed_ids = {"1": "66", "2": "67", "9": "75", "10": "80", "11": "81", "12": "82", "13": "83"}

    def delayed(exchange: dict[str, Any]) -> None:
        replies = []
        for m in exchange["replies"]:
            if m[0] == "58":
                m = [*m[:3], "3"]
            elif m[0] == "1":
                m = [*m[:3], delayed_ids.get(m[3], m[3]), *m[4:]]
            elif m[0] == "21":
                m = [*m[:2], delayed_ids.get(m[2], m[2]), *m[3:]]
            replies.append(m)
        exchange["replies"] = replies

    async def ask(client: IbkrClient, _: FakeGateway) -> Any:
        return await _timed(client, [OPTION])

    batch, ms = against(_edited("normal-with-greeks", "SPX", "OPT", delayed), ask, pace=0.25, request_timeout_ms=5000)
    (q,) = batch.records
    assert (q["delayed"], q["bid_price"], q["ask_price"], q["option_delta"]) == (True, 4.1, 4.5, MODEL_DELTA)
    assert ms < 2000


def test_every_new_figure_restarts_the_quiet_so_a_late_one_is_late_rather_than_lost() -> None:
    """The book at 100ms, the model's greeks at 200 (complete, and the quiet starts), the ask side at
    600 and the close at 1000 — each inside the half-second quiet the figure before it restarted,
    and the close outside the one the greeks started. Constructed: the shape is a capture's
    (2026-11-10, 17:13:54Z: book 0.72s, greeks 1.40s, no close by 1.5s), the times chosen to sit
    well clear of the window either way."""

    def late(exchange: dict[str, Any]) -> None:
        def find(test: Callable[[list[str]], bool]) -> list[str]:
            return next(m for m in exchange["replies"] if test(m))

        at = [
            (find(lambda m: m[0] == "58"), 50),
            (find(lambda m: m[0] == "1" and m[3] == "1"), 100),
            (find(lambda m: m[0] == "21" and m[2] == "13"), 200),
            (find(lambda m: m[0] == "1" and m[3] == "2"), 600),
            (find(lambda m: m[0] == "1" and m[3] == "9"), 1000),
            (find(lambda m: m[0] == "57"), 6000),
        ]
        exchange["replies"], exchange["atMs"] = [m for m, _ in at], [ms for _, ms in at]

    async def ask(client: IbkrClient, _: FakeGateway) -> Any:
        return await _timed(client, [OPTION])

    batch, ms = against(
        _edited("normal-with-greeks", "SPX", "OPT", late), ask, pace=1, request_timeout_ms=8000, quiet_ms=500
    )
    (q,) = batch.records
    assert (q["bid_price"], q["ask_price"], q["prev_close_price"], q["option_delta"]) == (4.1, 4.5, 3.65, MODEL_DELTA)
    # finished on the quiet after the close, not on the snapshot's end
    assert ms < 4000


def test_the_snapshots_end_finishes_an_ask_greeks_or_none() -> None:
    """The one delimiter the protocol has: nothing more is coming, so an option whose model never
    answers is finished there, with the figures it did send — when the end comes before the timeout.
    Here it does (0.55s against 5s, paced); live it comes at eleven seconds, after the default eight,
    so there the timeout finishes such an option."""

    def without_the_model(exchange: dict[str, Any]) -> None:
        keep = [not (m[0] == "21" and m[2] == "13") for m in exchange["replies"]]
        exchange["replies"] = [m for m, k in zip(exchange["replies"], keep, strict=True) if k]
        exchange["atMs"] = [at for at, k in zip(exchange["atMs"], keep, strict=True) if k]

    async def ask(client: IbkrClient, _: FakeGateway) -> Any:
        return await _timed(client, [OPTION])

    no_model = _edited("normal-with-greeks", "SPX", "OPT", without_the_model)
    batch, ms = against(no_model, ask, pace=0.05, request_timeout_ms=5000)
    (q,) = batch.records
    assert (q["bid_price"], q["ask_price"], q["prev_close_price"]) == (4.1, 4.5, 3.65)
    assert "option_delta" not in q
    assert ms < 2500


def test_a_stream_repeating_figures_it_already_sent_does_not_hold_the_ask_open() -> None:
    """A repeat is the running board rather than more of the answer, so the quiet is measured from
    the last NEW figure. SPX's recorded update, sent every 100ms for three seconds: busier than any
    window, and every message would restart one."""

    def busy(exchange: dict[str, Any]) -> None:
        burst = exchange["atMs"].count(exchange["atMs"][0])
        update = exchange["replies"][burst : burst + 4]
        replies, at_ms = exchange["replies"][:burst], exchange["atMs"][:burst]
        for at in range(600, 3601, 100):
            replies += update
            at_ms += [at] * 4
        exchange["replies"], exchange["atMs"] = replies, at_ms

    async def ask(client: IbkrClient, _: FakeGateway) -> Any:
        return await _timed(client, ["SPX"])

    batch, ms = against(_edited("index-in-the-session", "SPX", "IND", busy), ask, pace=1, request_timeout_ms=5000)
    (q,) = batch.records
    assert q["prev_close_price"] == 7549.94
    # the burst's last, or the first update's if it was read inside the quiet: which one is a race
    # between two timers 16ms apart, and not what this test is about
    assert q["last_price"] in (7499.18, 7499.44)
    # the burst at 0.5s and a quarter-second of quiet, not the 3.6s the updates last
    assert ms < 2000


def test_every_contract_is_asked_side_by_side_so_a_batch_costs_its_slowest() -> None:
    """One after another, every option's wait for its greeks would be paid again; side by side it is
    paid once. Every market-data request goes out before any is cancelled, which is to say before any
    is finished. On a warm cache, so no lookup's timing can interleave."""

    async def ask(client: IbkrClient, gateway: FakeGateway) -> Any:
        await client.fetch_quotes([OPTION, "SPX", "VIX"])
        await _until(lambda: sum(m[0] == "2" for m in gateway.received) >= 3)
        start = len(gateway.received)
        await client.fetch_quotes([OPTION, "SPX", "VIX"])
        await _until(lambda: len(gateway.received) >= start + 6)
        return [m[0] for m in gateway.received[start:]]

    assert against("index-in-the-session", ask) == ["1", "1", "1", "2", "2", "2"]


async def _until(done: Callable[[], bool], within: float = 2.0) -> None:
    """Until `done`, polling: the stub reads what the client sent on its own schedule."""
    async with asyncio.timeout(within):
        while not done():
            await asyncio.sleep(0.005)


# --- the pace (#257's review) --------------------------------------------------------------------


def test_a_big_batch_goes_on_the_wire_at_the_gateways_pace_45_messages_a_second() -> None:
    """Side by side, a cold batch is a lookup per contract at once. `ib_async` holds itself to 45 a
    second, startApi counted, and the TypeScript copies it, so the two put the same messages out at
    the same moments. Sixty contracts nobody recorded: none answers, and the ask then raises."""
    codes = [f"US.SPXW261218C{9001 + i}000" for i in range(60)]

    async def ask(client: IbkrClient, gateway: FakeGateway) -> Any:
        asked = asyncio.ensure_future(client.fetch_quotes(codes))
        await asyncio.sleep(0.4)
        early = [m[0] for m in gateway.received]
        with pytest.raises(ConnectionError):
            await asked
        await _until(lambda: len(gateway.received) >= 62)
        return early, len(gateway.received)

    early, total = against("normal-with-greeks", ask, request_timeout_ms=1500)
    assert early[:2] == ["71", "59"]
    assert len(early) == 45  # startApi, the data type, 43 lookups
    assert total == 62  # the other 17 a second later


# --- a code it cannot name ---------------------------------------------------------------------


def test_a_code_it_cannot_name_is_unknown_without_spending_a_call() -> None:
    async def ask(client: IbkrClient, gateway: FakeGateway) -> Any:
        return await client.fetch_quotes(["TSLA"]), gateway.lookups

    batch, lookups = against("normal-with-greeks", ask)
    assert (batch.records, batch.unknown, lookups) == ([], ["TSLA"], 0)


def test_the_codes_it_can_name_stand_beside_one_it_cannot() -> None:
    async def ask(client: IbkrClient, _: FakeGateway) -> Any:
        return await client.fetch_quotes(["TSLA", OPTION])

    batch = against("normal-with-greeks", ask)
    assert batch.unknown == ["TSLA"]
    assert [r["code"] for r in batch.records] == [OPTION]


# --- the conid, resolved once ------------------------------------------------------------------


def test_the_conid_is_cached_so_a_second_ask_spends_no_lookup() -> None:
    async def ask(client: IbkrClient, gateway: FakeGateway) -> Any:
        await client.fetch_quotes([OPTION])
        before = gateway.lookups
        await client.fetch_quotes([OPTION])
        return before, gateway.lookups

    before, after = against("normal-with-greeks", ask)
    assert before == after == 1


def test_the_conid_is_dropped_with_the_connection() -> None:
    async def ask(client: IbkrClient, gateway: FakeGateway) -> Any:
        await client.fetch_quotes([OPTION])
        client.close()
        before = gateway.lookups
        await client.fetch_quotes([OPTION])
        return before, gateway.lookups

    before, after = against("normal-with-greeks", ask)
    assert after > before


# --- a gateway that will not answer ------------------------------------------------------------


def test_a_gateway_nobody_can_reach_raises_saying_so() -> None:
    client = IbkrClient(port=1, client_id=31419, connect_timeout_ms=1000)
    with pytest.raises(ConnectionError, match="could not reach IB Gateway at 127.0.0.1:1"):
        asyncio.run(client.fetch_quotes([OPTION]))


def test_a_gateway_below_the_protocol_floor_is_refused_out_loud() -> None:
    async def ask(client: IbkrClient, _: FakeGateway) -> Any:
        return await client.fetch_quotes([OPTION])

    with pytest.raises(ConnectionError, match="speaks protocol 155; this client needs 157 or newer"):
        against("normal-with-greeks", ask, server_version="155")


def test_a_failure_tears_the_connection_down_so_the_next_ask_reconnects() -> None:
    async def ask(client: IbkrClient, gateway: FakeGateway) -> Any:
        await client.fetch_quotes([OPTION])
        await gateway.close()
        with pytest.raises(ConnectionError):
            await client.fetch_quotes(["US.SPXW261204C8100000"])
        # a new gateway, and the same client comes back rather than staying broken
        fresh = await start_fake_gateway("normal-with-greeks")
        try:
            client.port = fresh.port
            return await client.fetch_quotes([OPTION])
        finally:
            client.close()
            await fresh.close()

    batch = against("normal-with-greeks", ask)
    assert [r["code"] for r in batch.records] == [OPTION]


def test_an_ask_abandoned_mid_handshake_lets_go_of_the_connection() -> None:
    """A caller that gives up (the sweep's watchdog, a closed request) must not leave a connect
    running for nobody: it would hold the client id, and IB Gateway lets a second connection with
    the same id displace the first in silence."""

    async def abandon(client: IbkrClient, gateway: FakeGateway) -> int:
        ask = asyncio.ensure_future(client.fetch_quotes([OPTION]))
        while gateway.connections == 0:
            await asyncio.sleep(0.01)
        ask.cancel()
        with pytest.raises(asyncio.CancelledError):
            await ask
        for _ in range(100):  # the stub hears the close on its next read
            if gateway.connections == 0:
                break
            await asyncio.sleep(0.01)
        return gateway.connections

    assert against("session-never-starts", abandon) == 0


# --- one connection per client id --------------------------------------------------------------
#
# IB Gateway allows one connection per client id. The sweep, the dashboard's poll and a creation
# probe can all arrive while the client is cold, and each used to open a connection of its own with
# the same id: the gateway refused the second, and that refusal's teardown closed whatever
# connection the client held and dropped every caller's listeners. `client.test.ts`, ported.


def strict(
    conversation: str, test: Callable[[IbkrClient, FakeGateway], Awaitable[Any]], request_timeout_ms: int = 1000
) -> Any:
    """`against`, on a stub that refuses a second session on one client id."""

    async def run() -> Any:
        gateway = await start_fake_gateway(conversation, one_session_per_client_id=True)
        client = IbkrClient(
            port=gateway.port, client_id=31419, connect_timeout_ms=1000, request_timeout_ms=request_timeout_ms
        )
        try:
            return await test(client, gateway)
        finally:
            client.close()
            await gateway.close()

    return asyncio.run(run())


async def until(done: Callable[[], bool]) -> None:
    for _ in range(200):
        if done():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("timed out waiting for the stub")


def test_callers_who_arrive_together_share_one_connect() -> None:
    async def ask(client: IbkrClient, gateway: FakeGateway) -> Any:
        asks = await asyncio.gather(
            client.fetch_quotes([OPTION]),
            client.fetch_quotes([OPTION]),
            client.fetch_quotes([OPTION]),
            client.reachable(),
            return_exceptions=True,
        )
        return asks, gateway.sessions_asked, gateway.connections

    asks, sessions, connections = strict("normal-with-greeks", ask)
    for batch in asks[:3]:
        assert not isinstance(batch, BaseException), batch
        assert [r["code"] for r in batch.records] == [OPTION]
    assert asks[3] is True
    assert (sessions, connections) == (1, 1)


def test_a_refused_connect_fails_every_caller_and_leaves_no_connection_open() -> None:
    async def ask(client: IbkrClient, gateway: FakeGateway) -> Any:
        asks = await asyncio.gather(
            client.fetch_quotes([OPTION]), client.fetch_quotes([OPTION]), return_exceptions=True
        )
        await until(lambda: gateway.connections == 0)
        return asks, gateway.sessions_asked

    asks, sessions = strict("client-id-in-use", ask)
    for failure in asks:
        assert isinstance(failure, ConnectionError)
        assert "refused the session: 326" in str(failure)
    assert sessions == 1


def test_a_close_made_while_connecting_leaves_no_connection_behind() -> None:
    async def ask(client: IbkrClient, gateway: FakeGateway) -> Any:
        pending = asyncio.ensure_future(client.fetch_quotes([OPTION]))
        await asyncio.sleep(0)  # the ask has started its connect, and nothing has answered yet
        client.close()
        with pytest.raises(ConnectionError, match="closed while it was connecting"):
            await pending
        await until(lambda: gateway.connections == 0)
        # and the client still works afterwards
        return await client.fetch_quotes([OPTION])

    assert [r["code"] for r in strict("normal-with-greeks", ask).records] == [OPTION]


def test_a_caller_arriving_as_the_last_one_gives_up_gets_a_connect_of_its_own() -> None:
    """The last waiter's cancel cancels the shared connect — and a caller arriving in that same tick
    must start a new one, never be handed the cancelled task and its CancelledError."""

    class Slow(IbkrClient):
        async def _open(self) -> Any:
            await asyncio.sleep(0.2)
            raise ConnectionError("the slow gateway, at last")

    async def run() -> Any:
        client = Slow(port=1, client_id=31419)
        a = asyncio.ensure_future(client._connected())
        await asyncio.sleep(0.01)
        a.cancel()
        await asyncio.sleep(0)  # A gives up, and as the last waiter cancels the connect
        b = asyncio.ensure_future(client._connected())  # B arrives in that tick, cancelled by nobody
        with pytest.raises(asyncio.CancelledError):
            await a
        with pytest.raises(ConnectionError, match="the slow gateway"):
            await b

    asyncio.run(run())


def test_a_failed_ask_tears_down_only_its_own_connection_never_one_opened_since() -> None:
    """Ask A waits on a lookup the gateway never answers. Its connection dies under it, ask B
    reconnects and is answered, and only then does A give up. A's teardown used to close whatever
    connection the client held — B's — so the next ask paid a handshake again."""

    async def ask(client: IbkrClient, gateway: FakeGateway) -> Any:
        a = asyncio.ensure_future(client.fetch_quotes(["US.SPXW261218C8200000"]))
        await until(lambda: gateway.lookups == 1)
        gateway.drop_connections()
        await until(lambda: gateway.connections == 0)
        await until(lambda: client._client is None or not client._client.isReady())
        b = await client.fetch_quotes([OPTION])
        assert [r["code"] for r in b.records] == [OPTION]
        assert gateway.sessions_asked == 2
        with pytest.raises(ConnectionError, match="answered none of them"):
            await a
        await until(lambda: gateway.connections == 1)
        assert len((await client.fetch_quotes([OPTION])).records) == 1
        return gateway.sessions_asked

    assert against("never-answers", ask, request_timeout_ms=600) == 2


def test_reachable_is_true_where_the_handshake_completes() -> None:
    async def probe(client: IbkrClient, _: FakeGateway) -> bool:
        return await client.reachable()

    assert against("normal-with-greeks", probe) is True


def test_reachable_is_false_rather_than_raising_where_it_does_not() -> None:
    assert asyncio.run(IbkrClient(port=1, client_id=31419, connect_timeout_ms=1000).reachable()) is False
    # nor where the port answers and the session never starts
    assert against("session-never-starts", lambda client, _: client.reachable()) is False


# --- the naming: a service code as the contract IB Gateway wants -------------------------------


def test_an_option_becomes_an_opt_contract_with_its_expiry_strike_and_side() -> None:
    named = contract_for(OPTION)
    assert named is not None
    assert named.contract == TwsContract(
        symbol="SPX",
        sec_type="OPT",
        last_trade_date_or_contract_month="20261218",
        strike=8100,
        right="C",
        trading_class="SPXW",
        exchange="SMART",
        currency="USD",
        multiplier="100",
    )
    put = contract_for("US.SPXW261218P6800000")
    assert put is not None and put.contract.right == "P"
    # the code spells 8100 as 8100000; a contract asking about strike 8100000 resolves to nothing
    dated = contract_for("US.SPXW261204C8100000")
    assert dated is not None and dated.contract.strike == 8100


def test_an_index_becomes_an_ind_contract_on_the_exchange_that_calculates_it() -> None:
    named = contract_for("SPX")
    assert named is not None
    assert named.contract == TwsContract(
        symbol="SPX",
        sec_type="IND",
        last_trade_date_or_contract_month="",
        strike=0,
        right="",
        trading_class="",
        exchange="CBOE",
        currency="USD",
        multiplier="",
    )
    # measured 2026-11-08: INDU resolved only on CME after NYSE, CBOE and SMART had refused it
    assert {s: contract_for(s).contract.exchange for s in ("VIX", "NDX", "COMP", "INDU")} == {  # type: ignore[union-attr]
        "VIX": "CBOE",
        "NDX": "NASDAQ",
        "COMP": "NASDAQ",
        "INDU": "CME",
    }
    # the whole VIX term structure, which no other vendor will quote
    assert all(INDEX_EXCHANGE[s] == "CBOE" for s in ("VIX9D", "VIX3M", "VIX6M", "VVIX"))


def test_the_market_prefix_comes_off_because_ibkr_names_no_market() -> None:
    assert contract_for("US.SPX").symbol == "SPX"  # type: ignore[union-attr]
    assert contract_for("US..SPX").symbol == "SPX"  # type: ignore[union-attr]


@pytest.mark.parametrize(
    "code",
    [
        "TSLA",  # no exchange is known for it, and a guessed one would make a wrong guess look unknown
        "IXIC",
        "DJI",  # Yahoo's names for indices IBKR calls COMP and INDU
        "DJIA",
        "US.SPXW260230C8100000",  # parses to a day nothing expires on
    ],
)
def test_a_code_this_client_cannot_name_is_none(code: str) -> None:
    assert contract_for(code) is None


# --- the stub's own rules ----------------------------------------------------------------------


async def _session(gateway: FakeGateway) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    """A raw client: the version range and startApi, the way `ib_async` sends them."""
    reader, writer = await asyncio.open_connection("127.0.0.1", gateway.port)
    payload = b"v157..178"
    writer.write(b"API\0" + struct.pack(">I", len(payload)) + payload)
    writer.write(frame(["71", "2", "31419", ""]))
    await writer.drain()
    return reader, writer


async def _replies(reader: asyncio.StreamReader, wanted: int, within: float = 2.0) -> list[list[str]]:
    buffer, got = b"", []
    while len(got) < wanted:
        buffer += await asyncio.wait_for(reader.read(65536), within)
        messages, buffer = read_frames(buffer)
        got += messages
    return got


def _lookup(req_id: str, strike: str) -> list[str]:
    return [
        "9",
        "8",
        req_id,
        "0",
        "SPX",
        "OPT",
        "20261218",
        strike,
        "C",
        "100",
        "SMART",
        "",
        "USD",
        "",
        "SPXW",
        "0",
        "",
        "",
    ]


def test_the_stub_greets_with_the_recording_and_answers_by_contract() -> None:
    conversation = load_conversation("normal-with-greeks")

    async def run() -> list[list[str]]:
        gateway = await start_fake_gateway("normal-with-greeks")
        reader, writer = await _session(gateway)
        start = len(conversation["handshake"]["onStartApi"])
        # the strike by VALUE: "8100" from one client and "8100.0" from another are one double
        writer.write(frame(_lookup("42", "8100")))
        await writer.drain()
        got = await _replies(reader, 1 + start + 2)
        writer.close()
        await gateway.close()
        return got

    got = asyncio.run(run())
    assert got[0] == conversation["handshake"]["greeting"]
    assert got[1 : 1 + len(conversation["handshake"]["onStartApi"])] == conversation["handshake"]["onStartApi"]
    # its own id, where the recording says $reqId
    assert got[-1] == ["52", "1", "42"]


def test_the_stub_answers_several_exchanges_in_turn_the_last_ever_after() -> None:
    """`link-down-between-asks` holds two market-data exchanges for one contract: the first answer
    once, then silence — counted over the stub's life, so reconnecting does not undo it."""

    async def run() -> list[int]:
        gateway = await start_fake_gateway("link-down-between-asks")
        counts = []
        for req_id in ("7", "8", "9"):
            reader, writer = await _session(gateway)
            await _replies(reader, 1 + len(gateway.conversation["handshake"]["onStartApi"]))
            writer.write(frame(["1", "11", req_id, *_lookup(req_id, "8100.0")[3:15], "0", "", "1", "0", ""]))
            await writer.drain()
            try:
                # the stub answers at once or never, so a short wait is enough to tell which
                counts.append(len(await _replies(reader, 1, within=0.3)))
            except TimeoutError:
                counts.append(0)
            writer.close()
        await gateway.close()
        return counts

    first, *after = asyncio.run(run())
    assert first > 0, "the first request was not answered"
    assert after == [0, 0], "a later request was answered by an exchange that should be spent"


def test_the_stub_answers_market_data_only_with_an_exchange_that_asked_the_same_way() -> None:
    """A snapshot and a stream of one contract are two questions with two answers — a snapshot of SPX
    carries no price at all and its stream does — so a recording of one never stands in for the
    other. normal-with-greeks holds the option as a snapshot."""

    async def run() -> tuple[list[list[str]], list[list[str]]]:
        gateway = await start_fake_gateway("normal-with-greeks")
        reader, writer = await _session(gateway)
        await _replies(reader, 1 + len(gateway.conversation["handshake"]["onStartApi"]))
        writer.write(frame(_data("7", snapshot="0")))
        await writer.drain()
        try:
            stream = await _replies(reader, 1, within=0.3)
        except TimeoutError:
            stream = []
        writer.write(frame(_data("8", snapshot="1")))
        await writer.drain()
        snapshot = await _replies(reader, 1)
        writer.close()
        await gateway.close()
        return stream, snapshot

    stream, snapshot = asyncio.run(run())
    assert stream == []
    assert snapshot


def test_the_stub_paces_replies_by_their_recorded_times_and_stops_at_a_cancel() -> None:
    """When a figure arrives is what a client's completion rule is about. normal-with-greeks' model
    greeks came 1945ms after the request and its snapshot end 11104ms after: at a tenth, 195ms and
    1110ms — and a cancel before the end means no end, as the gateway stops a cancelled request."""

    async def run() -> dict[str, float]:
        gateway = await start_fake_gateway("normal-with-greeks", pace=0.1)
        reader, writer = await _session(gateway)
        await _replies(reader, 1 + len(gateway.conversation["handshake"]["onStartApi"]))
        asked = time.monotonic()
        writer.write(frame(_data("7", snapshot="1")))
        await writer.drain()
        at: dict[str, float] = {}
        while "model" not in at:
            for message in await _replies(reader, 1):
                key = "model" if message[:1] == ["21"] and message[2] == "13" else message[0]
                at.setdefault(key, (time.monotonic() - asked) * 1000)
        writer.write(frame(["2", "2", "7"]))
        await writer.drain()
        try:
            after = await _replies(reader, 1, within=1.3)
        except TimeoutError:
            after = []
        at["after the cancel"] = float(len(after))
        writer.close()
        await gateway.close()
        return at

    at = asyncio.run(run())
    assert at["58"] < at["model"]
    assert at["model"] >= 150
    # neither the snapshot's end, due at 1110ms, nor the error 300 recorded for a cancel AFTER the
    # end: a snapshot cancelled before its end got no reply and nothing after it (2026-11-10)
    assert at["after the cancel"] == 0.0, "something was sent after the request was cancelled"


def test_the_stub_answers_a_cancel_after_the_last_paced_reply_with_what_the_gateway_said() -> None:
    async def run() -> list[list[str]]:
        gateway = await start_fake_gateway("normal-with-greeks", pace=0.1)
        reader, writer = await _session(gateway)
        await _replies(reader, 1 + len(gateway.conversation["handshake"]["onStartApi"]))
        writer.write(frame(_data("7", snapshot="1")))
        await writer.drain()
        while not any(m[0] == "57" for m in await _replies(reader, 1, within=3.0)):
            pass
        writer.write(frame(["2", "2", "7"]))
        await writer.drain()
        got = await _replies(reader, 1)
        writer.close()
        await gateway.close()
        return got

    assert asyncio.run(run()) == [["4", "2", "7", "300", "Can't find EId with tickerId:7"]]


def test_the_stub_answers_an_unsubscribe_with_the_2100_even_one_that_cuts_a_paced_answer_short() -> None:
    """The live gateway answered EVERY unsubscribe with exactly one 2100 (2026-11-23), so the stub does
    too, whether or not the account's replies were all sent."""
    conversation = copy.deepcopy(load_conversation("account-paper"))
    exchange = conversation["exchanges"][0]
    exchange["atMs"] = [0 if i == 0 else 5000 for i in range(len(exchange["replies"]))]

    async def run() -> list[list[str]]:
        gateway = await start_fake_gateway(conversation, pace=1)
        reader, writer = await _session(gateway)
        await _replies(reader, 1 + len(conversation["handshake"]["onStartApi"]))
        writer.write(frame(["6", "2", "1", "DU0000000"]))
        await writer.drain()
        first = await _replies(reader, 1)
        writer.write(frame(["6", "2", "0", "DU0000000"]))
        await writer.drain()
        after = await _replies(reader, 1)
        writer.close()
        await gateway.close()
        return first + after

    first, after = asyncio.run(run())[:2]
    assert first[0] == "6"
    assert after[:4] == ["4", "2", "-1", "2100"]


def _data(req_id: str, snapshot: str) -> list[str]:
    """reqMktData for the control, a snapshot ("1") or a stream ("0") — field 17."""
    return ["1", "11", req_id, *_lookup(req_id, "8100.0")[3:15], "0", "", snapshot, "0", ""]


def test_a_recorded_snapshot_of_an_index_carries_empty_prices_which_read_as_none() -> None:
    """`index-in-the-session`'s last exchanges, recorded in the session on 2026-11-10: SPX asked as a
    SNAPSHOT sends its high, low and close each with an empty price field, then the snapshot's end.
    The client never asks that (it streams an index), so the stub is asked directly, with the
    request the recording sent, and the price ticks are read with this module's own reader."""
    from optionality import ibkr

    conversation = load_conversation("index-in-the-session")
    (snapshot,) = [
        e
        for e in conversation["exchanges"]
        if e["request"] == "reqMktData"
        and e["contract"]["symbol"] == "SPX"
        and e["contract"]["secType"] == "IND"
        and e["sent"][17] == "1"
    ]

    async def run() -> list[list[str]]:
        gateway = await start_fake_gateway(conversation)
        reader, writer = await _session(gateway)
        await _replies(reader, 1 + len(conversation["handshake"]["onStartApi"]))
        writer.write(frame([field.replace("$reqId", "7") for field in snapshot["sent"]]))
        await writer.drain()
        got: list[list[str]] = []
        while not any(m[0] == "57" for m in got):
            got += await _replies(reader, 1)
        writer.close()
        await gateway.close()
        return got

    prices = [ibkr._read_price(m) for m in asyncio.run(run()) if m[0] == "1"]
    assert [(p.req_id, p.tick_type, p.price) for p in prices] == [(7, 6, None), (7, 7, None), (7, 9, None)]


def test_an_empty_price_is_delivered_as_no_price_rather_than_dropped() -> None:
    """`ib_async`'s decoder skips a price tick whose price is empty before any callback; this one
    delivers it, as no figure but still the gateway ANSWERING. A snapshot of SPX sends its high, low
    and close that way, recorded on 2026-11-09 and 2026-11-10."""
    pytest.importorskip("ib_async")
    from optionality import ibkr

    delivered: list[Any] = []

    class Wrapper:
        def figures(self, message: Any) -> None:
            delivered.append(message)

    _, decoder_class, _ = ibkr._transport()
    decoder_class(Wrapper(), 0).priceSizeTick(["1", "6", "7", "9", "", "0", "0"])
    assert [(m.req_id, m.tick_type, m.price) for m in delivered] == [(7, 9, None)]


# --- the account read (ADR 0030) -----------------------------------------------------------------
#
# `client.test.ts`' account claims, ported. Every conversation is CONSTRUCTED in ibapi 9.81's layout,
# with invented figures and placeholder accounts: nothing of the owner's account is ever committed.


def subscriptions(gateway: FakeGateway) -> list[list[str]]:
    """The account subscriptions the stub was sent, in order: [subscribe, account]."""
    return [[f[2], f[3]] for f in gateway.received if f[0] == "6"]


async def unsubscribed(gateway: FakeGateway) -> None:
    """Until every subscribe has had its unsubscribe, or a second has passed."""
    until = time.monotonic() + 1
    while sum(1 if on == "1" else -1 for on, _ in subscriptions(gateway)) > 0 and time.monotonic() < until:
        await asyncio.sleep(0.005)


def test_the_account_read_answers_totals_and_holdings_with_the_account_masked() -> None:
    async def read(client: IbkrClient, _: FakeGateway) -> Any:
        return await client.account()

    got = against("account-stocks-and-options", read)
    assert (got["account"], got["paper"], got["base_currency"], got["updated_at"]) == (
        "U•••••000",
        False,
        "USD",
        "14:32",
    )
    # the P&L from $LEDGER's BASE row, which counts the EUR stock's; the USD row does not
    assert got["totals"] == {
        "net_liquidation": 184523.17,
        "total_cash": 64829.28,
        "unrealized_pnl": 2071.37,
        "realized_pnl": -412.8,
    }
    assert [(h["symbol"], h["sec_type"], h["currency"], h["position"]) for h in got["holdings"]] == [
        ("ACME", "STK", "USD", 300),
        ("GLOBEX", "STK", "USD", 120),
        ("INITECH", "STK", "EUR", 50),
        ("ACME", "OPT", "USD", 4),
        ("ACME", "OPT", "USD", -6),
    ]
    # IB's averageCost for an option is per contract; the answer's is per share
    assert got["holdings"][3]["average_cost"] == 2.625
    assert got["exchange_rates"] == {"USD": 1, "EUR": 1.0841, "CHF": 1.1307}


def test_the_account_read_sends_a_subscribe_then_its_unsubscribe_and_nothing_else() -> None:
    async def read(client: IbkrClient, gateway: FakeGateway) -> Any:
        await client.account()
        await unsubscribed(gateway)
        return subscriptions(gateway)

    assert against("account-stocks-and-options", read) == [["1", "U0000000"], ["0", "U0000000"]]


def test_the_account_read_fails_at_the_deadline_and_unsubscribes_anyway() -> None:
    async def read(client: IbkrClient, gateway: FakeGateway) -> Any:
        with pytest.raises(ConnectionError) as raised:
            await client.account()
        await unsubscribed(gateway)
        return str(raised.value), subscriptions(gateway)

    words, sent = against("account-never-ends", read, request_timeout_ms=300)
    assert words == (
        "IB Gateway did not finish sending the account within 300ms — its link to IBKR may be down "
        "while its own socket is still open"
    )
    assert sent == [["1", "U0000000"], ["0", "U0000000"]]


def test_two_callers_of_the_account_read_send_one_subscribe() -> None:
    async def read(client: IbkrClient, gateway: FakeGateway) -> Any:
        a, b = await asyncio.gather(client.account(), client.account())
        await unsubscribed(gateway)
        return a == b, subscriptions(gateway)

    assert against("account-stocks-and-options", read) == (True, [["1", "U0000000"], ["0", "U0000000"]])


def test_a_read_of_another_account_waits_until_the_running_one_has_unsubscribed() -> None:
    """IB allows a single account subscription per client at a time: a second subscribe while the first
    runs would take its place, and the first read would never hear its download end."""

    async def read(client: IbkrClient, gateway: FakeGateway) -> Any:
        first, second = await asyncio.gather(client.account("U0000000"), client.account("U0000001"))
        await unsubscribed(gateway)
        return [first["account"], second["account"]], subscriptions(gateway)

    assert against("account-several", read) == (
        ["U•••••000", "U•••••001"],
        [["1", "U0000000"], ["0", "U0000000"], ["1", "U0000001"], ["0", "U0000001"]],
    )


def test_a_waiting_read_takes_the_connection_afresh_where_the_one_it_waited_on_lost_it() -> None:
    """Review round 2: the waiting read held the connection it found before the wait, and
    subscribed on a dead one — "not connected to IB Gateway"."""
    conversation = copy.deepcopy(load_conversation("account-several"))
    for exchange in conversation["exchanges"]:
        if exchange["account"] == "U0000000":
            exchange["replies"] = [m for m in exchange["replies"] if m[0] != "54"]

    async def read(client: IbkrClient, gateway: FakeGateway) -> Any:
        first = asyncio.ensure_future(client.account("U0000000"))
        second = asyncio.ensure_future(client.account("U0000001"))
        until = time.monotonic() + 1
        while not subscriptions(gateway) and time.monotonic() < until:
            await asyncio.sleep(0.005)
        gateway.drop_connections()
        with pytest.raises(ConnectionError) as raised:
            await first
        answered = await second
        await unsubscribed(gateway)
        return str(raised.value), answered["account"], subscriptions(gateway), gateway.sessions_asked

    assert against(conversation, read, request_timeout_ms=5000) == (
        "IB Gateway's connection closed during the account read",
        "U•••••001",
        [["1", "U0000000"], ["1", "U0000001"], ["0", "U0000001"]],
        2,
    )


def test_the_2100_answering_an_unsubscribe_is_ignored_though_it_arrives_during_the_next_read() -> None:
    """Measured on 2026-11-23: every unsubscribe is answered with error 2100 against -1. A read begun
    straight after the last one's unsubscribe has its subscribe on the wire before that 2100 comes
    back, so the 2100 arrives DURING it, and must not end it."""

    async def read(client: IbkrClient, _: FakeGateway) -> Any:
        first = await client.account()
        second = await client.account()
        return first == second

    assert against("account-stocks-and-options", read) is True


def test_a_read_after_one_has_finished_subscribes_afresh() -> None:
    async def read(client: IbkrClient, gateway: FakeGateway) -> Any:
        await client.account()
        await client.account()
        await unsubscribed(gateway)
        return subscriptions(gateway)

    assert against("account-paper", read) == [["1", "DU0000000"], ["0", "DU0000000"]] * 2


def test_several_accounts_with_none_named_are_refused_masked_and_nothing_is_subscribed() -> None:
    async def read(client: IbkrClient, gateway: FakeGateway) -> Any:
        with pytest.raises(IbkrAccountRefused) as raised:
            await client.account()
        return str(raised.value), subscriptions(gateway)

    assert against("account-several", read) == (
        "several accounts on this login; set IBKR_ACCOUNT to one of U•••••000, U•••••001",
        [],
    )


def test_the_account_named_of_several_is_read_and_one_not_on_the_login_refused() -> None:
    async def read(client: IbkrClient, _: FakeGateway) -> Any:
        named = await client.account("U0000001")
        with pytest.raises(IbkrAccountRefused) as raised:
            await client.account("DU0000001")
        return named["account"], named["totals"]["net_liquidation"], str(raised.value)

    assert against("account-several", read) == (
        "U•••••001",
        25010,
        "IBKR_ACCOUNT (DU•••••001) names no account on this login, which has U•••••000, U•••••001",
    )


def test_the_account_read_ignores_what_the_gateway_says_about_another_account() -> None:
    conversation = copy.deepcopy(load_conversation("account-paper"))
    stray = ["7", "8", "100000999", "ACME", "STK", "", "0.0", "0", "", "NASDAQ", "USD", "ACME", "NMS", "1"]
    stray += ["41.27", "41.27", "40", "1.27", "0.0", "DU0000001"]
    conversation["exchanges"][0]["replies"].insert(0, stray)

    async def read(client: IbkrClient, _: FakeGateway) -> Any:
        return [h["position"] for h in (await client.account())["holdings"]]

    assert against(conversation, read) == [-1]


def test_closing_the_client_fails_an_account_read_at_once() -> None:
    async def read(client: IbkrClient, _: FakeGateway) -> Any:
        running = asyncio.ensure_future(client.account())
        await asyncio.sleep(0.05)
        client.close()
        with pytest.raises(ConnectionError) as raised:
            await running
        return str(raised.value)

    got = against("account-never-ends", read, request_timeout_ms=5000)
    assert got == "IB Gateway's connection closed during the account read"


def test_an_account_read_that_cannot_connect_raises_ibkr_unreachable_in_the_connects_words() -> None:
    """Round 4, for the route (#473): a gateway the read cannot reach is neither a refusal to choose
    an account nor a read that failed once it began."""

    async def read(client: IbkrClient, _: FakeGateway) -> Any:
        with pytest.raises(IbkrUnreachable) as raised:
            await client.account()
        return str(raised.value)

    assert against("client-id-in-use", read).startswith("IB Gateway refused the session: 326 ")


def test_an_account_read_with_nothing_on_the_port_raises_ibkr_unreachable() -> None:
    async def read() -> str:
        probe = await start_fake_gateway("normal-with-greeks")
        port = probe.port
        await probe.close()
        client = IbkrClient(port=port, client_id=31419, connect_timeout_ms=1000)
        try:
            with pytest.raises(IbkrUnreachable) as raised:
                await client.account()
        finally:
            client.close()
        return str(raised.value)

    words = asyncio.run(read())
    assert words.startswith("could not reach IB Gateway at 127.0.0.1:")


def test_a_read_that_failed_once_it_began_is_not_called_unreachable() -> None:
    async def read(client: IbkrClient, _: FakeGateway) -> Any:
        with pytest.raises(ConnectionError) as raised:
            await client.account()
        return raised.value

    assert not isinstance(against("account-never-ends", read, request_timeout_ms=300), IbkrUnreachable)
    assert issubclass(IbkrUnreachable, ConnectionError)


def test_no_account_id_is_written_in_full_in_an_answer_an_error_or_a_log_line(
    caplog: pytest.LogCaptureFixture, capsys: pytest.CaptureFixture[str]
) -> None:
    """Logs at INFO and up, which is all the service lets a library write: `ib_async`'s DEBUG log is
    the wire itself, every field of every message, and the backend holds every library at WARNING."""
    caplog.set_level(logging.INFO)
    caplog.set_level(logging.DEBUG, logger="optionality")
    said: list[str] = []
    for name, wanted in (
        ("account-stocks-and-options", None),
        ("account-paper", None),
        ("account-several", None),
        ("account-several", "U0000001"),
        ("account-several", "DU0000001"),
        ("account-never-ends", None),
    ):

        async def read(client: IbkrClient, _: FakeGateway, wanted: str | None = wanted) -> str:
            try:
                return repr(await client.account(wanted))
            except Exception as err:  # noqa: BLE001 — the words are what is searched
                return str(err)

        said.append(against(name, read, request_timeout_ms=300))
    out = capsys.readouterr()
    said += [record.getMessage() for record in caplog.records] + [out.out, out.err]
    for account in ("DU0000000", "DU0000001", "U0000000", "U0000001"):
        assert [line for line in said if account in line] == [], account


def test_the_account_messages_are_read_field_by_field_an_empty_figure_kept_as_none() -> None:
    """`ib_async`'s PORTFOLIO_VALUE reader converts every figure with `float()`, so one empty field
    drops the whole row with a logged traceback; this one delivers it, the figure as none."""
    pytest.importorskip("ib_async")
    from optionality import ibkr

    delivered: list[Any] = []

    class Wrapper:
        def account(self, message: Any) -> None:
            delivered.append(message)

    _, decoder_class, _ = ibkr._transport()
    decoder = decoder_class(Wrapper(), 157)
    row = ["7", "8", "100000201", "ACME", "OPT", "20261218", "45.0", "C", "100", "", "USD"]
    row += ["ACME  261218C00045000", "ACME", "4", "", "1540.0", "262.5", "490.0", "0.0", "U0000000"]
    for fields in (["6", "2", "NetLiquidation", "184523.17", "USD", "U0000000"], row, ["8", "1", "14:32"]):
        decoder.interpret(fields)
    decoder.interpret(["54", "1", "U0000000"])
    value, portfolio, when, end = delivered
    assert value.row == {"key": "NetLiquidation", "value": "184523.17", "currency": "USD"}
    assert (portfolio.account, portfolio.con_id) == ("U0000000", "100000201")
    assert ibkr.holding_from(portfolio.row)["market_price"] is None
    assert ibkr.holding_from(portfolio.row)["average_cost"] == 2.625
    assert (when.time, end.account) == ("14:32", "U0000000")
