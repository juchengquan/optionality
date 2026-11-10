"""The positions table's queries: what is actually held.

backend/src/db/queries/positions.ts has no test of its own: its callers' suites rely on it. So this
holds what they rely on — `entrypoints/http/routes/positions.test.ts` on the listing order ("lists by
expiry, then by name"), on a duplicate name being found before the insert, on insert and update
answering the row as stored, and on delete; `engine/positions.test.ts` on the manage-by stamp; and
`monitors.test.ts`'s total-entry group on setting an entry.
"""

import pytest

from optionality_backend.db.open import create_database
from optionality_backend.db.queries.positions import (
    delete_position_row,
    find_position,
    find_position_by_name,
    insert_position,
    list_positions,
    set_position_entry,
    stamp_manage_notified,
    update_position_fields,
)


@pytest.fixture
def db(tmp_path):
    d = create_database(tmp_path / "t.db")
    yield d
    d.close()


def held(id_, name, strike_date="2026-12-18", **over):
    return {
        "id": id_,
        "name": name,
        "strategy": None,
        "strike_date": strike_date,
        "contracts": 1,
        "entry": None,
        "legs": "[]",
        "created_at": "2026-11-08 00:00:00.000000",
        "opened_at": None,
        "manage_notified_at": None,
        "closed_on": None,
        "exit": None,
        **over,
    }


class TestListing:
    def test_lists_by_expiry_then_by_name(self, db):
        # the dashboard's order: expiry groups, then name
        insert_position(db, held("z", "zulu", "2026-10-16"))
        insert_position(db, held("a", "alpha", "2026-11-20"))
        insert_position(db, held("m", "mike", "2026-10-16"))
        assert [p["name"] for p in list_positions(db)] == ["mike", "zulu", "alpha"]

    def test_is_empty_with_nothing_held(self, db):
        assert list_positions(db) == []


class TestFinding:
    def test_finds_by_id_and_by_name_and_answers_none_for_neither(self, db):
        insert_position(db, held("p1", "dec-condor"))
        assert find_position(db, "p1")["name"] == "dec-condor"
        assert find_position_by_name(db, "dec-condor")["id"] == "p1"
        assert find_position(db, "nope") is None
        assert find_position_by_name(db, "nope") is None


class TestWriting:
    def test_an_insert_answers_the_row_as_stored(self, db):
        saved = insert_position(db, held("p1", "dec-condor", entry=6.4, legs='[{"side":"short"}]'))
        assert saved == held("p1", "dec-condor", entry=6.4, legs='[{"side":"short"}]')

    def test_an_update_changes_only_what_it_names_and_answers_the_row_as_stored(self, db):
        insert_position(db, held("p1", "dec-condor", strategy="iron condor"))
        saved = update_position_fields(db, "p1", {"entry": 6.4, "opened_at": "2026-10-12"})
        assert (saved["entry"], saved["opened_at"], saved["strategy"]) == (6.4, "2026-10-12", "iron condor")

    def test_an_empty_update_still_answers_the_row(self, db):
        insert_position(db, held("p1", "dec-condor"))
        assert update_position_fields(db, "p1", {})["name"] == "dec-condor"

    def test_delete_removes_the_one_row(self, db):
        insert_position(db, held("p1", "one"))
        insert_position(db, held("p2", "two"))
        delete_position_row(db, "p1")
        assert [p["id"] for p in list_positions(db)] == ["p2"]

    def test_sets_an_entry_and_stamps_the_manage_by_notice(self, db):
        insert_position(db, held("p1", "one"))
        set_position_entry(db, "p1", 3.5)
        stamp_manage_notified(db, "p1", "2026-11-09 15:00:00.000000")
        stored = find_position(db, "p1")
        assert (stored["entry"], stored["manage_notified_at"]) == (3.5, "2026-11-09 15:00:00.000000")
