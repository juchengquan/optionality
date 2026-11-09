"""Recording a credit taken in across everything a rule spans. Port of backend/src/monitors.test.ts.

These seed their positions directly, as the TypeScript's do, because what is under test is the
arithmetic of deriving the one wing that cannot be edited, not the creation route.

`watchlist_quotes` is held by `test_watchlist.py`, as the TypeScript holds it by `watchlist.test.ts`.
`link_to_positions` and `adopt_orphan_monitors` are held in the TypeScript by their callers' suites —
`routes/monitors.test.ts`'s "the links to positions" (POST /monitors, ported beside this) and
`routes/positions.test.ts`'s adoption tests (POST and DELETE /positions, not ported yet) — so what
those rely on is held here too, at the end, until the second arrives.
"""

import pytest

from optionality_backend.db.open import create_database
from optionality_backend.db.values import to_sqlite_json
from optionality_backend.monitors import adopt_orphan_monitors, apply_total_entry, link_to_positions

EXPIRY = "2026-12-18"
CALLS = "c" * 32
PUTS = "p" * 32
WING = "w" * 32
SPAN = "s" * 32


@pytest.fixture
def db(tmp_path):
    d = create_database(tmp_path / "test.db")
    yield d
    d.close()


def position(db, id_, name, entry, legs):
    db.execute(
        """insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
         values (?, ?, 'credit_spread', ?, 1, ?, ?, '2026-08-01 00:00:00.000000')""",
        (id_, name, EXPIRY, entry, to_sqlite_json(legs)),
    )
    return id_


def rule(db, id_, code, scope, position_ids, legs=None):
    db.execute(
        """insert into monitors (id, code, strike_date, option_type, strike, field, threshold,
           direction, compare, legs, scope, enabled, triggered, created_at)
         values (?, ?, ?, 'CMB', 0, 'mid_price', 9.0, 'above', 'abs', ?, ?, 1, 0,
           '2026-08-01 00:00:00.000000')""",
        (id_, code, EXPIRY, to_sqlite_json(legs or [{"sign": -1, "option_type": "CALL", "strike": 8050}]), scope),
    )
    for pid in position_ids:
        db.execute("insert into monitor_positions values (?, ?)", (id_, pid))
    return id_


def spanning(db, calls_entry=2.87, puts_entry=None):
    """A condor: two spreads, one rule over the calls alone, and one spanning both (ADR 0004)."""
    position(
        db,
        CALLS,
        "calls",
        calls_entry,
        [
            {"side": "short", "option_type": "CALL", "strike": 8050},
            {"side": "long", "option_type": "CALL", "strike": 8075},
        ],
    )
    position(
        db,
        PUTS,
        "puts",
        puts_entry,
        [
            {"side": "short", "option_type": "PUT", "strike": 7100},
            {"side": "long", "option_type": "PUT", "strike": 7075},
        ],
    )
    rule(db, WING, "calls_rule", "all", [CALLS])
    rule(db, SPAN, "span_rule", "all", [CALLS, PUTS])


def entry_of(db, id_):
    return db.execute("select entry from positions where id = ?", (id_,)).fetchone()[0]


class TestDerivingTheUnreachableWing:
    async def test_writes_the_difference_into_the_wing_with_no_rule_of_its_own(self, db):
        spanning(db)
        assert await apply_total_entry(db, SPAN, 3.21) is None
        # 3.21 less the 2.87 already recorded
        assert entry_of(db, PUTS) == pytest.approx(0.34, abs=1e-10)
        # the wing you can edit directly is untouched: the per-wing credits stay the single source of
        # truth, and the total is a way of REACHING them rather than a second place to keep them
        assert entry_of(db, CALLS) == 2.87

    async def test_rounds_to_four_places_to_keep_float_noise_out_of_a_figure_the_owner_reads_back(self, db):
        spanning(db, 2.87)
        await apply_total_entry(db, SPAN, 3.2)
        assert entry_of(db, PUTS) == 0.33

    async def test_refuses_when_every_wing_already_has_a_rule_of_its_own(self, db):
        # nothing is left to derive, and overwriting a directly-editable wing would be a surprise
        spanning(db)
        rule(db, "q" * 32, "puts_rule", "all", [PUTS])
        assert (
            await apply_total_entry(db, SPAN, 3.21) == "every wing here has a rule of its own — set them individually"
        )

    async def test_refuses_when_more_than_one_wing_is_unreachable(self, db):
        # one equation, two unknowns
        position(db, CALLS, "calls", 2.87, [])
        position(db, PUTS, "puts", 1.0, [])
        position(db, "x" * 32, "third", 1.0, [])
        rule(db, SPAN, "span_rule", "all", [CALLS, PUTS, "x" * 32])
        assert (
            await apply_total_entry(db, SPAN, 3.21)
            == "cannot split a total across 3 wings that have no rule of their own"
        )

    async def test_refuses_when_another_wing_s_credit_is_not_recorded_yet(self, db):
        # two unknowns and one equation cannot be solved, so it says so rather than guessing
        spanning(db, None)
        assert await apply_total_entry(db, SPAN, 3.21) == "set the other wings' credits first"
        assert entry_of(db, PUTS) is None

    async def test_refuses_for_a_rule_with_no_holdings_attached(self, db):
        rule(db, SPAN, "lonely", None, [])
        assert await apply_total_entry(db, SPAN, 3.21) == "no holdings attached to this rule"

    async def test_writes_nothing_at_all_when_it_refuses(self, db):
        spanning(db, None)
        await apply_total_entry(db, SPAN, 3.21)
        assert entry_of(db, CALLS) is None
        assert entry_of(db, PUTS) is None


