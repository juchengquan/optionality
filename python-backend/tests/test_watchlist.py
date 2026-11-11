"""The watchlist entries the dashboard and the bot render. Port of backend/src/watchlist.test.ts, which
drives them through `monitors.watchlist_quotes`, as this does: the entries are built from what that
one call fetched, and the suite is about the two agreeing.

What only the Python can get wrong is at the end.
"""

import math
from datetime import UTC, datetime

import pytest
from harness import fake_fetcher, quoting
from optionality.contract import build_spx_code
from optionality.exit import ExitPolicy
from optionality.quote import Batch

from optionality_backend.db.open import create_database
from optionality_backend.db.values import to_sqlite_json
from optionality_backend.monitors import watchlist_quotes

TZ = "Asia/Singapore"
NOW = datetime(2026, 8, 10, 3, 35, 32, tzinfo=UTC)
EXPIRY = "2026-12-18"
CODE = build_spx_code(EXPIRY, "CALL", 6500)
POISON = build_spx_code(EXPIRY, "CALL", 99999)
LEG_A = build_spx_code(EXPIRY, "CALL", 8100)
LEG_B = build_spx_code(EXPIRY, "CALL", 8150)

#: the shipped defaults, so these tests and `.env.example` cannot drift apart
POLICY = ExitPolicy(take_fraction=0.5, stop_multiple=2, manage_by_dte=21)


@pytest.fixture
def db(tmp_path):
    d = create_database(tmp_path / "test.db")
    yield d
    d.close()


@pytest.fixture
def monitor(db):
    made = [0]

    def monitor(**over) -> str:
        made[0] += 1
        row = {
            "id": f"m{made[0]}".ljust(32, "0"),
            "code": CODE,
            "strike_date": EXPIRY,
            "option_type": "CALL",
            "strike": 6500,
            "field": "option_delta",
            "threshold": 0.6,
            "legs": None,
            "enabled": 1,
            **over,
        }
        db.execute(
            """insert into monitors (id, code, strike_date, option_type, strike, field, threshold,
               direction, compare, legs, enabled, triggered, created_at)
             values (?, ?, ?, ?, ?, ?, ?, 'above', 'abs', ?, ?, 0, '2026-08-01 00:00:00.000000')""",
            (
                row["id"],
                row["code"],
                row["strike_date"],
                row["option_type"],
                row["strike"],
                row["field"],
                row["threshold"],
                None if row["legs"] is None else to_sqlite_json(row["legs"]),
                row["enabled"],
            ),
        )
        return row["id"]

    return monitor


@pytest.fixture
def combo(monitor):
    def combo(**over) -> str:
        return monitor(
            **{
                "code": "sep-condor",
                "option_type": "CMB",
                "strike": 0,
                "field": "mid_price",
                "threshold": 10,
                "legs": [
                    {"sign": 1, "option_type": "CALL", "strike": 8100},
                    {"sign": -1, "option_type": "CALL", "strike": 8150},
                ],
                **over,
            }
        )

    return combo


@pytest.fixture
def run(db):
    async def run(fetch, include_combos=False):
        return await watchlist_quotes(
            db, TZ, fake_fetcher(fetch), include_combos=include_combos, now=NOW, policy=POLICY
        )

    return run


def records(answer):
    """A FakeProvider answering with records alone."""

    async def fetch(codes):
        return answer(codes)

    return fetch


def position(db, id_, name, entry, legs, *, strategy="credit_spread", opened_at=None):
    db.execute(
        """insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at, opened_at)
         values (?, ?, ?, ?, 1, ?, ?, '2026-08-01 00:00:00.000000', ?)""",
        (id_, name, strategy, EXPIRY, entry, to_sqlite_json(legs), opened_at),
    )
    return id_


def link(db, monitor_id, position_id, scope=None):
    db.execute("insert into monitor_positions values (?, ?)", (monitor_id, position_id))
    if scope is not None:
        db.execute("update monitors set scope = ? where id = ?", (scope, monitor_id))


SPREAD = [
    {"side": "short", "option_type": "CALL", "strike": 8100},
    {"side": "long", "option_type": "CALL", "strike": 8150},
]


class TestWhichMonitorsAppear:
    async def test_leaves_combos_out_of_the_single_leg_tables(self, monitor, combo, run):
        # the bot's tables are ~40 monospace characters and four columns; a signed sum does not fit
        monitor()
        combo()
        quotes = await run(quoting({CODE: {"option_delta": 0.1}}))
        assert [q["code"] for q in quotes] == [CODE]

    async def test_makes_no_call_at_all_when_nothing_is_enabled(self, run):
        calls = [0]

        async def counting(codes):
            calls[0] += 1
            return [{"code": c} for c in codes]

        assert await run(counting) == []
        assert calls[0] == 0

    async def test_excludes_a_disabled_monitor(self, monitor, run):
        monitor(enabled=0)
        assert await run(quoting({})) == []

    async def test_groups_by_expiry_then_calls_before_puts(self, monitor, run):
        near = "2026-10-16"
        far = "2026-11-20"
        monitor(code="P-NEAR", option_type="PUT", strike_date=near)
        monitor(code="C-FAR", option_type="CALL", strike_date=far)
        monitor(code="C-NEAR", option_type="CALL", strike_date=near)
        quotes = await run(quoting({}))
        assert [q["code"] for q in quotes] == ["C-NEAR", "P-NEAR", "C-FAR"]


class TestASingleLegEntry:
    async def test_merges_the_monitor_s_own_fields_with_the_contract_s_snapshot(self, monitor, run):
        monitor()
        quotes = await run(quoting({CODE: {"name": "SPXW TEST", "option_delta": 0.91, "bid_price": 1365.6}}))
        assert len(quotes) == 1
        assert quotes[0]["code"] == CODE
        assert quotes[0]["threshold"] == 0.6
        assert quotes[0]["quote"]["option_delta"] == 0.91
        # the call-time stamp: the honest "data as-of"
        assert quotes[0]["quote"]["fetched_at"] == "2026-08-10 11:35:32+08:00"

    async def test_converts_the_market_timestamp_to_the_display_zone(self, monitor, run):
        monitor()
        quotes = await run(quoting({CODE: {"update_time": "2026-08-09 20:15:00", "option_delta": 0.1}}))
        assert quotes[0]["quote"]["update_time"] == "2026-08-10 08:15:00+08:00"

    async def test_carries_how_long_the_contract_has_left(self, monitor, run):
        monitor()
        quotes = await run(quoting({}))
        # from the market date, not the display zone: 2026-08-09 in New York at this instant
        assert quotes[0]["dte"] == 131

    async def test_fills_toward_the_threshold_from_the_watched_field(self, monitor, run):
        monitor(threshold=0.6)
        quotes = await run(quoting({CODE: {"option_delta": 0.3}}))
        assert quotes[0]["fill"] == 50


