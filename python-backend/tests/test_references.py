"""The reference path: one bounded call, and a degrade the watchlist cannot afford (ADR 0018). Port of
backend/src/references.test.ts.

What is being protected here is the WATCHLIST, not these rows. A Reference is a backdrop; the rules
are what the owner acts on. So the two rules this file holds are both about containment: a Reference
never shares the `/quotes` batch, and a Reference that cannot be priced costs the others nothing.

The TypeScript builds the whole harness for its database; here a fixture does, and closes it — the
TypeScript leaves some of its harnesses open, which a temporary folder in Python would outlive.

What only the Python can get wrong is at the end.
"""

import asyncio
from dataclasses import dataclass, field
from typing import Any

import pytest
from harness import harness
from optionality.quote import Batch

from optionality_backend.db.queries import insert_reference
from optionality_backend.ports import QuoteFetcher
from optionality_backend.references import ReferenceEntry, reference_readings

#: US.SPY as the live gateway gave it on 2026-11-02.
SPY = {
    "code": "US.SPY",
    "name": "SPDR S&P 500 ETF Trust",
    "bid_price": 758.7,
    "ask_price": 758.76,
    "mid_price": 758.73,
    "last_price": 755.72,
    "prev_close_price": 755.72,
}
QQQ = {"code": "US.QQQ", "name": "Invesco QQQ Trust", "mid_price": 598.5, "prev_close_price": 600}


@pytest.fixture
def db():
    h = harness()
    yield h.db
    h.close()


def add(db, **over: Any) -> str:
    id_ = str(over.get("id", "r1".ljust(32, "0")))
    insert_reference(
        db,
        {
            "id": id_,
            "code": "US.SPY",
            "label": "SPY",
            "source": "moomoo",
            "created_at": "2026-11-02 00:00:00.000000",
            **over,
        },
    )
    return id_


@dataclass
class Pricing:
    """A Provider that prices these codes and nothing else, counting its calls."""

    records: dict[str, dict[str, Any]]
    calls: list[list[str]] = field(default_factory=list)

    async def fetch(self, codes: list[str]) -> Batch:
        self.calls.append(list(codes))
        return Batch(
            records=[self.records[c] for c in codes if c in self.records],
            unknown=[c for c in codes if c not in self.records],
        )


def pricing(records: dict[str, dict[str, Any]]) -> Pricing:
    return Pricing(records)


def fields(entry: ReferenceEntry, *names: str) -> dict[str, Any]:
    """`toMatchObject`: the named fields of an entry, to compare with what the test states."""
    return {n: getattr(entry, n) for n in names}


class TestOneBoundedCallOfItsOwn:
    async def test_asks_for_every_reference_in_a_single_batch(self, db):
        add(db)
        add(db, id="r2".ljust(32, "0"), code="US.QQQ", label=None, created_at="2026-11-02 00:00:01.000000")
        p = pricing({"US.SPY": SPY, "US.QQQ": QQQ})

        rows = await reference_readings(db, {"moomoo": p.fetch})
        assert p.calls == [["US.SPY", "US.QQQ"]]
        assert [r.figure for r in rows] == [758.73, 598.5]

    async def test_breaks_a_same_instant_tie_by_code_so_the_strip_cannot_reshuffle_between_polls(self, db):
        # the strip reads left to right and the order they were ADDED in is the only order the owner
        # chose; two rows written in the same millisecond have none, and an undefined order would
        # reshuffle on a poll — which reads as a change
        add(db, id="r1".ljust(32, "0"), code="US.SPY")
        add(db, id="r2".ljust(32, "0"), code="US.QQQ", label=None)
        p = pricing({"US.SPY": SPY, "US.QQQ": QQQ})
        assert [r.code for r in await reference_readings(db, {"moomoo": p.fetch})] == ["US.QQQ", "US.SPY"]

    async def test_asks_for_nothing_at_all_when_there_are_no_references(self, db):
        p = pricing({})
        assert await reference_readings(db, {"moomoo": p.fetch}) == []
        # the dashboard polls this every 15 seconds per open tab, and a call for an empty list would
        # be a Provider call that buys nothing (ADR 0010)
        assert p.calls == []

    async def test_carries_the_label_the_source_and_the_security_s_own_name_through(self, db):
        add(db)
        p = pricing({"US.SPY": SPY})
        assert await reference_readings(db, {"moomoo": p.fetch}) == [
            ReferenceEntry(
                id="r1".ljust(32, "0"),
                code="US.SPY",
                label="SPY",
                source="moomoo",
                name="SPDR S&P 500 ETF Trust",
                figure=758.73,
                field="mid_price",
                change=(758.73 - 755.72) / 755.72,
                error=None,
                # moomoo reports no grade at all, so all three are None rather than False: False would
                # read as "the vendor told us this is live" (ADR 0019)
                delayed=None,
                last_known=None,
                delayed_by_minutes=None,
            )
        ]


