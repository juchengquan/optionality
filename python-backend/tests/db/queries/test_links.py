"""`monitor_positions`: which holdings each rule covers.

backend/src/db/queries/links.ts has no test of its own: its callers' suites rely on it. So this holds
what they rely on — `entrypoints/http/routes/monitors.test.ts` and `routes/positions.test.ts` on
creation linking a rule to its holdings and deletion clearing the links before the row, which the
foreign key otherwise refuses (#70, #81); `GET /monitors` on each rule's holdings, by name; and
`monitors.test.ts`'s total-entry group on which wings a whole-position rule watches alone.
"""

import sqlite3

import pytest

from optionality_backend.db.open import create_database
from optionality_backend.db.queries.links import (
    clear_monitor_links,
    clear_position_links,
    link_monitor_to_positions,
    positions_for_monitor,
    positions_for_monitors,
    solely_watched_positions,
)
from optionality_backend.db.queries.monitors import delete_monitor_row, insert_monitor
from optionality_backend.db.queries.positions import delete_position_row, insert_position
from optionality_backend.db.queries.sql import rows


@pytest.fixture
def db(tmp_path):
    d = create_database(tmp_path / "t.db")
    yield d
    d.close()


def held(id_, name):
    return {
        "id": id_,
        "name": name,
        "strategy": "credit_spread",
        "strike_date": "2026-12-18",
        "contracts": 1,
        "entry": None,
        "legs": "[]",
        "created_at": "2026-11-08 00:00:00.000000",
        "opened_at": None,
        "manage_notified_at": None,
        "closed_on": None,
        "exit": None,
    }


def rule(id_, code, scope="all"):
    return {
        "id": id_,
        "code": code,
        "strike_date": "2026-12-18",
        "option_type": "CMB",
        "strike": 0,
        "field": "mid_price",
        "threshold": 9.0,
        "direction": "above",
        "compare": "abs",
        "legs": '[{"sign":-1,"option_type":"CALL","strike":8050}]',
        "scope": scope,
        "enabled": 1,
        "disabled_reason": None,
        "triggered": 0,
        "last_value": None,
        "last_checked_at": None,
        "last_alarm_at": None,
        "created_at": "2026-11-08 00:00:00.000000",
    }


def links(db):
    return [(r["monitor_id"], r["position_id"]) for r in rows(db, "select * from monitor_positions order by 1, 2")]


class TestLinking:
    def test_links_a_rule_to_each_holding_it_covers(self, db):
        insert_position(db, held("p2", "puts"))
        insert_position(db, held("p1", "calls"))
        insert_monitor(db, rule("m", "span"))
        link_monitor_to_positions(db, "m", ["p2", "p1"])
        assert links(db) == [("m", "p1"), ("m", "p2")]

    def test_answers_each_rules_holdings_by_name(self, db):
        insert_position(db, held("p1", "zulu"))
        insert_position(db, held("p2", "alpha"))
        insert_monitor(db, rule("m1", "span"))
        insert_monitor(db, rule("m2", "single"))
        insert_monitor(db, rule("m3", "none"))
        link_monitor_to_positions(db, "m1", ["p1", "p2"])
        link_monitor_to_positions(db, "m2", ["p1"])
        owned = positions_for_monitors(db, ["m1", "m2", "m3"])
        assert {k: [p["name"] for p in v] for k, v in owned.items()} == {"m1": ["alpha", "zulu"], "m2": ["zulu"]}
        # each is the holding's row as stored, with nothing of the link's left in it
        assert owned["m2"][0] == held("p1", "zulu")

    def test_answers_nothing_for_no_rules_without_asking_the_database(self, db):
        db.close()  # a query would raise on a closed connection
        assert positions_for_monitors(db, []) == {}

    def test_answers_one_rules_holdings_and_none_for_a_rule_with_none(self, db):
        insert_position(db, held("p1", "calls"))
        insert_monitor(db, rule("m", "calls"))
        link_monitor_to_positions(db, "m", ["p1"])
        assert [p["id"] for p in positions_for_monitor(db, "m")] == ["p1"]
        assert positions_for_monitor(db, "nope") == []


class TestClearing:
    def test_a_linked_row_cannot_be_deleted_until_its_links_are_cleared(self, db):
        # the hazard this table has of its own: nothing manages it, and the foreign key refuses
        insert_position(db, held("p1", "calls"))
        insert_monitor(db, rule("m", "calls"))
        link_monitor_to_positions(db, "m", ["p1"])
        with pytest.raises(sqlite3.IntegrityError):
            delete_monitor_row(db, "m")
        with pytest.raises(sqlite3.IntegrityError):
            delete_position_row(db, "p1")

    def test_clears_a_rules_links_and_leaves_everyone_elses(self, db):
        insert_position(db, held("p1", "calls"))
        insert_monitor(db, rule("m1", "a"))
        insert_monitor(db, rule("m2", "b"))
        link_monitor_to_positions(db, "m1", ["p1"])
        link_monitor_to_positions(db, "m2", ["p1"])
        clear_monitor_links(db, "m1")
        assert links(db) == [("m2", "p1")]
        delete_monitor_row(db, "m1")

    def test_clears_a_holdings_links_and_leaves_everyone_elses(self, db):
        insert_position(db, held("p1", "calls"))
        insert_position(db, held("p2", "puts"))
        insert_monitor(db, rule("m", "span"))
        link_monitor_to_positions(db, "m", ["p1", "p2"])
        clear_position_links(db, "p1")
        assert links(db) == [("m", "p2")]
        delete_position_row(db, "p1")


class TestWhichWingsAreDirectlyEditable:
    def test_is_only_those_a_whole_position_rule_watches_alone(self, db):
        # a leg rule links to one Position too but offers no field, and a rule over two holdings
        # belongs to neither alone (ADR 0004)
        for pid, name in (("calls", "calls"), ("puts", "puts"), ("wing", "wing")):
            insert_position(db, held(pid, name))
        insert_monitor(db, rule("whole", "calls_rule", "all"))
        insert_monitor(db, rule("span", "span_rule", "all"))
        insert_monitor(db, rule("leg", "leg_rule", "leg"))
        link_monitor_to_positions(db, "whole", ["calls"])
        link_monitor_to_positions(db, "span", ["calls", "puts"])
        link_monitor_to_positions(db, "leg", ["wing"])
        assert solely_watched_positions(db) == {"calls"}