class TestAComboEntry:
    async def test_carries_its_signed_sum_and_no_per_contract_snapshot_in_one_call(self, monitor, combo, run):
        monitor()
        combo()
        calls = []
        prices = {CODE: 26.4, LEG_A: 26.4, LEG_B: 19.25}

        async def fetch(codes):
            calls.append(codes)
            return [{"code": c, "mid_price": prices[c], "option_delta": 0.1} for c in codes if c in prices]

        quotes = await run(fetch, True)
        # still ONE snapshot call for the single legs and the combo's legs together
        assert len(calls) == 1
        c = next(q for q in quotes if q["code"] == "sep-condor")
        assert c["combo_value"] == pytest.approx(7.15, abs=1e-10)  # 26.4 - 19.25
        assert c["quote"] is None
        assert next(q for q in quotes if q["code"] == CODE)["quote"]["mid_price"] == 26.4

    async def test_reports_greeks_as_signed_sums_never_an_iv_and_nothing_where_a_leg_is_missing(self, combo, run):
        combo()
        legs = {
            LEG_A: {"option_delta": 0.166, "option_gamma": 0.0002, "option_theta": -1.1},
            LEG_B: {"option_delta": 0.129, "option_gamma": 0.0001, "option_theta": -0.95},
        }
        fetch = records(
            lambda codes: [
                {"code": c, "mid_price": 1.0, "option_implied_volatility": 22.0, **legs.get(c, {})} for c in codes
            ]
        )
        greeks = (await run(fetch, True))[0]["combo_greeks"]
        assert greeks["option_delta"] == pytest.approx(0.037, abs=1e-10)  # +0.166 − 0.129: the delta OF the value
        assert greeks["option_gamma"] == pytest.approx(0.0001, abs=1e-10)
        assert greeks["option_theta"] == pytest.approx(-0.15, abs=1e-10)
        assert "option_implied_volatility" not in greeks  # IVs do not add
        assert greeks["option_vega"] is None  # absent on the legs: null, never a partial sum

    async def test_never_sums_implied_volatility_even_for_a_row_that_predates_the_rule(self, combo, run):
        # both legs report 20.0; the old behaviour returned 40.0
        combo(code="legacy-iv", field="option_implied_volatility")
        fetch = records(lambda codes: [{"code": c, "option_implied_volatility": 20.0} for c in codes])
        quotes = await run(fetch, True)
        assert quotes[0]["combo_value"] is None


class TestAnUnknownContract:
    async def test_marks_the_poisoned_entry_and_leaves_the_rest_priced(self, monitor, run):
        monitor()
        monitor(code=POISON, strike=99999)

        async def fetch(codes):
            return Batch(
                records=[{"code": c, "option_delta": 0.7} for c in codes if c != POISON],
                unknown=[c for c in codes if c == POISON],
            )

        quotes = await run(fetch, True)
        assert next(q for q in quotes if q["code"] == CODE)["quote"]["option_delta"] == 0.7
        poisoned = next(q for q in quotes if q["code"] == POISON)
        assert poisoned["quote"] is None
        assert poisoned["error"] == "unknown contract"


#: sold back at 1.20, returned at 0.40: 0.80 to close the spread
SPREAD_PRICES = {
    LEG_A: {"mid_price": 1.2, "option_contract_size": 100},
    LEG_B: {"mid_price": 0.4, "option_contract_size": 100},
}


class TestTheHoldingsARuleWatches:
    PID = "p" * 32

    async def test_reports_cost_to_close_entry_and_p_l_for_a_rule_covering_whole_positions(self, db, combo, run):
        position(db, self.PID, "spread", 2.5, SPREAD)
        link(db, combo(), self.PID, "all")

        entry = (await run(quoting(SPREAD_PRICES), True))[0]
        assert entry["positions"] == [{"id": self.PID, "name": "spread"}]
        assert entry["cost_to_close"] == pytest.approx(0.8, abs=1e-10)  # 1.2 sold back − 0.4 returned
        assert entry["entry"] == 2.5
        assert entry["pnl"] == 170  # (2.5 − 0.8) × 1 × 100

    async def test_measures_a_position_backed_rule_on_its_cost_to_close_always_above_and_absolute(self, db, combo, run):
        # cost to close cannot be negative, so the comparison ignores the rule's own mode — matching
        # what the dashboard has shown since the sign reconciliation
        position(db, self.PID, "spread", 2.5, SPREAD)
        link(db, combo(threshold=1.6), self.PID, "all")
        quotes = await run(quoting(SPREAD_PRICES), True)
        # 0.8 of a 1.6 threshold, counted upward even though the rule says direction "above"/"abs"
        assert quotes[0]["fill"] == 50

    async def test_offers_no_entry_or_p_l_for_a_rule_watching_only_part_of_a_structure(self, db, monitor, run):
        # a leg rule's P&L would be a fraction of someone else's credit
        position(db, self.PID, "spread", 2.5, SPREAD)
        link(db, monitor(code=LEG_A, strike=8100, field="mid_price", threshold=2), self.PID, "leg")
        quotes = await run(quoting(SPREAD_PRICES))
        assert quotes[0]["scope"] == "leg"
        assert quotes[0]["entry"] is None
        assert quotes[0]["pnl"] is None
        # and no cost to close either. A Monitor watches CONTRACTS, never a Position (CONTEXT.md): the
        # holding is found afterwards so the row can show what you took in, which does not make a row
        # about one option into a row about the condor it happens to sit inside. This used to report
        # 0.8 — the whole spread's — which is the figure that made the model look muddled. Nothing is
        # lost: it is still on the holding's own row, where it means something.
        assert quotes[0]["cost_to_close"] is None

    async def test_fetches_the_position_s_other_legs_even_when_no_monitor_names_them(self, db, monitor):
        # without them the cost to close would be a partial sum
        position(db, self.PID, "spread", 2.5, SPREAD)
        link(db, monitor(code=LEG_A, strike=8100, field="mid_price", threshold=2), self.PID, "leg")
        asked = []

        async def fetch(codes):
            asked.append(codes)
            return [{"code": c} for c in codes]

        await watchlist_quotes(db, TZ, fake_fetcher(fetch), now=NOW, policy=POLICY)
        assert asked[0] == sorted([LEG_A, LEG_B])