class TestWhatTheVendorSaidAboutFreshness:
    async def test_carries_a_vendor_s_own_claim_through_to_the_page(self, db):
        add(db, code="SPX", source="ibkr")
        fetch = pricing(
            {"SPX": {"code": "SPX", "name": "S&P 500", "last_price": 7376.86, "delayed": True, "last_known": True}}
        ).fetch
        [row] = await reference_readings(db, {"ibkr": fetch})
        assert row.delayed is True
        assert row.last_known is True

    async def test_carries_minutes_only_where_the_vendor_stated_them(self, db):
        # Yahoo reports exchangeDataDelayedBy; IBKR reports a tier and no duration
        add(db, code="^VIX", source="yahoo")
        fetch = pricing(
            {"^VIX": {"code": "^VIX", "last_price": 25.64, "delayed": True, "delayed_by_minutes": 15}}
        ).fetch
        [row] = await reference_readings(db, {"yahoo": fetch})
        assert row.delayed_by_minutes == 15

    async def test_says_null_where_the_vendor_said_nothing_never_false(self, db):
        # moomoo reports no grade. False would be a claim the vendor never made.
        add(db, code="US.SPY", source="moomoo")
        [row] = await reference_readings(db, {"moomoo": pricing({"US.SPY": SPY}).fetch})
        assert row.delayed is None
        assert row.last_known is None
        assert row.delayed_by_minutes is None

    async def test_ignores_a_vendor_s_claim_that_is_not_a_boolean(self, db):
        # a wire format with no published schema can send anything, and "yes" is not a claim
        add(db, code="SPX", source="ibkr")
        fetch = pricing({"SPX": {"code": "SPX", "last_price": 1, "delayed": "yes"}}).fetch
        [row] = await reference_readings(db, {"ibkr": fetch})
        assert row.delayed is None


