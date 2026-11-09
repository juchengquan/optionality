"""The monitors table's queries: the rules the alarm engine evaluates.

backend/src/db/queries/monitors.ts has no test of its own: its callers' suites rely on it. So this
holds what they rely on — `entrypoints/http/routes/monitors.test.ts` on the watchlist's order, on a
duplicate (code, field) being found before the insert and a rename not conflicting with itself, and
on insert, update and delete answering or leaving the rows as stored; `entrypoints/bot/commands`'
suites on `/quotes` leaving combos out, on `/unwatch` finding a rule by code, short contract or id
prefix and naming EVERY match, and on `/combo` and `/rename` finding a combo by name; and
`routes/positions.test.ts` on the orphans adoption considers and on the scope a deleted holding
leaves behind.
"""

import pytest

from optionality_backend.db.open import create_database
from optionality_backend.db.queries.links import link_monitor_to_positions
from optionality_backend.db.queries.monitors import (
    clear_scope_of_orphans,
    delete_monitor_row,
    enabled_monitors,
    find_combo_by_name,
    find_monitor,
    find_monitor_by_code_field,
    find_monitors_by_identifier,
    insert_monitor,
    list_monitors,
    orphan_monitors,
    set_monitor_scope,
    update_monitor_fields,
)
from optionality_backend.db.queries.positions import insert_position

LEGS = '[{"sign":1,"option_type":"CALL","strike":8100},{"sign":-1,"option_type":"CALL","strike":8150}]'


@pytest.fixture
def db(tmp_path):
    d = create_database(tmp_path / "t.db")
    yield d
    d.close()


def rule(id_, code, strike_date="2026-12-18", option_type="CALL", strike=8100, **over):
    """A stored rule with every column set; a single leg unless `legs` says otherwise."""
    return {
        "id": id_,
        "code": code,
        "strike_date": strike_date,
        "option_type": option_type,
        "strike": strike,
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
        "created_at": "2026-11-08 00:00:00.000000",
        **over,
    }


def combo(id_, name, strike_date="2026-12-18", **over):
    return rule(id_, name, strike_date, option_type="CMB", strike=0, field="mid_price", legs=LEGS, **over)


def held(id_, name):
    return {
        "id": id_,
        "name": name,
        "strategy": None,
        "strike_date": "2026-12-18",
        "contracts": 1,
        "entry": None,
        "legs": "[]",
        "created_at": "2026-11-08 00:00:00.000000",
        "opened_at": None,
        "manage_notified_at": None,
    }


class TestTheWatchlistsOrder:
    def test_is_expiry_then_combos_before_single_legs_then_calls_before_puts_then_strike(self, db):
        insert_monitor(db, rule("a", "US.SPXW261218P7000000", option_type="PUT", strike=7000))
        insert_monitor(db, rule("b", "US.SPXW261218C8200000", strike=8200))
        insert_monitor(db, rule("c", "US.SPXW261120C9000000", "2026-11-20", strike=9000))
        insert_monitor(db, combo("d", "dec-wing"))
        insert_monitor(db, rule("e", "US.SPXW261218C8100000", strike=8100))
        assert [m["id"] for m in list_monitors(db)] == ["c", "d", "e", "b", "a"]

    def test_lists_only_enabled_rules_for_the_live_quotes_and_combos_only_when_asked(self, db):
        insert_monitor(db, rule("a", "US.SPXW261218C8100000"))
        insert_monitor(db, rule("b", "US.SPXW261218C8200000", strike=8200, enabled=0, disabled_reason="manual"))
        insert_monitor(db, combo("c", "dec-wing"))
        assert [m["id"] for m in enabled_monitors(db, False)] == ["a"]
        # a signed sum cannot be rendered in the bot's four columns, so combos come only when asked
        assert [m["id"] for m in enabled_monitors(db, True)] == ["c", "a"]


class TestFinding:
    def test_finds_by_id_and_answers_none_for_a_rule_that_is_not_there(self, db):
        insert_monitor(db, rule("a", "US.SPXW261218C8100000"))
        assert find_monitor(db, "a")["code"] == "US.SPXW261218C8100000"
        assert find_monitor(db, "nope") is None

    def test_finds_the_one_rule_on_a_code_and_field_and_lets_an_update_not_conflict_with_itself(self, db):
        insert_monitor(db, combo("a", "dec-wing"))
        assert find_monitor_by_code_field(db, "dec-wing", "mid_price")["id"] == "a"
        assert find_monitor_by_code_field(db, "dec-wing", "option_delta") is None
        assert find_monitor_by_code_field(db, "dec-wing", "mid_price", "a") is None, "itself is no conflict"
        insert_monitor(db, combo("b", "jan-wing"))
        assert find_monitor_by_code_field(db, "dec-wing", "mid_price", "b")["id"] == "a", "another rule is"

    def test_finds_a_combo_by_name_and_never_a_single_leg_rule_by_its_code(self, db):
        insert_monitor(db, combo("a", "dec-wing"))
        insert_monitor(db, rule("b", "US.SPXW261218C8100000"))
        assert find_combo_by_name(db, "dec-wing")["id"] == "a"
        assert find_combo_by_name(db, "US.SPXW261218C8100000") is None