class TestGuardsThatAreEasyToLose:
    async def test_gives_a_combo_no_per_contract_snapshot_even_if_its_name_matches_a_quoted_code(self, combo, run):
        # Contrived — a combo's code is a name the trader chose, so it normally cannot collide with a
        # contract. The guard is still load-bearing: without it the check is `by_code[m.code]`, and the
        # only thing stopping a combo from presenting one contract's figures as its own is that the
        # lookup happens to miss. Combo figures are signed sums; a single leg's snapshot beside them
        # would read as the combo's.
        combo(code="sep-condor")
        fetch = records(
            lambda codes: [*({"code": c, "mid_price": 1} for c in codes), {"code": "sep-condor", "mid_price": 99}]
        )
        quotes = await run(fetch, True)
        assert quotes[0]["quote"] is None

    async def test_measures_a_position_backed_rule_under_the_rule_s_own_mode_bar_and_bell_together(
        self, db, combo, run
    ):
        # Was "counts a position-backed rule's fill upward even when the rule says below and signed":
        # the comparison was forced to above/abs because cost to close cannot be negative, and this
        # asserted 50%. The stated fear was an inverted bar calling a nearly-safe position nearly
        # breached.
        #
        # The rule's own verdict on 0.80 against "below 1.60, signed" is BREACHED — is_breached gives
        # 0.80 <= 1.60 — which is what a profit-taking alarm is for, and the sweep fires it. So the old
        # bar read "halfway there" beside no bell while Telegram had already sent: the drift ADR 0010
        # forbids, in the one case that asserted the bar and never the bell. The bar now follows the
        # rule it belongs to, and the bell with it.
        pid = "p" * 32
        position(db, pid, "spread", 2.5, SPREAD)
        mid = combo(threshold=1.6)
        db.execute("update monitors set direction = 'below', compare = 'signed' where id = ?", (mid,))
        link(db, mid, pid, "all")

        quotes = await run(quoting(SPREAD_PRICES), True)
        # 1.6/0.8 under the rule's own below/signed mode, capped at 100 — the target is met, not
        # half-met, which is the same thing the bell now says.
        assert quotes[0]["fill"] == 100
        assert quotes[0]["triggered"] is True, "0.80 is below 1.60: the sweep rings this"


class TestTheBellAndTheValueShareAnInstant:
    """The dashboard's figures come from THIS call, so its bell has to come from it too.

    It did not. The payload carried the sweeper's stored `triggered` column beside a value fetched a
    moment ago, so a row could show a figure past its threshold with no bell, or a bell beside a
    figure well inside it. The alarm ENGINE is untouched by this: what it has decided, when it last
    messaged, and its cooldowns are all still the sweep's business. This is only about the row
    agreeing with itself. See ADR 0010.
    """

    @staticmethod
    def set_engine_state(db, id_, triggered, last_value):
        db.execute("update monitors set triggered = ?, last_value = ? where id = ?", (triggered, last_value, id_))

    async def test_rings_on_a_breach_the_last_sweep_has_not_seen(self, db, monitor, run):
        id_ = monitor(threshold=0.6)
        self.set_engine_state(db, id_, 0, 0.1)  # the engine's record says calm; the market has moved since
        [entry] = await run(quoting({CODE: {"option_delta": 0.7}}))

        assert entry["quote"]["option_delta"] == 0.7
        assert entry["triggered"] is True, "the row shows 0.7 against a 0.6 threshold and no bell"

    async def test_falls_silent_once_the_value_is_back_inside_whatever_the_engine_still_holds(self, db, monitor, run):
        id_ = monitor(threshold=0.6)
        self.set_engine_state(db, id_, 1, 0.9)
        [entry] = await run(quoting({CODE: {"option_delta": 0.1}}))

        assert entry["triggered"] is False, "a bell beside a figure well inside the threshold"

    async def test_rings_at_the_threshold_exactly_with_no_band_around_it(self, monitor, run):
        # CLAUDE.md: the bell flips truthfully at the EXACT threshold — no value hysteresis
        monitor(threshold=0.6)
        at = await run(quoting({CODE: {"option_delta": 0.6}}))
        assert at[0]["triggered"] is True

        under = await run(quoting({CODE: {"option_delta": 0.5999999999}}))
        assert under[0]["triggered"] is False

    async def test_never_rings_on_a_row_it_could_not_price(self, db, monitor, run):
        # an unreadable value is not a calm one and not a breaching one. The row draws "—", and a bell
        # beside a dash would be the stored state leaking back in by another door.
        id_ = monitor(threshold=0.6)
        self.set_engine_state(db, id_, 1, 0.9)
        [entry] = await run(quoting({}))

        assert entry["quote"] is None
        assert entry["triggered"] is False
        assert entry["fill"] is None

    async def test_measures_a_position_backed_combo_on_the_same_cost_to_close_its_fill_bar_uses(self, db, combo, run):
        mid = combo(threshold=3)
        pid = "p1".ljust(32, "0")
        position(db, pid, "spread", 2.0, SPREAD, strategy=None)
        link(db, mid, pid)
        db.execute("update monitors set scope = 'all', triggered = 0 where id = ?", (mid,))

        # sold at 5.00, bought at 1.00: 4.00 to close, past a 3.00 stop
        [entry] = await run(quoting({LEG_A: {"mid_price": 5.0}, LEG_B: {"mid_price": 1.0}}), True)
        assert entry["cost_to_close"] == 4
        assert entry["triggered"] is True

    async def test_rings_only_on_rows_whose_fill_bar_is_full_since_both_read_one_figure(self, monitor, run):
        # the bar and the bell are the same claim drawn twice; they must not be able to disagree. Only
        # this direction is asserted: fill rounds, so 0.599 draws a full-looking bar at 99.83% without
        # breaching, and that is the bar being imprecise rather than the bell being wrong.
        monitor(threshold=0.6)
        checked = 0
        for delta in [0.1, 0.3, 0.5, 0.59, 0.6, 0.61, 0.9, 2]:
            [entry] = await run(quoting({CODE: {"option_delta": delta}}))
            if entry["triggered"]:
                assert entry["fill"] == 100, f"delta {delta} rings with a fill of {entry['fill']}"
            checked += 1
        assert checked == 8


