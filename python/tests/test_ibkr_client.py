"""The IB Gateway client's narrower claims, each with its reason — `client.test.ts` and
`contract.test.ts`, ported, and the stub's own rules.

`test_ibkr_gateway.py` holds what every recorded conversation comes to against the TypeScript's
answer. These are the claims a batch cannot show: that the conid cache saves a lookup, that a
close drops it, that an empty list asks nothing, that a gateway nobody can reach raises with words
that say so. Over a real loopback socket against `fake_gateway.py`, never a real gateway.
"""

import asyncio
import struct
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from fake_gateway import FakeGateway, frame, load_conversation, read_frames, start_fake_gateway

from optionality.ibkr import INDEX_EXCHANGE, IbkrClient, TwsContract, contract_for

OPTION = "US.SPXW261218C8100000"
#: the model's computation for OPTION, as the gateway sent it (tick 13, normal-with-greeks)
MODEL_DELTA, MODEL_THETA, MODEL_IV = 0.03210521375811607, -0.32748349484896266, 0.13795658209227243


def against(
    conversation: str, test: Callable[[IbkrClient, FakeGateway], Awaitable[Any]], server_version: str | None = None
) -> Any:
    """Run `test` against a fresh stub replaying `conversation`, closing both whatever happens."""

    async def run() -> Any:
        gateway = await start_fake_gateway(conversation, server_version)
        client = IbkrClient(port=gateway.port, client_id=31419, connect_timeout_ms=1000, request_timeout_ms=1000)
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


def test_an_index_empty_close_is_no_figure_never_a_close_of_zero() -> None:
    async def ask(client: IbkrClient, _: FakeGateway) -> Any:
        return await client.fetch_quotes([OPTION, "SPX"])

    batch = against("index-before-the-open", ask)
    assert [r for r in batch.records if r["code"] == "SPX"] == [{"code": "SPX", "delayed": False, "last_known": False}]


def test_an_empty_list_asks_nothing_and_does_not_even_connect() -> None:
    async def ask(client: IbkrClient, gateway: FakeGateway) -> Any:
        batch = await client.fetch_quotes([])
        return batch, list(gateway.received)

    batch, received = against("normal-with-greeks", ask)
    assert (batch.records, batch.unknown) == ([], [])
    assert received == []


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
