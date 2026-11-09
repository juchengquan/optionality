"""Creating a monitor, once, for both doors onto it.

backend/src/create-monitor.ts has no test of its own: its two doors' suites rely on it. So this holds
what they rely on — `entrypoints/http/routes/monitors.test.ts` (ported beside this) on the order of
the five steps, on the probe seeing a combo's legs in one call, on a muted rule, on the scope the link
writes being the scope the reply carries, and on the probe's own sentence when it throws; and
`entrypoints/bot/bot.test.ts` (not ported yet) on `/watch` not asking the Provider about a rule it
already has, and on the threshold coming back as values for the bot to word in its own longer way.
"""

from datetime import UTC, datetime

import pytest
from harness import fake_fetcher
from optionality.quote import Batch

from optionality_backend.create_monitor import (
    BadComboField,
    BadThreshold,
    ComboInput,
    ComboLeg,
    CreateDeps,
    Duplicate,
    SingleInput,
    UnknownContract,
    create_combo_monitor,
    create_single_monitor,
    is_fault,
)
from optionality_backend.db.open import create_database
from optionality_backend.db.queries import list_monitors
from optionality_backend.db.values import to_sqlite_json

NOW = datetime(2026, 10, 2, 5, 26, 6, 299000, tzinfo=UTC)
C8100 = "US.SPXW261218C8100000"
C8150 = "US.SPXW261218C8150000"


@pytest.fixture
def db(tmp_path):
    d = create_database(tmp_path / "test.db")
    yield d
    d.close()


@pytest.fixture
def asked():
    return []


@pytest.fixture
def deps(db, asked):
    async def echo(codes):
        asked.append(codes)
        return [{"code": c} for c in codes]

    return CreateDeps(db=db, fetch_quotes=fake_fetcher(echo), now=lambda: NOW, new_id=lambda: "n" * 32)


def single(**over):
    return SingleInput(**{"strike_date": "2026-12-18", "option_type": "CALL", "strike": 8100, "threshold": 0.3, **over})


def combo(**over):
    return ComboInput(
        **{
            "name": "dec-calls",
            "strike_date": "2026-12-18",
            "legs": [
                ComboLeg(sign=-1, option_type="CALL", strike=8150),
                ComboLeg(sign=1, option_type="CALL", strike=8100),
            ],
            "threshold": 4,
            **over,
        }
    )


class TestTheOrderIsThePoint:
    async def test_refuses_a_rule_already_there_without_asking_the_provider(self, deps, asked):
        assert not is_fault(await create_single_monitor(deps, single()))
        assert len(asked) == 1, "creating one must still probe the contract"
        again = await create_single_monitor(deps, single())
        assert again == Duplicate(code=C8100, field="option_delta")
        assert len(asked) == 1, "the duplicate was sent to the Provider anyway"

    async def test_names_a_combo_field_that_does_not_add_up_before_a_threshold_it_refuses(self, deps, asked):
        result = await create_combo_monitor(deps, combo(field="option_implied_volatility", threshold=-1))
        assert result == BadComboField(
            message="combos cannot watch option_implied_volatility: it is not additive across legs"
        )
        assert asked == []

    async def test_answers_a_refused_threshold_as_values_for_each_door_to_word(self, deps, asked):
        # the bot's sentence is longer than the API's, so the compare and the threshold come back
        assert await create_single_monitor(deps, single(threshold=0, compare="signed")) == BadThreshold(
            compare="signed", threshold=0
        )
        assert await create_combo_monitor(deps, combo(threshold=-1)) == BadThreshold(compare="abs", threshold=-1)
        assert asked == []


class TestTheProbe:
    async def test_sees_a_combo_s_legs_deduplicated_and_sorted_in_one_call(self, deps, asked):
        legs = [ComboLeg(sign=-1, option_type="CALL", strike=8150), ComboLeg(sign=1, option_type="CALL", strike=8100)]
        await create_combo_monitor(deps, combo(legs=[*legs, legs[0]]))
        assert asked == [[C8100, C8150]]

    async def test_refuses_a_contract_the_provider_does_not_know_and_writes_nothing(self, db):
        async def fetch(codes):
            return Batch(records=[], unknown=codes)

        deps = CreateDeps(db=db, fetch_quotes=fake_fetcher(fetch), now=lambda: NOW)
        result = await create_single_monitor(deps, single())
        assert result == UnknownContract(message=f"contract does not exist: {C8100} — check strike and expiry")
        assert list_monitors(db) == []

    async def test_carries_the_provider_s_own_sentence_when_the_probe_throws(self, db):
        async def fetch(codes):
            raise RuntimeError("Client connection failed!")

        deps = CreateDeps(db=db, fetch_quotes=fake_fetcher(fetch), now=lambda: NOW)
        assert await create_single_monitor(deps, single()) == UnknownContract(
            message="cannot verify contract: the Provider did not confirm it — Client connection failed!"
        )


class TestTheRowItWrites:
    async def test_writes_every_column_with_the_defaults_applied_once(self, deps):
        row = await create_single_monitor(deps, single())
        assert row == {
            "id": "n" * 32,
            "code": C8100,
            "strike_date": "2026-12-18",
            "option_type": "CALL",
            "strike": 8100,
            "field": "option_delta",
            "threshold": 0.3,
            "direction": "above",
            "compare": "abs",
            "legs": None,
            "scope": None,
            "enabled": 1,
            "disabled_reason": None,
            "triggered": 0,
            "last_value": None,
            "last_checked_at": None,
            "last_alarm_at": None,
            "created_at": "2026-10-02 05:26:06.299000",
        }

    async def test_writes_a_combo_under_its_name_with_its_legs_as_json_stringify_writes_them(self, deps):
        row = await create_combo_monitor(deps, combo())
        assert (row["code"], row["option_type"], row["strike"], row["field"]) == ("dec-calls", "CMB", 0, "mid_price")
        assert row["legs"] == to_sqlite_json(
            [{"sign": -1, "option_type": "CALL", "strike": 8150}, {"sign": 1, "option_type": "CALL", "strike": 8100}]
        )
        assert (
            row["legs"]
            == '[{"sign":-1,"option_type":"CALL","strike":8150},{"sign":1,"option_type":"CALL","strike":8100}]'
        )

    async def test_creates_a_rule_already_muted_by_hand(self, deps):
        row = await create_single_monitor(deps, single(enabled=False))
        assert (row["enabled"], row["disabled_reason"]) == (0, "manual")

    async def test_answers_the_scope_linking_wrote_rather_than_the_row_as_inserted(self, db, deps):
        db.execute(
            """insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
             values ('p', 'lone', null, '2026-12-18', 1, 2.0, ?, '2026-08-01 00:00:00.000000')""",
            ('[{"side":"short","option_type":"CALL","strike":8100}]',),
        )
        row = await create_single_monitor(deps, single())
        assert row["scope"] == "all"