class TestTheExitScheduleOnAWatchlistEntry:
    """It rides on THIS payload rather than being fetched beside it, so `pace_gap` is the gap against
    the very Cost to close the row shows. Joining /positions/values on the dashboard would compute it
    against a different fetch's figure and put the row back to describing two instants, which is the
    thing ADR 0010 settled."""

    @staticmethod
    def declare(db, position_id, opened_at):
        db.execute("update positions set opened_at = ? where id = ?", (opened_at, position_id))

    @staticmethod
    def spread_of(mid):
        return quoting({k: {"mid_price": v} for k, v in mid.items()})

    @staticmethod
    def held_combo(db, combo, entry):
        mid = combo(threshold=3)
        pid = "p1".ljust(32, "0")
        position(db, pid, "spread", entry, SPREAD, strategy=None)
        link(db, mid, pid, "all")
        return mid, pid

    async def test_is_null_until_the_position_s_opened_is_declared(self, db, combo, run):
        self.held_combo(db, combo, 2.0)
        [e] = await run(self.spread_of({LEG_A: 5.0, LEG_B: 1.0}), True)
        assert e["schedule"] is None

    async def test_names_the_holding_it_is_for_so_no_client_has_to_infer_it_from_positions(self, db, combo, run):
        # The detail sheet fetches this holding's own vol history by that id. `positions[0]` is the
        # same Position today, because a schedule needs scope "all" and exactly one holding — but a
        # client relying on that would follow the next change to either condition onto the wrong trade
        # in silence. A mutation sweep found nothing could tell a wrong id from the right one.
        _, pid = self.held_combo(db, combo, 2.0)
        self.declare(db, pid, "2026-07-11")
        [e] = await run(self.spread_of({LEG_A: 5.0, LEG_B: 1.0}), True)
        assert e["schedule"]["position_id"] == pid

    async def test_rides_on_the_same_payload_as_the_value_so_the_gap_is_against_that_cost(self, db, combo, run):
        _, pid = self.held_combo(db, combo, 2.0)
        # Opened long before NOW, because an Opened in the future reads as unknown by design.
        self.declare(db, pid, "2026-07-11")
        [e] = await run(self.spread_of({LEG_A: 5.0, LEG_B: 1.0}), True)
        s = e["schedule"]

        assert e["cost_to_close"] == 4
        assert s["dte_at_open"] == 160
        # taken from the entry rather than written out: NOW is 03:35 UTC, which is still the previous
        # evening in New York, so `dte` is 131 and not the 132 the calendar date suggests. Hardcoding it
        # is how this test first failed, and `dte` being market-reckoned is the whole point of it.
        assert e["dte"] == 131
        assert s["on_pace"] == pytest.approx(2.0 * math.sqrt(e["dte"] / 160), abs=1e-6)
        # the gap is computed from the cost in THIS entry, not from another fetch
        assert s["pace_gap"] == pytest.approx(4 - s["on_pace"], abs=1e-6)
        assert s["target"] == pytest.approx(1.0, abs=1e-6)
        assert s["stop"] == pytest.approx(4.0, abs=1e-6)
        assert s["manage_by_dte"] == 21

    async def test_is_null_for_a_rule_that_only_watches_part_of_a_holding(self, db, combo, run):
        # scope 'leg' means the rule covers a fraction of someone else's credit, and a schedule built
        # on it would be a schedule for a trade nobody put on
        mid, pid = self.held_combo(db, combo, 2.0)
        self.declare(db, pid, "2026-07-11")
        db.execute("update monitors set scope = 'leg' where id = ?", (mid,))
        [e] = await run(self.spread_of({LEG_A: 5.0, LEG_B: 1.0}), True)
        assert e["schedule"] is None

    async def test_is_null_for_a_rule_spanning_two_positions_which_have_no_single_opened(self, db, combo, run):
        # two Positions put on different days have no one DTE at entry, and a blended pace line would
        # hide that rather than say it. ADR 0004 allows the span; this declines to guess.
        mid, pid = self.held_combo(db, combo, 2.0)
        self.declare(db, pid, "2026-07-11")
        other = "p2".ljust(32, "0")
        position(
            db,
            other,
            "other",
            1.0,
            [{"side": "short", "option_type": "PUT", "strike": 7100}],
            strategy=None,
            opened_at="2026-08-01",
        )
        link(db, mid, other)

        [e] = await run(self.spread_of({LEG_A: 5.0, LEG_B: 1.0}), True)
        assert len(e["positions"]) == 2
        assert e["schedule"] is None


class TestARuleThatWatchesOnlyPartOfAHolding:
    """It reports the WHOLE holding's Cost to close, and that is deliberate.

    It reads oddly — a row about one leg of a condor showing 6.40, the condor's cost — and I set out
    to "fix" it before finding the intent written down in two places: the watchlist fetches a
    Position's other legs even when no Monitor names them, "without them the cost to close would be a
    partial sum", and the sweep widens its batch for the same reason. The other legs are fetched
    PRECISELY so this figure can be whole.

    So the question a leg rule answers is "what would it cost to buy back the thing this leg belongs
    to", which is the number you act on when a short strike starts moving. Entry and P&L are still
    withheld, because those would be a fraction of someone else's credit — the asymmetry is the
    point, and nothing said so until now.
    """

    @staticmethod
    def condor_position(db):
        return position(db, "p9".ljust(32, "0"), "condor", 6.86, SPREAD, strategy="iron_condor")

    async def test_reports_no_holding_cost_on_a_row_about_one_contract(self, db, monitor, run):
        mid = monitor(strike=8100, code=LEG_A, field="option_delta", threshold=0.18)
        link(db, mid, self.condor_position(db), "leg")

        [e] = await run(
            quoting(
                {
                    LEG_A: {"mid_price": 5.0, "option_delta": 0.11, "option_contract_size": 100},
                    LEG_B: {"mid_price": 1.0, "option_delta": 0.05, "option_contract_size": 100},
                }
            )
        )
        assert e["scope"] == "leg"
        # the row shows the CONTRACT's own figures — its mid is 5.00 — and nothing about the spread it
        # sits inside. The spread's 4.00 belongs on the spread's row.
        assert e["quote"]["mid_price"] == 5
        assert e["cost_to_close"] is None
        assert e["entry"] is None
        assert e["pnl"] is None

    async def test_does_report_it_when_that_one_contract_is_the_whole_holding(self, db, monitor, run):
        # a lone held option is a Position too, and then the Contract and the holding are the same thing
        # — so all three figures appear. Found by a mutation sweep: nothing covered this case, so
        # removing the scope check broke nothing.
        pid = position(
            db,
            "p8".ljust(32, "0"),
            "lone call",
            5.0,
            [{"side": "short", "option_type": "CALL", "strike": 8100}],
            strategy=None,
        )
        mid = monitor(strike=8100, code=LEG_A, field="option_delta", threshold=0.18)
        link(db, mid, pid, "all")

        [e] = await run(quoting({LEG_A: {"mid_price": 3.0, "option_delta": 0.11, "option_contract_size": 100}}))
        assert e["scope"] == "all"
        assert e["cost_to_close"] == 3
        assert e["entry"] == 5
        assert e["pnl"] == 200

    async def test_alarms_on_its_own_field_regardless_so_the_whole_holding_cost_cannot_mislead_it(
        self, db, monitor, run
    ):
        # the figure is informational on a single-leg row: the rule compares option_delta, so a 4.00
        # cost to close beside it can never move the bell
        mid = monitor(strike=8100, code=LEG_A, field="option_delta", threshold=0.18)
        link(db, mid, self.condor_position(db), "leg")

        [calm] = await run(
            quoting({LEG_A: {"mid_price": 5.0, "option_delta": 0.11}, LEG_B: {"mid_price": 1.0, "option_delta": 0.05}})
        )
        assert calm["triggered"] is False, "a delta of 0.11 against 0.18 must not ring"

        [ringing] = await run(
            quoting({LEG_A: {"mid_price": 5.0, "option_delta": 0.19}, LEG_B: {"mid_price": 1.0, "option_delta": 0.05}})
        )
        assert ringing["triggered"] is True


