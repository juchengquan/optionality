"""`position_samples`: one observation of a holding per market day (ADR 0011).

backend/src/db/queries/samples.ts has no test of its own: its callers' suites rely on it. So this
holds what they rely on — `engine/positions.test.ts` on a day's sample converging on the last write
of that day and on the sampler reading the stored one to decline rewriting it;
`routes/positions.test.ts` on a holding's samples, oldest first, for its vol figure, and on the
delete that takes them with their holding.
"""

import pytest

from optionality_backend.db.open import create_database
from optionality_backend.db.queries.positions import insert_position
from optionality_backend.db.queries.samples import (
    clear_position_samples,
    find_position_sample,
    list_position_samples,
    record_position_sample,
)


@pytest.fixture
def db(tmp_path):
    d = create_database(tmp_path / "t.db")
    for pid in ("p1", "p2"):
        insert_position(
            d,
            {
                "id": pid,
                "name": pid,
                "strategy": None,
                "strike_date": "2026-12-18",
                "contracts": 1,
                "entry": None,
                "legs": "[]",
                "created_at": "2026-11-08 00:00:00.000000",
                "opened_at": None,
                "manage_notified_at": None,
                "closed_on": None,
                "exit": None,
                "qty_corrected_at": None,
            },
        )
    yield d
    d.close()


def sample(observed_on, cost_to_close=1.5, position_id="p1", **over):
    return {
        "position_id": position_id,
        "observed_on": observed_on,
        "dte": 30,
        "cost_to_close": cost_to_close,
        "legs_iv": '{"US.SPXW261218C8100000":0.12}',
        "legs_vega": None,
        "legs_delta": None,
        "observed_at": None,
        "spx": None,
        **over,
    }


class TestRecording:
    def test_keeps_one_row_a_market_day_and_the_last_write_of_the_day_is_the_one_that_stays(self, db):
        # REPLACE, not IGNORE: the row converges on the settled mark
        record_position_sample(db, sample("2026-11-02", 1.5))
        record_position_sample(db, sample("2026-11-02", 1.75, legs_iv=None))
        assert list_position_samples(db, "p1") == [sample("2026-11-02", 1.75, legs_iv=None)]

    def test_answers_a_holdings_samples_oldest_first_and_nobody_elses(self, db):
        record_position_sample(db, sample("2026-11-04"))
        record_position_sample(db, sample("2026-11-02"))
        record_position_sample(db, sample("2026-11-03", position_id="p2"))
        assert [s["observed_on"] for s in list_position_samples(db, "p1")] == ["2026-11-02", "2026-11-04"]

    def test_finds_the_sample_already_stored_for_a_day_and_none_for_a_day_without_one(self, db):
        record_position_sample(db, sample("2026-11-02", legs_vega='{"US.SPXW261218C8100000":3.2}'))
        assert find_position_sample(db, "p1", "2026-11-02") == sample(
            "2026-11-02", legs_vega='{"US.SPXW261218C8100000":3.2}'
        )
        assert find_position_sample(db, "p1", "2026-11-03") is None
        assert find_position_sample(db, "p2", "2026-11-02") is None


class TestClearing:
    def test_clears_one_holdings_samples_and_leaves_everyone_elses(self, db):
        record_position_sample(db, sample("2026-11-02"))
        record_position_sample(db, sample("2026-11-02", position_id="p2"))
        clear_position_samples(db, "p1")
        assert list_position_samples(db, "p1") == []
        assert len(list_position_samples(db, "p2")) == 1