class TestMoreThanOneSource:
    async def test_asks_each_vendor_once_one_call_per_source_not_per_reference(self, db):
        # distinct stamps, because rows order by created_at and then by CODE — sharing a stamp would
        # sort these as SPX, US.QQQ, US.SPY and make the assertions below about alphabet, not order
        add(db, id="r1".ljust(32, "0"), code="US.SPY", source="moomoo", created_at="2026-11-08 00:00:01.000000")
        add(db, id="r2".ljust(32, "0"), code="US.QQQ", source="moomoo", created_at="2026-11-08 00:00:02.000000")
        add(db, id="r3".ljust(32, "0"), code="SPX", source="ibkr", created_at="2026-11-08 00:00:03.000000")
        moo = pricing({"US.SPY": SPY, "US.QQQ": QQQ})
        ibkr = pricing({"SPX": {"code": "SPX", "name": "S&P 500", "mid_price": 7376.86}})

        rows = await reference_readings(db, {"moomoo": moo.fetch, "ibkr": ibkr.fetch})

        assert moo.calls == [["US.SPY", "US.QQQ"]]
        assert ibkr.calls == [["SPX"]]
        assert [r.figure for r in rows] == [758.73, 598.5, 7376.86]
        assert [r.source for r in rows] == ["moomoo", "moomoo", "ibkr"]

    async def test_leaves_one_vendor_s_figures_standing_when_the_other_is_dead(self, db):
        # the whole point of grouping by source. IB Gateway logs out every Sunday by design, and a
        # moomoo-sourced figure must not dash alongside it — the argument that gave References a call
        # of their own, one level up (ADR 0019)
        add(db, id="r1".ljust(32, "0"), code="US.SPY", source="moomoo", created_at="2026-11-08 00:00:01.000000")
        add(db, id="r2".ljust(32, "0"), code="SPX", source="ibkr", created_at="2026-11-08 00:00:02.000000")
        moo = pricing({"US.SPY": SPY})

        async def dead(codes: list[str]) -> Batch:
            raise RuntimeError("Couldn't connect to TWS")

        rows = await reference_readings(db, {"moomoo": moo.fetch, "ibkr": dead})

        assert rows[0].figure == 758.73
        assert rows[0].error is None
        assert rows[1].figure is None
        assert "Couldn't connect to TWS" in (rows[1].error or "")

    async def test_says_which_vendor_is_missing_rather_than_blaming_the_code(self, db):
        # a name SOURCES knows and this build cannot reach. "does not know this code" would send the
        # owner looking at the code, which is the one thing that is fine.
        add(db, id="r1".ljust(32, "0"), code="SPX", source="ibkr")
        rows = await reference_readings(db, {"moomoo": pricing({}).fetch})
        assert rows[0].figure is None
        assert rows[0].error == "no ibkr client in this build"

    async def test_names_the_vendor_that_refused_the_code_not_the_provider(self, db):
        # ADR 0019 let a Reference name its own source, and this sentence was written before it: a
        # Yahoo row whose symbol Yahoo does not carry said "the Provider does not know this code" about
        # a vendor the Provider had never been asked about. Measured on 2026-11-08. It is the third
        # appearance of this bug class — ADR 0018 fixed it in `verifyContracts` and the sweeper's
        # degraded default fixed it again — and each time the fault was the same: a sentence that names
        # one vendor while the service reads several.
        add(db, id="r1".ljust(32, "0"), code="NOTATICKER", source="yahoo")
        rows = await reference_readings(db, {"yahoo": pricing({}).fetch})
        assert rows[0].error == "yahoo does not know this code"
        assert "Provider" not in rows[0].error, "never the word Provider"

    async def test_names_the_vendor_for_a_silent_omission_too_which_is_the_other_half(self, db):
        # a batch that answered, with this code neither priced nor named unknown — a different answer
        # from both, and it named "the Provider" as well
        add(db, id="r1".ljust(32, "0"), code="^GSPC", source="yahoo")

        async def silent(codes: list[str]) -> Batch:
            return Batch(records=[], unknown=[])

        rows = await reference_readings(db, {"yahoo": silent})
        assert rows[0].error == "yahoo returned no quote for it"

    async def test_spends_no_call_on_a_vendor_that_has_no_reference(self, db):
        add(db, code="US.SPY", source="moomoo")
        moo = pricing({"US.SPY": SPY})
        ibkr = pricing({})
        await reference_readings(db, {"moomoo": moo.fetch, "ibkr": ibkr.fetch})
        assert ibkr.calls == []


class TestAReferenceTheProviderWillNotPrice:
    async def test_shows_a_dash_and_says_so_and_the_others_still_read(self, db):
        add(db, id="r1".ljust(32, "0"), code="US.NOPE", label=None, source="moomoo")
        add(db, id="r2".ljust(32, "0"), code="US.SPY")
        p = pricing({"US.SPY": SPY})

        rows = await reference_readings(db, {"moomoo": p.fetch})
        assert fields(rows[0], "code", "figure", "field") == {"code": "US.NOPE", "figure": None, "field": None}
        assert "does not know" in (rows[0].error or "")
        assert rows[1].figure == 758.73

    async def test_is_never_disabled_and_never_deleted(self, db):
        id_ = add(db, code="US.NOPE")
        before = tuple(db.execute("select * from reference_securities where id = ?", (id_,)).fetchone())
        await reference_readings(db, {"moomoo": pricing({}).fetch})
        # the row is exactly as it was: quarantine is defined as a Monitor the service disabled because
        # it cannot be EVALUATED, and a Reference evaluates nothing. Nor is anything sent — this path
        # has no sender to speak through, which is the structural half of the same rule (ADR 0018).
        assert tuple(db.execute("select * from reference_securities where id = ?", (id_,)).fetchone()) == before

    async def test_says_a_quote_that_came_back_with_no_price_is_a_missing_price_not_a_missing_quote(self, db):
        add(db, code="US.SPY", label=None, source="moomoo")
        # priced, named, and with an empty book: `(0 + 0) / 2` is a mid and 0 is not a price
        p = pricing({"US.SPY": {"code": "US.SPY", "name": "SPDR", "mid_price": 0}})
        rows = await reference_readings(db, {"moomoo": p.fetch})
        assert fields(rows[0], "figure", "name") == {"figure": None, "name": "SPDR"}
        assert "no price" in (rows[0].error or "")