PUT_A = build_spx_code(EXPIRY, "PUT", 7100)
PUT_B = build_spx_code(EXPIRY, "PUT", 7050)

#: sold 8100 at 5.00 / bought 8150 at 1.00  -> the call side costs 4.00 to buy back
#: sold 7100 at 3.00 / bought 7050 at 1.00  -> the put side costs 2.00
#: so the whole condor costs 6.00
CONDOR_PRICES = {
    LEG_A: {"mid_price": 5.0, "option_delta": 0.30, "option_contract_size": 100},
    LEG_B: {"mid_price": 1.0, "option_delta": 0.20, "option_contract_size": 100},
    PUT_A: {"mid_price": 3.0, "option_delta": -0.25, "option_contract_size": 100},
    PUT_B: {"mid_price": 1.0, "option_delta": -0.15, "option_contract_size": 100},
}


class TestAComboThatCoversOnlyPartOfAHolding:
    """It is measured on the cost of buying back the Contracts IT names, not the holding's.

    An alarm written about the call side of a condor was compared against the whole condor's cost:
    you named two options and it fired on four. The original choice is sound — a position-backed combo
    is measured on a buy-back cost because that is positive, and a combo's own signed sum is negative
    for a credit structure — it simply did not notice an alarm covering part of a holding. So the
    figure narrows to the alarm's own Contracts, which for an alarm covering the whole holding is the
    same number it always gave.

    Cost to close is widened to match (CONTEXT.md): what it costs to buy back the options in question,
    whether those are a Position's Legs or the Contracts a Monitor names.
    """

    @staticmethod
    def condor_held(db):
        """the whole condor, as ONE holding"""
        return position(
            db,
            "pc".ljust(32, "0"),
            "condor",
            6.86,
            [
                *SPREAD,
                {"side": "short", "option_type": "PUT", "strike": 7100},
                {"side": "long", "option_type": "PUT", "strike": 7050},
            ],
            strategy="iron_condor",
        )

    @staticmethod
    def call_side(combo, **over):
        """an alarm naming only the two calls — minus is short, per the canonical convention"""
        return combo(
            **{
                "code": "call-side",
                "legs": [
                    {"sign": -1, "option_type": "CALL", "strike": 8100},
                    {"sign": 1, "option_type": "CALL", "strike": 8150},
                ],
                **over,
            }
        )

    async def test_costs_what_its_contracts_cost_not_what_the_holding_costs(self, db, combo, run):
        link(db, self.call_side(combo, threshold=3), self.condor_held(db), "leg")

        [e] = await run(quoting(CONDOR_PRICES), True)
        assert e["scope"] == "leg"
        assert e["cost_to_close"] == 4, "it was reporting 6.00, the whole condor's"

    async def test_alarms_on_its_own_cost_so_a_threshold_means_what_it_says(self, db, combo, run):
        # 4.00 for the call side against a 5.00 threshold: calm. Measured on the condor's 6.00 it would
        # have been breached, which is the fault in one assertion.
        link(db, self.call_side(combo, threshold=5), self.condor_held(db), "leg")

        [e] = await run(quoting(CONDOR_PRICES), True)
        assert e["cost_to_close"] == 4
        assert e["triggered"] is False, "the condor's 6.00 would have rung this"
        assert e["fill"] == 80

    async def test_uses_the_mid_to_cost_it_whatever_field_the_alarm_watches(self, db, combo, run):
        # the subtle one: a combo's own figure is the signed sum of ITS field, so an alarm on delta has a
        # delta sum, not a price. Negating that would have made the cost to close -(-0.10).
        link(db, self.call_side(combo, field="option_delta", threshold=0.5), self.condor_held(db), "leg")

        [e] = await run(quoting(CONDOR_PRICES), True)
        # -0.30 + 0.20 under its signs
        assert e["combo_value"] == pytest.approx(-0.1, abs=1e-10)
        # and the cost to close is still priced from the mids: 5.00 - 1.00
        assert e["cost_to_close"] == 4

    async def test_rings_what_the_engine_rings_whatever_field_a_held_combo_watches(self, db, combo, run):
        # The bell and the fill were measured on cost_to_close for ANY held combo — a price — with
        # direction and compare forced to above/abs, discarding the rule's own. So this delta rule rang
        # permanently off the condor's 4.00 while the sweep, comparing the delta sum through
        # monitor_value, stayed silent. ADR 0010: the bell "cannot drift from how an alarm is decided",
        # and the claim sat three lines under the code that broke it.
        #
        # The price cases above are unaffected: under compare 'abs' the sign washes out, so |-4.00| and
        # 4.00 give the same bell and the same 80% bar.
        link(db, self.call_side(combo, field="option_delta", threshold=0.5), self.condor_held(db), "leg")

        [e] = await run(quoting(CONDOR_PRICES), True)
        assert e["cost_to_close"] == 4, "the column is unchanged: still priced from the mids"
        assert e["combo_value"] == pytest.approx(-0.1, abs=1e-10)
        assert e["triggered"] is False, "0.10 of a 0.50 threshold is calm, and the sweep agrees"
        assert e["fill"] == 20, "|-0.10| / 0.50"

    async def test_gives_an_alarm_covering_the_whole_holding_the_same_number_as_before(self, db, combo, run):
        mid = combo(
            code="whole-condor",
            threshold=7,
            legs=[
                {"sign": -1, "option_type": "CALL", "strike": 8100},
                {"sign": 1, "option_type": "CALL", "strike": 8150},
                {"sign": -1, "option_type": "PUT", "strike": 7100},
                {"sign": 1, "option_type": "PUT", "strike": 7050},
            ],
        )
        link(db, mid, self.condor_held(db), "all")

        [e] = await run(quoting(CONDOR_PRICES), True)
        assert e["scope"] == "all"
        assert e["cost_to_close"] == 6
        assert e["entry"] == 6.86
        assert e["pnl"] is not None

    async def test_costs_the_same_whichever_leg_convention_the_alarm_was_written_in(self, db, combo, run):
        # The point of costing from the holding's sides. Two alarms naming the SAME two contracts, one
        # written "-1 on sold" (what the dashboard says) and one "+1 on sold" (what the schema said until
        # #97). Their own signed sums are exact opposites; what it costs to buy those two options back
        # is one number, because that is a fact about the holding and not about signs.
        pid = self.condor_held(db)
        canonical = self.call_side(combo, code="minus-short", threshold=9)
        inverted = combo(
            code="plus-short",
            threshold=9,
            legs=[
                {"sign": 1, "option_type": "CALL", "strike": 8100},
                {"sign": -1, "option_type": "CALL", "strike": 8150},
            ],
        )
        for mid in [canonical, inverted]:
            link(db, mid, pid, "leg")

        entries = await run(quoting(CONDOR_PRICES), True)
        a = next(e for e in entries if e["code"] == "minus-short")
        b = next(e for e in entries if e["code"] == "plus-short")

        assert a["combo_value"] == -4
        assert b["combo_value"] == 4
        assert a["cost_to_close"] == 4, "one fact about the holding"
        assert b["cost_to_close"] == 4, "and the same fact, written the other way round"

    async def test_still_offers_no_entry_or_p_l_for_the_part_which_would_be_a_fraction_of_a_credit(
        self, db, combo, run
    ):
        link(db, self.call_side(combo, threshold=3), self.condor_held(db), "leg")

        [e] = await run(quoting(CONDOR_PRICES), True)
        assert e["entry"] is None
        assert e["pnl"] is None
        assert e["schedule"] is None

    async def test_leaves_a_combo_you_do_not_hold_exactly_as_it_was(self, db, combo, run):
        # no holding, so no buy-back cost: the row shows its own signed sum and is measured on it under
        # its own direction and compare
        # the direction and compare are the TypeScript's inputs, which its row builder never writes:
        # the row is above and abs whatever they say, and nothing here depends on either
        self.call_side(combo, threshold=3, direction="below", compare="signed")
        [e] = await run(quoting(CONDOR_PRICES), True)
        assert e["cost_to_close"] is None
        # -1 x 5.00 + 1 x 1.00 under the canonical signs: its own figure is NEGATIVE for a credit
        # structure, which is exactly why a buy-back cost was introduced for the ones you hold
        assert e["combo_value"] == -4


