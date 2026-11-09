"""The service's interfaces. backend/src/ports.ts has no test of its own — an interface has no
behaviour, and the compiler holds the TypeScript's fakes to it. Python has no compiler in the gate,
so this holds the claims the callers' tests rely on: what a fake must answer to stand in for the
engine's health, a vendor and the Provider, and that a Reference-only vendor owes no `reachable`.
"""

from datetime import datetime

from optionality.quote import Batch

from optionality_backend.ports import AlarmState, ProviderClient, SweeperPort, VendorClient


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