class TestWhichWingsCountAsDirectlyEditable:
    async def test_is_only_those_a_whole_position_rule_watches_alone(self, db):
        # a leg rule links to one Position too but offers no field, so counting it would wrongly mark
        # that Position reachable — and then nothing would be left to derive
        spanning(db)
        db.execute("update monitors set scope = 'leg' where id = ?", (WING,))
        # with the calls wing no longer directly editable, two wings are unreachable
        assert (
            await apply_total_entry(db, SPAN, 3.21)
            == "cannot split a total across 2 wings that have no rule of their own"
        )


class TestACreditThatCannotBeDerived:
    async def test_does_not_write_a_wrong_figure_when_another_wing_s_credit_is_missing(self, db):
        # one equation and two unknowns. Writing total − 0 would record a credit that was never taken.
        spanning(db, None)
        before = entry_of(db, PUTS)
        assert "first" in await apply_total_entry(db, SPAN, 3.21)
        assert entry_of(db, PUTS) == before


def links(db, monitor_id):
    """Which holdings a rule is linked to, and the scope it says it covers them with."""
    linked = [
        r[0]
        for r in db.execute("select position_id from monitor_positions where monitor_id = ? order by 1", (monitor_id,))
    ]
    return linked, db.execute("select scope from monitors where id = ?", (monitor_id,)).fetchone()[0]


SPREAD = [
    {"side": "short", "option_type": "CALL", "strike": 8050},
    {"side": "long", "option_type": "CALL", "strike": 8075},
]
C8050 = "US.SPXW261218C8050000"
C8075 = "US.SPXW261218C8075000"


class TestWhatTheLinkingCallersRelyOn:
    """`link_to_positions`, which creating a monitor runs, and `adopt_orphan_monitors`, which recording
    or deleting a holding runs: a rule is linked to what holds its contracts, whichever came first."""

    def test_links_a_rule_to_the_one_holding_of_its_contracts_covering_it_whole(self, db):
        position(db, CALLS, "calls", 2.87, SPREAD)
        rule(db, WING, "calls_rule", None, [])
        link_to_positions(db, WING, [C8050, C8075])
        assert links(db, WING) == ([CALLS], "all")

    def test_links_a_rule_watching_part_of_a_holding_as_a_leg(self, db):
        position(db, CALLS, "calls", 2.87, SPREAD)
        rule(db, WING, "calls_rule", None, [])
        link_to_positions(db, WING, [C8050])
        assert links(db, WING) == ([CALLS], "leg")

    def test_links_nothing_and_writes_no_scope_when_nothing_holds_the_contracts(self, db):
        rule(db, WING, "calls_rule", None, [])
        link_to_positions(db, WING, [C8050])
        assert links(db, WING) == ([], None)

    def test_adopts_a_rule_set_before_the_holding_was_recorded(self, db):
        # the order a create could not handle: the alarm first, the holding after
        rule(
            db,
            WING,
            "calls_rule",
            None,
            [],
            legs=[
                {"sign": -1, "option_type": "CALL", "strike": 8050},
                {"sign": 1, "option_type": "CALL", "strike": 8075},
            ],
        )
        position(db, CALLS, "calls", 2.87, SPREAD)
        adopt_orphan_monitors(db)
        assert links(db, WING) == ([CALLS], "all")

    def test_never_moves_a_rule_that_already_has_a_link(self, db):
        # what you already have cannot be taken away by something you subsequently hold
        position(db, CALLS, "calls", 2.87, SPREAD)
        rule(db, WING, "calls_rule", "leg", [CALLS])
        position(db, PUTS, "other", 1.0, [{"side": "short", "option_type": "CALL", "strike": 8050}])
        adopt_orphan_monitors(db)
        assert links(db, WING) == ([CALLS], "leg")

    def test_leaves_an_orphan_alone_when_its_contract_is_held_twice(self, db):
        # ambiguous, and a wrong P&L is worse than an absent one
        position(db, CALLS, "old", 2.87, SPREAD)
        position(db, PUTS, "new", 1.0, SPREAD)
        rule(db, WING, "calls_rule", None, [])
        adopt_orphan_monitors(db)
        assert links(db, WING) == ([], None)