class TestWhatKindOfContractARowIs:
    """The dashboard groups the watchlist by calls and puts, and a single-leg row carried nothing to
    group BY: only `code`, moomoo's `US.SPXW261130C8100000`. Parsing the broker's code string in the
    browser to decide what to draw is a derivation this service already owns — the column is NOT NULL
    on monitors, so saying it costs nothing and no extra OpenD call."""

    async def test_names_it_on_a_single_leg_row(self, monitor, run):
        monitor(option_type="PUT")
        [e] = await run(quoting({CODE: {"option_delta": 0.5}}))
        assert e["option_type"] == "PUT"

    async def test_says_what_the_monitors_table_says_for_a_combo_rather_than_inventing_a_kind(self, combo, run):
        # "CMB" is what a combo is stored as; the row also carries its legs, each with its own type, and
        # the dashboard groups a combo by THOSE — all-CALL, all-PUT or mixed. Passing the stored value
        # through keeps this route a report of the row rather than a second opinion about it.
        combo()
        [e] = await run(quoting({LEG_A: {"mid_price": 5.0}, LEG_B: {"mid_price": 1.0}}), True)
        assert e["option_type"] == "CMB"
        assert [leg.option_type for leg in e["legs"]] == ["CALL", "CALL"]


class TestWhatARowSSentenceReads:
    """The redesigned page writes each rule as a sentence — "spread value ≥ 6.01 — now 2.00, 4.01
    away" — and no figure in it is assembled in the browser (ADR 0005, ADR 0023). `watched` is the one
    reading the fill bar and the bell are drawn from and `distance` its room to the threshold, so the
    sentence, the bar and the bell are one figure said three ways and cannot disagree."""

    async def test_serves_the_figure_the_bar_and_the_bell_are_drawn_from_and_how_far_it_has_to_go(self, monitor, run):
        monitor(threshold=0.6)
        [e] = await run(quoting({CODE: {"option_delta": 0.45}}))
        assert e["watched"] == 0.45
        assert e["distance"] == pytest.approx(0.15, abs=1e-12)
        assert e["fill"] == 75
        assert e["triggered"] is False

    async def test_serves_a_combo_s_signed_sum_as_its_figure_and_a_breach_as_a_negative_distance(self, combo, run):
        combo(threshold=3)
        [e] = await run(quoting({LEG_A: {"mid_price": 5.0}, LEG_B: {"mid_price": 1.0}}), True)
        assert e["watched"] == 4
        assert e["watched"] == e["combo_value"]
        assert e["distance"] == -1, "a point past its threshold"
        assert e["triggered"] is True

    async def test_is_at_or_below_zero_exactly_when_the_row_rings_at_the_threshold_too(self, monitor, run):
        monitor(threshold=0.6)
        checked = 0
        for delta in [0.1, 0.59, 0.5999999999, 0.6, 0.6000000001, 0.61, -0.6, -0.7, 2]:
            [e] = await run(quoting({CODE: {"option_delta": delta}}))
            assert (e["distance"] <= 0) is e["triggered"], f"delta {delta} is {e['distance']} away"
            checked += 1
        assert checked == 9

    async def test_has_no_figure_and_no_distance_on_a_row_it_could_not_price(self, monitor, run):
        monitor(threshold=0.6)
        [e] = await run(quoting({}))
        assert e["watched"] is None
        assert e["distance"] is None

    async def test_serves_a_figure_sent_as_text_as_the_number_the_sweep_reads_it_as(self, monitor, run):
        # the sweep reads a single Contract through `monitor_value`, which is `Number(v)`; a figure the
        # Provider sent as "0.7" is served as 0.7, never as the text, which the reply schema refuses
        monitor(threshold=0.6)
        [e] = await run(quoting({CODE: {"option_delta": "0.7"}}))
        assert e["watched"] == 0.7
        assert e["triggered"] is True

    async def test_serves_no_figure_for_text_that_is_not_a_number_which_costs_the_figure_and_not_the_row(
        self, monitor, run
    ):
        # NaN is no reading: the bar and the bell already treated it as none, and a NaN in the reply
        # would fail its schema and take every other row of the watchlist down with it
        monitor(threshold=0.6)
        [e] = await run(quoting({CODE: {"option_delta": "n/a"}}))
        assert [e["watched"], e["distance"], e["fill"], e["triggered"]] == [None, None, None, False]

    async def test_serves_no_figure_for_an_infinite_reading_and_still_rings_and_fills_on_it_as_the_sweep_would(
        self, monitor, run
    ):
        # JSON has no Infinity, so in the reply it would fail the schema and take every row with it. The
        # bar and the bell are decided on it exactly as before — the sweep alarms on it too — so this row
        # rings with no figure to show, and a null distance says nothing either way
        monitor(field="option_open_interest", threshold=1000)
        for reading in [math.inf, "Infinity", -math.inf]:
            [e] = await run(quoting({CODE: {"option_open_interest": reading}}))
            assert [e["watched"], e["distance"], e["fill"], e["triggered"]] == [None, None, 100, True], reading


