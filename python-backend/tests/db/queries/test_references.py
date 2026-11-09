"""`reference_securities`: the Securities kept on the page to read the market by (ADR 0018, 0019).

backend/src/db/queries/references.ts has no test of its own: its callers' suites rely on it. So this
holds what they rely on — `entrypoints/http/routes/references.test.ts` on the strip's order (the
order the owner added them in, with the code breaking a tie), on a code already kept being found
before the insert, on insert answering the row as stored, and on delete; and `references.test.ts`
on reading every Reference for its one bounded call per source.
"""

import sqlite3

import pytest

from optionality_backend.db.open import create_database
from optionality_backend.db.queries.references import (
    delete_reference_row,
    find_reference,
    find_reference_by_code,
    insert_reference,
    list_references,
)


@pytest.fixture
def db(tmp_path):
    d = create_database(tmp_path / "t.db")
    yield d
    d.close()


def kept(id_, code, created_at="2026-11-08 00:00:00.000000", label=None, source="moomoo"):
    return {"id": id_, "code": code, "label": label, "source": source, "created_at": created_at}


class TestTheStripsOrder:
    def test_is_the_order_they_were_added_in_and_the_code_breaks_a_tie(self, db):
        # two rows in one millisecond would otherwise have no defined order, and the strip would
        # reshuffle between polls
        insert_reference(db, kept("a", "US.SPY", "2026-11-08 00:00:02.000000"))
        insert_reference(db, kept("b", "^VIX", "2026-11-08 00:00:01.000000", source="yahoo"))
        insert_reference(db, kept("c", "US.QQQ", "2026-11-08 00:00:01.000000"))
        assert [r["code"] for r in list_references(db)] == ["US.QQQ", "^VIX", "US.SPY"]

    def test_is_empty_with_nothing_kept(self, db):
        assert list_references(db) == []


class TestFinding:
    def test_finds_by_id_and_by_code_and_answers_none_for_neither(self, db):
        insert_reference(db, kept("a", "US.SPY", label="S&P"))
        assert find_reference(db, "a")["code"] == "US.SPY"
        assert find_reference_by_code(db, "US.SPY")["id"] == "a"
        assert find_reference(db, "nope") is None
        assert find_reference_by_code(db, "US.QQQ") is None


class TestWriting:
    def test_an_insert_answers_the_row_as_stored(self, db):
        assert insert_reference(db, kept("a", "^GSPC", label="S&P 500", source="yahoo")) == kept(
            "a", "^GSPC", label="S&P 500", source="yahoo"
        )

    def test_a_code_is_kept_once(self, db):
        # two References on one Security would be two figures that cannot differ
        insert_reference(db, kept("a", "US.SPY"))
        with pytest.raises(sqlite3.IntegrityError):
            insert_reference(db, kept("b", "US.SPY", source="ibkr"))

    def test_delete_removes_the_one_row(self, db):
        insert_reference(db, kept("a", "US.SPY"))
        insert_reference(db, kept("b", "US.QQQ"))
        delete_reference_row(db, "a")
        assert [r["id"] for r in list_references(db)] == ["b"]