class TestFindingWhatTheBotsWordsMean:
    def test_matches_the_exact_code_the_joined_form_an_id_prefix_and_an_expanded_short_contract(self, db):
        insert_monitor(db, rule("abc1", "US.SPXW261218C8100000"))
        insert_monitor(db, combo("xyz2", "dec-wing"))
        assert [m["id"] for m in find_monitors_by_identifier(db, "dec-wing", "DEC-WING", None)] == ["xyz2"]
        assert [
            m["id"] for m in find_monitors_by_identifier(db, "us.spxw261218c8100000", "US.SPXW261218C8100000", None)
        ] == ["abc1"]
        assert [m["id"] for m in find_monitors_by_identifier(db, "abc", "ABC", None)] == ["abc1"]
        assert [m["id"] for m in find_monitors_by_identifier(db, "261218", "261218C8100", "US.SPXW261218C8100000")] == [
            "abc1"
        ]

    def test_answers_every_match_rather_than_the_first(self, db):
        # "ambiguous" is an answer the owner can act on; picking one deletes the wrong alarm
        insert_monitor(db, rule("ab11", "US.SPXW261218C8100000"))
        insert_monitor(db, rule("ab22", "US.SPXW261218C8200000", strike=8200))
        assert sorted(m["id"] for m in find_monitors_by_identifier(db, "ab", "AB", None)) == ["ab11", "ab22"]

    def test_finds_nothing_for_words_that_mean_nothing(self, db):
        insert_monitor(db, rule("abc1", "US.SPXW261218C8100000"))
        assert find_monitors_by_identifier(db, "zzz", "ZZZ", None) == []


class TestWriting:
    def test_an_insert_answers_the_row_as_stored(self, db):
        assert insert_monitor(db, combo("a", "dec-wing")) == combo("a", "dec-wing")

    def test_an_update_changes_only_what_it_names_and_answers_the_row_as_stored(self, db):
        insert_monitor(db, combo("a", "dec-wing", triggered=1, last_value=9.5))
        saved = update_monitor_fields(db, "a", {"code": "jan-wing", "threshold": 12.0})
        assert (saved["code"], saved["threshold"]) == ("jan-wing", 12.0)
        assert (saved["triggered"], saved["last_value"]) == (1, 9.5), "the alarm state is kept"

    def test_an_empty_update_still_answers_the_row(self, db):
        insert_monitor(db, combo("a", "dec-wing"))
        assert update_monitor_fields(db, "a", {})["code"] == "dec-wing"

    def test_delete_removes_the_one_row(self, db):
        insert_monitor(db, rule("a", "US.SPXW261218C8100000"))
        insert_monitor(db, rule("b", "US.SPXW261218C8200000", strike=8200))
        delete_monitor_row(db, "a")
        assert [m["id"] for m in list_monitors(db)] == ["b"]

    def test_sets_a_scope_and_clears_one(self, db):
        insert_monitor(db, rule("a", "US.SPXW261218C8100000"))
        set_monitor_scope(db, "a", "leg")
        assert find_monitor(db, "a")["scope"] == "leg"
        set_monitor_scope(db, "a", None)
        assert find_monitor(db, "a")["scope"] is None


class TestOrphans:
    def test_are_the_rules_with_no_link_at_all(self, db):
        insert_position(db, held("p1", "dec-condor"))
        insert_monitor(db, rule("linked", "US.SPXW261218C8100000"))
        insert_monitor(db, rule("orphan", "US.SPXW261218C8200000", strike=8200))
        link_monitor_to_positions(db, "linked", ["p1"])
        assert [m["id"] for m in orphan_monitors(db)] == ["orphan"]

    def test_lose_their_scope_and_a_rule_with_a_holding_keeps_its_own(self, db):
        # scope says HOW a rule covers its holding, so it means nothing without one — and only the
        # link-less are touched, or this would wipe the scope of every rule
        insert_position(db, held("p1", "dec-condor"))
        insert_monitor(db, rule("linked", "US.SPXW261218C8100000", scope="leg"))
        insert_monitor(db, rule("orphan", "US.SPXW261218C8200000", strike=8200, scope="leg"))
        link_monitor_to_positions(db, "linked", ["p1"])
        clear_scope_of_orphans(db)
        assert find_monitor(db, "linked")["scope"] == "leg"
        assert find_monitor(db, "orphan")["scope"] is None