class TestWhetherARuleWatchesAnythingHeld:
    """The redesigned page tells a risk alarm on something owned from an entry signal on a candidate
    (ADR 0023), and `positions` cannot: the link declines to name a holding wherever naming one would be
    a guess, and "no link" then reads as "nothing held". `held` answers about CONTRACTS, from every open
    holding, linked or not."""

    @staticmethod
    def hold(db, name, strikes, closed_on=None):
        db.execute(
            """insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at,
                                      closed_on)
             values (?, ?, 'credit_spread', ?, 1, 1.0, ?, '2026-08-01 00:00:00.000000', ?)""",
            (
                name.ljust(32, "0"),
                name,
                EXPIRY,
                to_sqlite_json(
                    [
                        {"side": "short", "option_type": "CALL", "strike": strikes[0]},
                        {"side": "long", "option_type": "CALL", "strike": strikes[1]},
                    ]
                ),
                closed_on,
            ),
        )

    async def test_is_true_on_a_roll_day_when_two_holdings_share_the_contract_and_no_link_names_either(
        self, db, monitor, run
    ):
        self.hold(db, "old", (8100, 8150))
        self.hold(db, "new", (8100, 8200))
        monitor(code=LEG_A, strike=8100)
        [e] = await run(quoting({}))
        assert e["positions"] == [], "the link declines to guess"
        assert e["held"] is True, "but the Contract is held"

    async def test_is_true_for_a_combo_when_any_one_of_its_legs_is_held(self, db, combo, run):
        self.hold(db, "upper", (8150, 8200))
        combo()
        [e] = await run(quoting({}), True)
        assert e["held"] is True

    async def test_is_false_for_a_rule_on_contracts_nothing_holds(self, db, monitor, run):
        self.hold(db, "spread", (8100, 8150))
        monitor()
        [e] = await run(quoting({}))
        assert e["held"] is False

    async def test_counts_only_what_is_still_held_a_closed_holding_holds_nothing(self, db, monitor, run):
        self.hold(db, "closed", (8100, 8150), "2026-08-07")
        monitor(code=LEG_A, strike=8100)
        [e] = await run(quoting({}))
        assert e["held"] is False

    async def test_costs_a_holding_it_cannot_read_its_own_contracts_and_nothing_else_as_the_sweep_does(
        self, db, monitor, run
    ):
        self.hold(db, "spread", (8100, 8150))
        db.execute(
            """insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
             values (?, 'garbled', null, ?, 1, 1.0, '{not json', '2026-08-01 00:00:00.000000')""",
            ("g".ljust(32, "0"), EXPIRY),
        )
        monitor(code=LEG_A, strike=8100)
        monitor()
        entries = await run(quoting({}))
        assert {e["code"]: e["held"] for e in entries} == {LEG_A: True, CODE: False}


class TestTheSpreadsASingleContractIsALegOf:
    """On the redesigned page a single-Contract rule — a short leg's delta — sits under the spread it
    belongs to (ADR 0023). Which spread that is is DISCOVERED, from the legs every combo in this
    watchlist names, as a rule's holdings are: nothing records it."""

    LEG_C = build_spx_code(EXPIRY, "CALL", 8200)

    @staticmethod
    def id_(name: str) -> str:
        return name.ljust(32, "0")

    async def test_names_every_combo_whose_legs_include_this_row_s_contract_sorted(self, monitor, combo, run):
        leg = monitor(code=LEG_A, strike=8100)
        combo(id=self.id_("zz"), code="sep-calls")
        combo(
            id=self.id_("aa"),
            code="sep-wide",
            legs=[
                {"sign": 1, "option_type": "CALL", "strike": 8100},
                {"sign": -1, "option_type": "CALL", "strike": 8200},
            ],
        )
        # a spread that does not hold it
        combo(
            id=self.id_("mm"),
            code="sep-upper",
            legs=[
                {"sign": 1, "option_type": "CALL", "strike": 8150},
                {"sign": -1, "option_type": "CALL", "strike": 8200},
            ],
        )
        entries = await run(quoting({LEG_A: {"option_delta": 0.2}, self.LEG_C: {}}), True)
        assert next(e for e in entries if e["id"] == leg)["in_combos"] == [self.id_("aa"), self.id_("zz")]

    async def test_is_empty_for_a_contract_no_combo_holds_and_on_a_combo_s_own_row(self, monitor, combo, run):
        monitor()
        combo()
        entries = await run(quoting({}), True)
        assert {e["code"]: e["in_combos"] for e in entries} == {CODE: [], "sep-condor": []}

    async def test_matches_the_contract_not_the_strike_the_same_strike_on_another_expiry_is_another(
        self, monitor, combo, run
    ):
        monitor(code=LEG_A, strike=8100)
        combo(strike_date="2027-01-15")
        entries = await run(quoting({}), True)
        assert next(e for e in entries if e["code"] == LEG_A)["in_combos"] == []

    async def test_leaves_out_a_combo_that_is_switched_off_which_is_not_in_the_watchlist(self, monitor, combo, run):
        monitor(code=LEG_A, strike=8100)
        combo(enabled=0)
        [e] = await run(quoting({}), True)
        assert e["in_combos"] == []

    async def test_knows_only_the_combos_in_the_same_batch_so_the_bot_s_single_leg_tables_name_none(
        self, monitor, combo, run
    ):
        # the bot's /quotes, /greeks and /vol leave combos out and read no such field; /quotes, the route
        # the page polls, asks for every enabled rule
        monitor(code=LEG_A, strike=8100)
        combo()
        [e] = await run(quoting({}))
        assert e["in_combos"] == []


