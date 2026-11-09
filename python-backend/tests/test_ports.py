"""The service's interfaces. backend/src/ports.ts has no test of its own — an interface has no
behaviour, and the compiler holds the TypeScript's fakes to it. Python has no compiler in the gate,
so this holds the claims the callers' tests rely on: what a fake must answer to stand in for the
engine's health, a vendor and the Provider, and that a Reference-only vendor owes no `reachable`.

`verify_contracts` is the exception, and its tests are ported: see `TestVerifyContracts`.
"""

import re
from datetime import datetime

from optionality.quote import Batch

from optionality_backend.ports import AlarmState, ProviderClient, SweeperPort, VendorClient, verify_contracts


class NeverSwept:
    """The harness's sweeper: a service that has not swept yet."""

    def last_sweep_at(self) -> datetime | None:
        return None

    def last_sweep_ok(self) -> bool:
        return False

    def consecutive_failures(self) -> int:
        return 0

    def alarm_state(self) -> AlarmState:
        return AlarmState(label="starting", bad=False)

    def last_fetch_at(self) -> datetime | None:
        return None

    def last_fetch_ok(self) -> bool | None:
        return None


async def echo(codes: list[str]) -> Batch:
    return Batch(records=[{"code": c} for c in codes], unknown=[])


class Yahoo:
    """A Reference-only vendor: no gateway to probe."""

    name = "yahoo"
    fetch_quotes = staticmethod(echo)

    def close(self) -> None:
        pass


class OpenD(Yahoo):
    name = "opend"

    async def reachable(self) -> bool:
        return True


#: what /health reads of the engine, and all it may: no route can start a sweep through this
SIX = ["last_sweep_at", "last_sweep_ok", "consecutive_failures", "alarm_state", "last_fetch_at", "last_fetch_ok"]


def test_a_fake_answering_the_six_questions_is_the_engines_health():
    assert isinstance(NeverSwept(), SweeperPort)


def test_a_fake_missing_any_one_of_them_is_not():
    for missing in SIX:
        stub = type("Stub", (), {name: getattr(NeverSwept, name) for name in SIX if name != missing})
        assert not isinstance(stub(), SweeperPort), missing


def test_the_alarm_state_is_a_label_and_whether_it_is_bad():
    state = NeverSwept().alarm_state()
    assert (state.label, state.bad) == ("starting", False)


def test_a_reference_only_vendor_owes_no_reachable():
    assert isinstance(Yahoo(), VendorClient)
    assert not isinstance(Yahoo(), ProviderClient)


async def test_the_provider_is_a_vendor_that_can_also_be_probed():
    provider = OpenD()
    assert isinstance(provider, VendorClient)
    assert isinstance(provider, ProviderClient)
    assert await provider.reachable() is True
    assert await provider.fetch_quotes(["US.SPXW261218C8100"]) == Batch(
        records=[{"code": "US.SPXW261218C8100"}], unknown=[]
    )


class TestVerifyContracts:
    """The creation probe, awaited. Port of the `verifyContracts` tests in typescript/src/quotes.test.ts:
    the TypeScript backend imports the function from its library, and the Python library's
    `optionality.quotes.verify_contracts` takes the synchronous fetcher a notebook has, so the
    service's own lives in `ports.py` beside the awaited `QuoteFetcher` it takes."""

    CODE = "US.SPXW261218C6500000"
    POISON = "US.SPXW261218C99999000"

    @classmethod
    async def poisonable(cls, codes: list[str]) -> Batch:
        """A Provider that prices everything but the poison, and says which code it could not price."""
        return Batch(
            records=[{"code": c, "option_delta": 0.7} for c in codes if c != cls.POISON],
            unknown=[c for c in codes if c == cls.POISON],
        )

    async def test_passes_a_contract_that_exists(self):
        assert await verify_contracts([self.CODE], self.poisonable) is None

    async def test_names_a_contract_that_does_not(self):
        assert "does not exist" in (await verify_contracts([self.POISON], self.poisonable) or "")

    async def test_refuses_when_the_probe_threw_rather_than_accepting_blind(self):
        async def down(codes: list[str]) -> Batch:
            raise RuntimeError("Client connection failed!")

        assert (
            await verify_contracts([self.CODE], down)
            == "cannot verify contract: the Provider did not confirm it — Client connection failed!"
        )

    async def test_does_not_call_a_provider_that_answered_and_declined_an_outage_adr_0018(self):
        # moomoo refuses every US stock index as a CLASS, naming no culprit — so the containment loop
        # re-throws and this is the path `US..SPX` takes. The gateway is up; saying "unreachable" sends
        # the owner to look at the wrong thing, and the Provider's own sentence is what says which of the
        # two it was.
        async def declined(codes: list[str]) -> Batch:
            raise RuntimeError("snapshot API failed: US stock indices are not supported")

        why = await verify_contracts(["US..SPX"], declined)
        assert why is not None
        assert "US stock indices are not supported" in why
        assert not re.search(r"unreachable|down|outage", why)

    async def test_takes_the_pessimistic_reading_when_the_provider_contradicts_itself(self):
        # a Provider that prices a code AND names it unknown: at a creation gate that must be a refusal
        async def contradictory(codes: list[str]) -> Batch:
            return Batch(records=[{"code": c, "option_delta": 0.7} for c in codes], unknown=[self.POISON])

        assert "does not exist" in (await verify_contracts([self.CODE, self.POISON], contradictory) or "")

    async def test_names_a_contract_the_batch_simply_did_not_come_back_with(self):
        # not named as unknown, and no record either: the Provider answered about the others and said
        # nothing at all about this one
        async def partial(codes: list[str]) -> Batch:
            return Batch(records=[{"code": c} for c in codes if c != self.POISON], unknown=[])

        assert "does not exist" in (await verify_contracts([self.CODE, self.POISON], partial) or "")