def refusing(bad: str, records: dict[str, dict[str, Any]]) -> tuple[QuoteFetcher, list[list[str]]]:
    """The failure this exists for: moomoo refuses a US stock index as a CLASS, naming no culprit, so
    the containment loop in `opend/client.ts` re-throws — and a Reference in the sweep's batch would
    have taken every sweep down with it every fifteen seconds (#175's shape)."""
    calls: list[list[str]] = []

    async def fetch(codes: list[str]) -> Batch:
        calls.append(list(codes))
        if any(c.startswith(bad) for c in codes):
            raise RuntimeError("snapshot API failed: US stock indices are not supported")
        return Batch(
            records=[records[c] for c in codes if c in records],
            unknown=[c for c in codes if c not in records],
        )

    return fetch, calls


class TestAFetchThatThrew:
    async def test_retries_one_code_at_a_time_so_the_culprit_alone_goes_dark(self, db):
        add(db, id="r1".ljust(32, "0"), code="US..SPX", label=None, source="moomoo")
        add(db, id="r2".ljust(32, "0"), code="US.SPY")
        fetch, calls = refusing("US..SPX", {"US.SPY": SPY})  # exact, so SPY is priced

        rows = await reference_readings(db, {"moomoo": fetch})
        # the batch, then one call per Reference — bounded by the number of References, which is what
        # the sweep cannot afford and this path can
        assert calls == [["US..SPX", "US.SPY"], ["US..SPX"], ["US.SPY"]]
        assert rows[0].figure is None
        # the Provider's own sentence, because it is what says whether the gateway is down or whether
        # it answered and declined the security
        assert "US stock indices are not supported" in (rows[0].error or "")
        assert rows[1].figure == 758.73

    async def test_retries_at_most_once_per_reference_however_many_throw(self, db):
        add(db, id="r1".ljust(32, "0"), code="US..SPX", label=None)
        add(db, id="r2".ljust(32, "0"), code="US..VIX", label=None)
        fetch, calls = refusing("US.", {})
        rows = await reference_readings(db, {"moomoo": fetch})
        assert len(calls) == 3
        assert all(r.error is not None for r in rows)

    async def test_does_not_retry_when_the_batch_answered_an_unknown_code_is_an_answer(self, db):
        add(db, code="US.NOPE", label=None)
        p = pricing({})
        await reference_readings(db, {"moomoo": p.fetch})
        assert p.calls == [["US.NOPE"]]


class TestWhatOnlyThePythonCanGetWrong:
    async def test_asks_every_source_at_once_rather_than_one_after_another(self, db):
        # `Promise.all` in the TypeScript: the dashboard waits on this, and a logged-out gateway's
        # timeout must not be ADDED to a healthy vendor's latency. A `for` with an `await` in it is
        # the natural Python and would add them; this holds that the two calls are in flight together.
        add(db, id="r1".ljust(32, "0"), code="US.SPY", source="moomoo", created_at="2026-11-08 00:00:01.000000")
        add(db, id="r2".ljust(32, "0"), code="SPX", source="ibkr", created_at="2026-11-08 00:00:02.000000")
        in_flight, peak = 0, 0

        async def slow(codes: list[str]) -> Batch:
            nonlocal in_flight, peak
            in_flight += 1
            peak = max(peak, in_flight)
            await asyncio.sleep(0)  # the network, as far as the loop can tell
            in_flight -= 1
            return Batch(records=[{"code": c, "mid_price": 1} for c in codes], unknown=[])

        rows = await reference_readings(db, {"moomoo": slow, "ibkr": slow})
        assert [r.figure for r in rows] == [1, 1]
        assert peak == 2, "the second source was asked only after the first had answered"

    async def test_a_vendor_s_minutes_that_are_a_boolean_are_not_minutes(self, db):
        # `typeof x === "number"` is false for `true`; in Python `isinstance(True, int)` is not
        add(db, code="^VIX", source="yahoo")
        fetch = pricing({"^VIX": {"code": "^VIX", "last_price": 25.64, "delayed_by_minutes": True}}).fetch
        [row] = await reference_readings(db, {"yahoo": fetch})
        assert row.delayed_by_minutes is None

    async def test_a_vendor_s_claim_that_is_one_or_zero_is_not_a_boolean(self, db):
        # `typeof x === "boolean"` is false for 1; in Python `1 == True`, and a check written as a
        # comparison would take it
        add(db, code="SPX", source="ibkr")
        fetch = pricing({"SPX": {"code": "SPX", "last_price": 1, "delayed": 1, "last_known": 0}}).fetch
        [row] = await reference_readings(db, {"ibkr": fetch})
        assert (row.delayed, row.last_known) == (None, None)