class TestSpxSPriceOnEveryRow:
    """#288: SPX's price, derived once from the batch's premiums (ADR 0024)."""

    async def test_is_derived_once_from_the_batch_the_same_on_every_row_legs_included(self, monitor, combo, run):
        monitor()
        combo()
        # CODE is a call at 6500 and the legs calls at 8100 and 8150: each inverts to its own level,
        # and the batch's figure is their median, put on every row as the contract size is
        fetch = quoting(
            {
                CODE: {"mid_price": 26.4, "last_price": 1000, "option_premium": -6.0},
                LEG_A: {"mid_price": 1, "last_price": 2, "option_premium": 7.0},
                LEG_B: {"mid_price": 1, "last_price": 1, "option_premium": 8.0},
            }
        )
        quotes = await run(fetch, True)
        levels = sorted([7500 / 0.94, 8102 / 1.07, 8151 / 1.08])
        assert len(quotes) == 2
        for q in quotes:
            assert q["spx"] == round(levels[1], 2)
            assert q["spx_reason"] is None

    async def test_is_a_dash_with_its_reason_where_the_provider_gives_no_premium(self, monitor, run):
        monitor()
        [e] = await run(quoting({CODE: {"mid_price": 26.4, "last_price": 26}}))
        assert e["spx"] is None
        assert e["spx_reason"] == "the Provider gives no option premium to derive it from"


class TestASpreadSShortStrikesAgainstSpx:
    """#297: each short leg of a combo placed against the batch's SPX, in points and sigma."""

    async def test_places_each_short_leg_of_a_combo_against_the_batch_s_spx(self, combo, run):
        # the combo is long 8100, short 8150 (minus is short)
        combo()
        fetch = quoting(
            {
                LEG_A: {"mid_price": 1, "last_price": 2, "option_premium": 7.0, "option_delta": 0.05},
                LEG_B: {
                    "mid_price": 1,
                    "last_price": 1,
                    "option_premium": 8.0,
                    "option_delta": 0.04,
                    "option_implied_volatility": 15,
                },
            }
        )
        [e] = await run(fetch, True)
        spx = e["spx"]
        points = round(8150 - spx, 2)
        sigma = round(points / (spx * 0.15 * math.sqrt(e["dte"] / 365)), 2)
        assert [s.model_dump() for s in e["short_strikes"]] == [
            {"code": LEG_B, "option_type": "CALL", "strike": 8150, "delta": 0.04, "points": points, "sigma": sigma}
        ]

    async def test_keeps_the_strikes_and_deltas_with_no_spx_and_measures_nothing(self, combo, run):
        combo()
        [e] = await run(quoting({LEG_B: {"mid_price": 1, "option_delta": 0.04}}), True)
        assert e["spx"] is None
        assert [s.model_dump() for s in e["short_strikes"]] == [
            {"code": LEG_B, "option_type": "CALL", "strike": 8150, "delta": 0.04, "points": None, "sigma": None}
        ]

    async def test_is_empty_for_a_single_contract_which_is_no_spread(self, monitor, run):
        monitor()
        [e] = await run(quoting({CODE: {"mid_price": 26.4}}))
        assert e["short_strikes"] == []


class TestWhatOnlyThePythonCanGetWrong:
    async def test_leaves_the_four_combo_keys_off_a_single_leg_entry_rather_than_setting_them_to_none(
        self, monitor, combo, run
    ):
        # the TypeScript's entry is an object whose `legs`, `combo_value`, `combo_greeks` and `error`
        # are ABSENT on a row they do not apply to, and `/quotes` answers it that way; a key present as
        # None would answer `null` where the dashboard and the door scenarios see nothing
        monitor()
        combo()
        entries = await run(quoting({}), True)
        single = next(e for e in entries if e["option_type"] == "CALL")
        assert not {"legs", "combo_value", "combo_greeks", "error"} & single.keys()
        held = next(e for e in entries if e["option_type"] == "CMB")
        assert {"legs", "combo_value", "combo_greeks"} <= held.keys()
        assert "error" not in held

    async def test_reads_a_watched_figure_sent_as_text_as_javascript_does(self, monitor, run):
        # the TypeScript reads it through `monitorValue`, which is `Number(v)`; Python's `abs` would
        # raise on a string, and its `>=` would compare one
        monitor(threshold=0.6)
        [entry] = await run(quoting({CODE: {"option_delta": "0.7"}}))
        assert (entry["triggered"], entry["fill"]) == (True, 100)

    async def test_reads_a_watched_zero_as_a_figure_not_as_a_missing_one(self, monitor, run):
        # `??` keeps a 0, which Python's `or` would drop
        monitor(threshold=0.6)
        [entry] = await run(quoting({CODE: {"option_delta": 0}}))
        assert (entry["triggered"], entry["fill"]) == (False, 0)

    async def test_asks_for_the_batch_in_javascript_s_sort_order(self, db, monitor):
        # `[...codes].sort()` compares UTF-16 code units, where Python's `sorted` compares code points:
        # the two disagree once a code holds a character beyond the Basic Multilingual Plane
        monitor(code="\U0001f600")
        monitor(code="\uffff")
        asked: list[list[str]] = []

        async def fetch(codes):
            asked.append(codes)
            return [{"code": c} for c in codes]

        await watchlist_quotes(db, TZ, fake_fetcher(fetch), now=NOW, policy=POLICY)
        assert asked == [["\U0001f600", "\uffff"]]

    async def test_names_the_combos_a_contract_is_a_leg_of_in_javascript_s_sort_order(self, monitor, combo, run):
        # `.sort()` again, on the combos' ids: by UTF-16 code unit, not by code point
        monitor(code=LEG_A, strike=8100)
        combo(id="\uffff", code="sep-a")
        combo(id="\U0001f600", code="sep-b")
        entries = await run(quoting({}), True)
        assert next(e for e in entries if e["code"] == LEG_A)["in_combos"] == ["\U0001f600", "\uffff"]
