"""`/monitors` and `/quotes`. Port of backend/src/entrypoints/http/routes/monitors.test.ts.

Every test comes across. "the links to positions" seeds its Positions directly, as the TypeScript's
does. What only the Python can get wrong is at the end.
"""

import json
import math
import re

import pytest
from harness import days_from_now, json_body, poisonable, quoting

# relative to the HARNESS's clock, not the real one — see NOW in tests/harness.py
days_ahead = days_from_now


def future() -> str:
    return days_ahead(30)


def single(**over):
    return {"strike_date": future(), "option_type": "CALL", "strike": 6500, "threshold": 0.6, **over}


COMBO = {
    "name": "sep-condor",
    "legs": [
        {"sign": 1, "option_type": "CALL", "strike": 8100},
        {"sign": -1, "option_type": "CALL", "strike": 8150},
    ],
    "threshold": 10,
    "direction": "below",
}


def combo(**over):
    return {**COMBO, "strike_date": future(), **over}


async def post(h, payload):
    return await h.call("/monitors", **json_body(payload))


async def patch(h, id_, payload):
    return await h.call(f"/monitors/{id_}", **{**json_body(payload), "method": "PATCH"})


class TestTheRoundTrip:
    async def test_creates_lists_patches_and_deletes(self, start):
        h = start()
        created = await post(h, single())
        assert created.status_code == 201
        data = created.json()
        # uuid4 hex, like run ids — not a guessable sequence
        assert len(data["id"]) == 32
        assert re.fullmatch(r"US\.SPXW\d{6}C6500000", data["code"])
        assert data["field"] == "option_delta"
        assert data["enabled"] is True

        assert (await post(h, single())).status_code == 409  # duplicate (code, field)

        listed = (await h.call("/monitors")).json()
        assert len(listed) == 1
        assert listed[0]["last_value"] is None
        assert listed[0]["triggered"] is False

        assert (await patch(h, data["id"], {"threshold": 0.5})).status_code == 200
        assert (await h.call("/monitors")).json()[0]["threshold"] == 0.5

        assert (await h.call(f"/monitors/{data['id']}", method="DELETE")).status_code == 204
        assert (await h.call("/monitors")).json() == []

    async def test_allows_the_same_contract_on_a_different_field(self, start):
        h = start()
        assert (await post(h, single())).status_code == 201
        assert (await post(h, single(field="mid_price", threshold=30))).status_code == 201

    async def test_is_a_404_for_a_monitor_that_was_never_there_and_says_which_noun_is_missing(self, start):
        # The status alone was asserted here, and on both doors: a mutation changing the PATCH handler's
        # not_found("monitor") to not_found("position") survived, which is a 404 reading "position not
        # found" about a monitor. Only /monitors/:id/total-entry stated the noun, so the two doors the
        # dashboard actually uses were the two that did not.
        h = start()
        for resp in [await patch(h, "nope", {"threshold": 1}), await h.call("/monitors/nope", method="DELETE")]:
            assert resp.status_code == 404
            assert resp.json() == {"detail": "monitor not found"}


class TestDatesAndShapes:
    async def test_normalises_a_compact_date_to_the_dashed_form(self, start):
        h = start()
        created = await post(h, single(strike_date=future().replace("-", "")))
        assert created.status_code == 201
        assert created.json()["strike_date"] == future()  # stored dashed regardless of input

    async def test_rejects_a_date_that_is_not_one_of_the_two_forms_and_an_impossible_one(self, start):
        h = start()
        for bad in ["18-12-2026", "2026-13-45", "2026-02-30", "nope"]:
            assert (await post(h, single(strike_date=bad))).status_code == 422, bad

    async def test_says_what_is_wrong_with_a_body_whichever_of_the_two_shapes_it_is(self, start):
        # The two shapes are one union, and a union that every member refuses answers "Invalid input"
        # and nothing else — so a date it cannot read, a missing threshold and a combo leg signed 2 all
        # read the same on the dashboard, which prints `detail` verbatim. The shape picks the member,
        # and the member says what it refused.
        h = start()

        async def detail(payload):
            resp = await post(h, payload)
            assert resp.status_code == 422
            return resp.json()["detail"]

        date = "✖ invalid strike_date '18 Dec': use YYYY-MM-DD or YYYYMMDD\n  → at strike_date"
        assert await detail(single(strike_date="18 Dec")) == date
        assert await detail(combo(strike_date="18 Dec")) == date, "and a combo's"
        no_threshold = {k: v for k, v in single().items() if k != "threshold"}
        assert await detail(no_threshold) == "✖ Invalid input: expected number, received undefined\n  → at threshold"
        assert (
            await detail(combo(legs=[{**COMBO["legs"][0], "sign": 2}, COMBO["legs"][1]]))
            == "✖ Invalid option: expected one of 1|-1\n  → at legs[0].sign"
        )

    async def test_reads_a_body_that_carries_legs_as_a_combo_and_refuses_it_as_one(self, start):
        # The union took this as a single-leg rule and dropped the legs without a word: the combo member
        # refused it for want of a name, and the single-leg member accepted it.
        h = start()
        resp = await post(h, single(legs=COMBO["legs"]))
        assert resp.status_code == 422
        assert resp.json()["detail"] == "✖ Invalid input: expected string, received undefined\n  → at name"

    async def test_rejects_an_option_type_that_is_not_call_or_put_and_a_direction_that_is_neither(self, start):
        h = start()
        assert (await post(h, single(option_type="FOO"))).status_code == 422
        assert (await post(h, single(direction="sideways"))).status_code == 422

    async def test_stores_a_below_direction_monitor_as_asked(self, start):
        h = start()
        created = await post(h, single(field="mid_price", threshold=30, direction="below"))
        assert created.json()["direction"] == "below"

    async def test_renders_timestamps_in_the_display_zone(self, start):
        h = start()
        assert (await post(h, single())).json()["created_at"].endswith("+08:00")


class TestThresholds:
    async def test_refuses_a_non_positive_threshold_in_abs_mode_everywhere_it_can_be_set(self, start):
        # abs comparison makes these never-firing (below) or always-firing (above)
        h = start()
        assert (await post(h, single(threshold=-4.05))).status_code == 422
        assert (await post(h, single(threshold=0))).status_code == 422
        assert (await post(h, combo(threshold=-1))).status_code == 422

        id_ = (await post(h, single())).json()["id"]
        assert (await patch(h, id_, {"threshold": -1})).status_code == 422

    async def test_says_which_rule_the_threshold_broke_not_merely_that_it_broke_one(self, start):
        # Only the 422 was asserted, so the two sentences were interchangeable: a mutation swapping them
        # broke nothing, and a signed zero could be refused with "must be positive when compare='abs'" —
        # an error naming a mode you did not use.
        h = start()
        abs_ = (await post(h, single(threshold=0, compare="abs"))).json()
        assert "must be positive when compare='abs'" in abs_["detail"], "the abs rule"

        signed = (await post(h, single(threshold=0, compare="signed"))).json()
        assert "signed threshold cannot be 0" in signed["detail"], "the signed rule"

        # and PATCH keeps its own shorter wording for the same two faults
        id_ = (await post(h, single())).json()["id"]
        patched_abs = (await patch(h, id_, {"threshold": 0, "compare": "abs"})).json()
        assert "must be positive when compare='abs'" in patched_abs["detail"]
        patched_signed = (await patch(h, id_, {"threshold": 0, "compare": "signed"})).json()
        assert "signed threshold cannot be 0" in patched_signed["detail"]

    async def test_allows_a_negative_threshold_in_signed_mode_and_refuses_exactly_zero(self, start):
        h = start()
        created = await post(
            h, single(strike=8100, field="mid_price", threshold=-4.05, direction="below", compare="signed")
        )
        assert created.status_code == 201
        data = created.json()
        assert data["compare"] == "signed"

        assert (await patch(h, data["id"], {"threshold": -5})).status_code == 200
        # a signed threshold of zero is a band of zero width that a value can sit exactly on
        assert (await patch(h, data["id"], {"threshold": 0})).status_code == 422
        assert (await post(h, single(strike=8150, field="mid_price", threshold=0, compare="signed"))).status_code == 422

    async def test_judges_a_patched_threshold_against_the_compare_mode_in_the_same_patch(self, start):
        h = start()
        id_ = (await post(h, single(option_type="PUT", strike=7800))).json()["id"]
        assert (await patch(h, id_, {"threshold": -1})).status_code == 422
        # the two together are legal; the threshold alone is not
        assert (await patch(h, id_, {"compare": "signed", "threshold": -1})).status_code == 200


class TestCombos:
    async def test_creates_one_under_the_name_the_trader_chose_with_the_combo_default_field(self, start):
        h = start()
        created = await post(h, combo())
        assert created.status_code == 201
        data = created.json()
        assert data["code"] == "sep-condor"
        assert data["field"] == "mid_price"  # combo default, not option_delta
        assert data["option_type"] == "CMB"
        assert len(data["legs"]) == 2

        assert (await post(h, combo())).status_code == 409  # duplicate name

    async def test_needs_at_least_two_legs_to_be_a_combo_at_all(self, start):
        h = start()
        assert (await post(h, combo(name="x", legs=COMBO["legs"][:1]))).status_code == 422

    async def test_keeps_its_legs_through_an_edit_that_tries_to_carry_new_ones(self, start):
        # The legs define it; changing them would change what the alarm means. PUT refused that in prose
        # — "combo monitors cannot be edited in place; delete and recreate" — and went with the route in
        # #199. The protection is now structural: `MonitorPatch` has no `legs`, so the key is dropped
        # and the stored legs cannot be reached from any door.
        #
        # Stated as what the API DOES rather than as a refusal, because that is the truth and the
        # difference matters to anyone reading this file: the key is dropped silently, not rejected, so
        # the rest of the patch still applies. Worth pinning either way — a schema that gained a
        # passthrough, or a handler that started spreading `given` into `changes`, would edit the legs
        # of a live combo with nothing to show for it.
        h = start()
        created = (await post(h, combo())).json()
        assert len(created["legs"]) == 2
        resp = await patch(
            h, created["id"], {"threshold": 12, "legs": [{"sign": 1, "option_type": "CALL", "strike": 1}]}
        )
        assert resp.status_code == 200
        after = (await h.call("/monitors")).json()[0]
        assert after["threshold"] == 12  # the legal half went through
        assert after["legs"] == created["legs"]  # and the legs are exactly as created

    async def test_names_the_field_before_the_threshold_when_both_are_wrong(self, start):
        # Precedence, pinned on both doors. The route checked the combo field first and the bot checked
        # the threshold first, so one input had two answers depending on where you typed it;
        # create_monitor.py fixes one order and this is half of what holds it there (the other half is
        # the same test in the bot's suite). The field wins because it says the rule can never work,
        # while a threshold is a number you can correct.
        h = start()
        resp = await post(
            h,
            combo(
                name="both-wrong",
                field="option_implied_volatility",
                threshold=-1,
                legs=[
                    {"sign": 1, "option_type": "CALL", "strike": 8100},
                    {"sign": 1, "option_type": "CALL", "strike": 8150},
                ],
            ),
        )
        assert resp.status_code == 422
        assert "not additive" in resp.json()["detail"]

    async def test_cannot_watch_implied_volatility(self, start):
        # IV is intensive: two 20% legs are not a 40% combo. Summing it is meaningless, so the field is
        # refused at the gate rather than producing a nonsense alarm.
        h = start()
        resp = await post(
            h,
            combo(
                name="iv-combo",
                field="option_implied_volatility",
                legs=[
                    {"sign": 1, "option_type": "CALL", "strike": 8100},
                    {"sign": 1, "option_type": "CALL", "strike": 8150},
                ],
            ),
        )
        assert resp.status_code == 422
        assert resp.json()["detail"] == "combos cannot watch option_implied_volatility: it is not additive across legs"

    async def test_is_patchable_for_the_safe_fields_leaving_the_legs_alone(self, start):
        h = start()
        created = (await post(h, combo())).json()
        patched = await patch(h, created["id"], {"threshold": 25})
        assert patched.status_code == 200
        data = patched.json()
        assert data["threshold"] == 25
        assert data["legs"] == created["legs"]


class TestRenaming:
    async def test_keeps_the_monitor_s_history_which_recreating_it_would_lose(self, start):
        h = start()
        created = (await post(h, combo())).json()
        # a live, triggered monitor with history
        h.db.execute("update monitors set triggered = 1, last_value = 7.15 where id = ?", (created["id"],))

        renamed = await patch(h, created["id"], {"name": "sep-condor-v2"})
        assert renamed.status_code == 200
        data = renamed.json()
        assert data["code"] == "sep-condor-v2"
        assert data["triggered"] is True
        assert data["last_value"] == 7.15
        assert data["legs"] == created["legs"]
        assert data["created_at"] == created["created_at"]

    async def test_refuses_a_single_leg_monitor_whose_code_is_derived_from_its_contract(self, start):
        h = start()
        id_ = (await post(h, single())).json()["id"]
        resp = await patch(h, id_, {"name": "nope"})
        assert resp.status_code == 422
        assert re.search(r"only combo monitors can be renamed", resp.json()["detail"])

    async def test_refuses_a_name_another_monitor_already_uses(self, start):
        h = start()
        a = (await post(h, combo())).json()
        b = (await post(h, combo(name="other"))).json()
        assert (await patch(h, b["id"], {"name": a["code"]})).status_code == 409


class TestPatching:
    async def test_changes_only_what_it_was_given(self, start):
        h = start()
        id_ = (await post(h, single())).json()["id"]
        patched = await patch(h, id_, {"threshold": 0.5, "direction": "below"})
        assert patched.status_code == 200
        data = patched.json()
        assert data["threshold"] == 0.5
        assert data["direction"] == "below"
        assert data["field"] == "option_delta"  # untouched

    async def test_refuses_an_empty_patch_rather_than_reporting_a_change_it_did_not_make(self, start):
        h = start()
        id_ = (await post(h, single())).json()["id"]
        resp = await patch(h, id_, {})
        assert resp.status_code == 422
        assert resp.json()["detail"] == "nothing to update"

    async def test_changes_every_field_a_rule_has_in_one_patch_what_it_watches_its_direction_its_compare(self, start):
        # the dashboard's editor sends whichever of the four changed (#292), and each must land
        h = start()
        id_ = (await post(h, single())).json()["id"]
        data = (
            await patch(h, id_, {"field": "mid_price", "direction": "below", "compare": "signed", "threshold": -1.5})
        ).json()
        assert [data["field"], data["direction"], data["compare"], data["threshold"]] == [
            "mid_price",
            "below",
            "signed",
            -1.5,
        ]
        assert (await h.call("/monitors")).json()[0]["field"] == "mid_price"

    async def test_refuses_a_combo_moved_onto_a_figure_that_does_not_add_up_across_its_legs(self, start):
        # POST refuses a combo on IV; a PATCH reaching the same row by the back door must too, or the
        # engine sums nothing and the rule goes silent until it is quarantined (CLAUDE.md: Combos)
        h = start()
        id_ = (await post(h, combo())).json()["id"]
        resp = await patch(h, id_, {"field": "option_implied_volatility"})
        assert resp.status_code == 422
        assert resp.json()["detail"] == "combos cannot watch option_implied_volatility: it is not additive across legs"
        assert (await h.call("/monitors")).json()[0]["field"] == "mid_price"

    async def test_lets_a_single_leg_watch_its_iv_which_is_its_own_and_needs_no_sum(self, start):
        h = start()
        id_ = (await post(h, single())).json()["id"]
        assert (await patch(h, id_, {"field": "option_implied_volatility", "threshold": 25})).status_code == 200

    async def test_refuses_a_field_that_would_collide_with_another_monitor_on_the_same_contract(self, start):
        h = start()
        await post(h, single())
        other = (await post(h, single(field="mid_price", threshold=30))).json()
        assert (await patch(h, other["id"], {"field": "option_delta"})).status_code == 409

    async def test_records_that_a_monitor_was_disabled_by_hand_and_clears_that_on_re_enable(self, start):
        # the sweeper's own quarantine and expiry notices must not be overwritten by a manual toggle
        h = start()
        id_ = (await post(h, single())).json()["id"]
        assert (await patch(h, id_, {"enabled": False})).json()["disabled_reason"] == "manual"
        assert (await patch(h, id_, {"enabled": True})).json()["disabled_reason"] is None


class TestTheOrdering:
    async def test_groups_by_expiry_combos_first_then_calls_before_puts(self, start):
        h = start()
        near = future()
        far = days_ahead(45)
        for payload in [
            single(strike_date=far, strike=8100),
            single(strike_date=near, option_type="PUT", strike=6425, threshold=0.5),
            single(strike_date=near, strike=6500),
            combo(
                name="near-condor",
                strike_date=near,
                threshold=10,
                legs=[
                    {"sign": 1, "option_type": "CALL", "strike": 6500},
                    {"sign": -1, "option_type": "CALL", "strike": 6600},
                ],
            ),
        ]:
            await post(h, payload)

        listed = (await h.call("/monitors")).json()
        assert [m["strike_date"] for m in listed] == [near, near, near, far]
        # the combo leads its own expiry, not the CALL/PUT gap
        assert listed[0]["code"] == "near-condor"
        assert [m["option_type"] for m in listed[1:3]] == ["CALL", "PUT"]


class TestTheCreationGate:
    async def test_refuses_a_contract_moomoo_does_not_have_and_persists_nothing(self, start):
        h = start(fetch_quotes=poisonable("99999"))
        resp = await post(h, single(strike=99999, strike_date="2026-10-16", threshold=0.5))
        assert resp.status_code == 422
        assert "does not exist" in resp.json()["detail"]
        assert (await h.call("/monitors")).json() == []

    async def test_refuses_a_combo_when_any_one_leg_does_not_exist(self, start):
        h = start(fetch_quotes=poisonable("99999"))
        resp = await post(
            h,
            combo(
                name="bad-combo",
                strike_date="2026-10-16",
                legs=[
                    {"sign": 1, "option_type": "CALL", "strike": 8100},
                    {"sign": -1, "option_type": "CALL", "strike": 99999},
                ],
            ),
        )
        assert resp.status_code == 422
        assert (await h.call("/monitors")).json() == []

    async def test_refuses_when_the_probe_threw_rather_than_accepting_a_contract_it_cannot_check(self, start):
        # strict by design: a monitor on a contract that does not exist would quarantine itself on the
        # first sweep, which is a worse way to find out.
        #
        # The wording carries the Provider's own sentence and no longer claims an outage: a Provider
        # that ANSWERED and declined the security throws here too (ADR 0018).
        async def failing(codes):
            raise RuntimeError("Client connection failed!")

        h = start(fetch_quotes=failing)
        resp = await post(h, single(strike=8100, threshold=0.5))
        assert resp.status_code == 422
        assert (
            resp.json()["detail"]
            == "cannot verify contract: the Provider did not confirm it — Client connection failed!"
        )


def seed_position(h, id_, name, strike_date, strike):
    h.db.execute(
        """insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
         values (?, ?, 'credit_spread', ?, 1, 2.0, ?, '2026-09-24 02:58:57.456253')""",
        (id_, name, strike_date, f'[{{"side":"short","option_type":"CALL","strike":{strike}}}]'),
    )


def link_count(h, monitor_id):
    return h.db.execute("select count(*) n from monitor_positions where monitor_id = ?", (monitor_id,)).fetchone()[0]


class TestTheLinksToPositions:
    async def test_attaches_a_new_monitor_to_whatever_position_already_holds_its_contract(self, start):
        # without this, everything the Position work built — entry, P&L, the derived total — applies
        # only to monitors that predate the migration which backfilled these rows
        h = start()
        seed_position(h, "p" * 32, "del-target", "2026-12-18", 6500)
        created = (await post(h, single(strike_date="2026-12-18", strike=6500, threshold=0.2))).json()
        assert link_count(h, created["id"]) == 1
        assert created["scope"] == "all"
        # The create response carries the links it has just made. It answered `positions: []` until
        # #172 — the old Python's did too, and the port kept it — which is a false statement about a row
        # the same transaction linked: `scope: "all"` beside an empty list says "this covers a whole
        # holding" and "no holding", and a client has no way to tell which half to believe. The list
        # route is NOT the answer to that: it is a second call, so a client acting on the reply it just
        # received acts on the lie.
        assert created["positions"] == [{"id": "p" * 32, "name": "del-target"}]
        listed = (await h.call("/monitors")).json()
        assert listed[0]["positions"] == created["positions"]

    async def test_carries_the_links_on_a_combo_it_has_just_linked_by_its_legs(self, start):
        # a combo links by its LEGS and never by its own name, so its reply is the one place the linkage
        # is least guessable from the request
        h = start()
        seed_position(h, "p" * 32, "wing", "2026-12-18", 8100)
        created = (await post(h, combo(strike_date="2026-12-18"))).json()
        assert created["positions"] == [{"id": "p" * 32, "name": "wing"}]

    async def test_carries_the_links_when_a_monitor_is_patched(self, start):
        # an edit does not change the links, which is exactly why the reply must still state them: a
        # client that re-renders a row from the PATCH response would otherwise lose the holding's name
        # and its leg badge until the next poll
        h = start()
        seed_position(h, "p" * 32, "del-target", "2026-12-18", 6500)
        created = (await post(h, single(strike_date="2026-12-18", strike=6500, threshold=0.2))).json()
        # spelled out rather than compared to `created["positions"]`: two empty lists are equal, so that
        # comparison passes while every reply is wrong — the shape of a vacuous assertion
        linked = [{"id": "p" * 32, "name": "del-target"}]
        assert (await patch(h, created["id"], {"threshold": 0.3})).json()["positions"] == linked

    async def test_takes_the_links_with_it_when_the_monitor_goes_and_leaves_the_position(self, start):
        # deleting the monitor first raised FOREIGN KEY constraint failed for every row in the live
        # database, because every one of them is linked (#70). A Position is a holding: it exists whether
        # or not anything watches it (ADR 0001).
        h = start()
        seed_position(h, "p" * 32, "del-target", "2026-12-18", 6500)
        created = (await post(h, single(strike_date="2026-12-18", strike=6500, threshold=0.2))).json()
        assert link_count(h, created["id"]) == 1

        assert (await h.call(f"/monitors/{created['id']}", method="DELETE")).status_code == 204
        assert link_count(h, created["id"]) == 0
        assert h.db.execute("select name from positions").fetchone() == ("del-target",)

    async def test_leaves_the_monitor_and_its_links_alone_when_the_delete_cannot_finish(self, start):
        # DELETE is the only handler in this module wrapping two writes in `atomic`. `db/test_open.py`
        # proves `atomic` rolls back; this proves this route uses it, which is a different claim and the
        # one that can rot.
        #
        # The links must go before the row or the foreign key refuses (#70). A half-applied delete in the
        # other order is the worse half: a monitors row gone with its links behind it, or the links
        # cleared while the rule stays — a rule that would then report no holding, no entry and no P&L
        # for a position the trader still owns.
        #
        # The failure is injected in SQLite rather than by mocking, so what is proved is the handler's
        # transaction and not a stand-in for it.
        h = start()
        seed_position(h, "p" * 32, "keep-me", "2026-12-18", 6500)
        created = (await post(h, single(strike_date="2026-12-18", strike=6500, threshold=0.2))).json()
        assert link_count(h, created["id"]) == 1

        h.db.execute(
            """create trigger no_delete before delete on monitors
               begin select raise(abort, 'delete refused'); end"""
        )
        assert (await h.call(f"/monitors/{created['id']}", method="DELETE")).status_code == 500

        # the row is still there AND still linked: the clear that ran first was rolled back with it
        assert h.db.execute("select id from monitors where id = ?", (created["id"],)).fetchone() is not None
        assert link_count(h, created["id"]) == 1

        # and with the trigger gone the same delete goes through, which says the 500 was the trigger's
        # doing and not a monitor left in a state that refuses every further write
        h.db.execute("drop trigger no_delete")
        assert (await h.call(f"/monitors/{created['id']}", method="DELETE")).status_code == 204
        assert link_count(h, created["id"]) == 0

    async def test_links_nothing_when_no_position_holds_the_contract(self, start):
        # watching a strike you have no position in is legitimate; it simply has no entry and no P&L
        h = start()
        created = (await post(h, single())).json()
        assert link_count(h, created["id"]) == 0
        assert created["scope"] is None
        assert created["positions"] == []

    async def test_links_nothing_when_two_positions_hold_the_same_contract(self, start):
        # rolling a spread can leave the old and the new sharing a strike for a day, and the entry is then
        # genuinely ambiguous. A wrong P&L is worse than an absent one.
        h = start()
        seed_position(h, "a" * 32, "old", "2026-12-18", 6500)
        seed_position(h, "b" * 32, "new", "2026-12-18", 6500)
        created = (await post(h, single(strike_date="2026-12-18", strike=6500, threshold=0.2))).json()
        assert link_count(h, created["id"]) == 0
        assert created["scope"] is None


def echo_then_fail():
    """Lets the creation probe through, then fails the watchlist call."""
    first = [True]

    async def fetch(codes):
        if first[0]:
            first[0] = False
            return [{"code": c} for c in codes]
        raise RuntimeError("quota exceeded")

    return fetch


class TestQuotes:
    async def test_is_empty_with_nothing_enabled_and_does_not_call_opend_at_all(self, start):
        calls = [0]

        async def counting(codes):
            calls[0] += 1
            return [{"code": c} for c in codes]

        h = start(fetch_quotes=counting)
        assert (await h.call("/quotes")).json() == []
        assert calls[0] == 0

    async def test_carries_each_monitor_s_own_quote_and_threshold(self, start):
        h = start()
        await post(h, single())
        code = (await h.call("/monitors")).json()[0]["code"]
        h.close()

        h = start(fetch_quotes=quoting({code: {"name": "X", "option_delta": 0.33}}))
        await post(h, single())
        quotes = (await h.call("/quotes")).json()
        assert len(quotes) == 1
        assert quotes[0]["quote"]["option_delta"] == 0.33
        assert quotes[0]["threshold"] == 0.6
        assert quotes[0]["dte"] == 30

    async def test_carries_the_figures_a_rule_s_sentence_reads_which_the_reply_schema_would_strip(self, start):
        # the response model drops whatever EntryOut does not list, so a figure computed in the service
        # and left out of the model vanishes on the way out with nothing failing (ADR 0023's sentence:
        # "spread value ≥ 6.01 — now 2.00, 4.01 away", and the spread a leg's rule sits under)
        async def figures(codes):
            return [{"code": c, "option_delta": 0.45, "mid_price": 2} for c in codes]

        h = start(fetch_quotes=figures)
        leg = (await post(h, single(strike=8100, threshold=0.6))).json()["id"]
        spread = (await post(h, combo(field="mid_price"))).json()["id"]
        quotes = (await h.call("/quotes")).json()

        row = next(q for q in quotes if q["id"] == leg)
        assert row["watched"] == 0.45
        assert row["distance"] == pytest.approx(0.15, abs=1e-12)
        assert row["in_combos"] == [spread]
        # 2.00 less 2.00 is nothing, below a threshold of 10: breached, and 10 past it
        total = next(q for q in quotes if q["id"] == spread)
        assert [total["watched"], total["distance"], total["triggered"], total["in_combos"]] == [0, -10, True, []]

    async def test_says_whether_a_rule_watches_anything_held_even_where_no_link_names_the_holding(self, start):
        # a roll day: two holdings share the short call, so the link declines to name either — and the
        # response model would drop `held` as it drops any field it does not list
        h = start()
        for id_, name in [("a" * 32, "old"), ("b" * 32, "new")]:
            seed_position(h, id_, name, future(), 6500)
        await post(h, single())
        await post(h, single(strike=6550))
        quotes = (await h.call("/quotes")).json()
        assert [[len(q["positions"]), q["held"]] for q in quotes] == [[0, True], [0, False]]

    async def test_keeps_every_row_when_one_rule_s_reading_cannot_be_written_as_json(self, start):
        # a field the quote schema does not type passes through, so its Infinity reached `watched` and
        # the response model refused the whole watchlist: one row's figure took down every row
        async def figures(codes):
            return [{"code": c, "option_delta": 0.45, "option_open_interest": math.inf} for c in codes]

        h = start(fetch_quotes=figures)
        await post(h, single())
        far = (await post(h, single(strike=6550, field="option_open_interest", threshold=1000))).json()["id"]
        resp = await h.call("/quotes")
        assert resp.status_code == 200
        quotes = resp.json()
        assert len(quotes) == 2
        row = next(q for q in quotes if q["id"] == far)
        assert [row["watched"], row["distance"], row["fill"], row["triggered"]] == [None, None, 100, True]

    async def test_answers_502_rather_than_500_when_the_provider_call_fails(self, start):
        h = start(fetch_quotes=echo_then_fail())
        await post(h, single())
        resp = await h.call("/quotes")
        assert resp.status_code == 502
        assert "moomoo call failed" in resp.json()["detail"]

    async def test_names_the_provider_that_failed_whichever_one_this_deployment_reads(self, start):
        # the dashboard prints this `detail` verbatim, and it said "OpenD call failed" whatever was
        # answering — the same leak ADR 0018 corrected in `verify_contracts` and the sweeper's degraded
        # default corrected again. A sentence naming one vendor is wrong the moment OPTIONALITY_PROVIDER
        # names another.
        h = start(provider_name="ibkr", fetch_quotes=echo_then_fail())
        await post(h, single())
        detail = (await h.call("/quotes")).json()["detail"]
        assert detail.startswith("ibkr call failed")
        assert "OpenD" not in detail, "never the vendor it is not"

    async def test_excludes_a_disabled_monitor(self, start):
        h = start()
        id_ = (await post(h, single())).json()["id"]
        await patch(h, id_, {"enabled": False})
        assert (await h.call("/quotes")).json() == []


class TestTotalEntry:
    async def test_is_a_404_for_a_rule_that_does_not_exist(self, start):
        h = start()
        resp = await h.call("/monitors/nope/total-entry", **json_body({"entry": 1.0}))
        assert resp.status_code == 404
        assert resp.json() == {"detail": "monitor not found"}

    async def test_is_a_422_for_a_rule_with_no_holdings_attached(self, start):
        h = start()
        id_ = (await post(h, single(strike=8100))).json()["id"]
        resp = await h.call(f"/monitors/{id_}/total-entry", **json_body({"entry": 3.21}))
        assert resp.status_code == 422
        assert resp.json()["detail"] == "no holdings attached to this rule"

    async def test_records_the_derived_credit_and_answers_ok(self, start):
        h = start()

        # a condor: two spreads, a rule over the calls alone, and one spanning both (ADR 0004)
        def seed(id_, name, entry, legs):
            h.db.execute(
                """insert into positions (id, name, strategy, strike_date, contracts, entry, legs, created_at)
                 values (?, ?, 'credit_spread', '2026-12-18', 1, ?, ?, '2026-08-01 00:00:00.000000')""",
                (id_, name, entry, json.dumps(legs, separators=(",", ":"))),
            )

        # each wing holds BOTH its legs, so the rule over the calls covers it exactly and derives scope
        # "all". The old Python's version of this test forged that scope by writing the Monitor
        # directly; going through the API means it is computed, and computed from the legs.
        seed(
            "c" * 32,
            "calls",
            2.87,
            [
                {"side": "short", "option_type": "CALL", "strike": 8050},
                {"side": "long", "option_type": "CALL", "strike": 8075},
            ],
        )
        seed(
            "p" * 32,
            "puts",
            None,
            [
                {"side": "short", "option_type": "PUT", "strike": 7100},
                {"side": "long", "option_type": "PUT", "strike": 7075},
            ],
        )

        wing = (
            await post(
                h,
                combo(
                    name="calls_rule",
                    strike_date="2026-12-18",
                    legs=[
                        {"sign": 1, "option_type": "CALL", "strike": 8050},
                        {"sign": -1, "option_type": "CALL", "strike": 8075},
                    ],
                ),
            )
        ).json()
        assert wing["scope"] == "all"  # covers the calls wing exactly, so its credit is editable
        span = (
            await post(
                h,
                combo(
                    name="span_rule",
                    strike_date="2026-12-18",
                    legs=[
                        {"sign": 1, "option_type": "CALL", "strike": 8050},
                        {"sign": 1, "option_type": "PUT", "strike": 7100},
                    ],
                ),
            )
        ).json()["id"]
        resp = await h.call(f"/monitors/{span}/total-entry", **json_body({"entry": 3.21}))
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
        puts = h.db.execute("select entry from positions where name = 'puts'").fetchone()[0]
        assert abs(puts - 0.34) < 1e-10

    async def test_rejects_a_payload_with_no_entry_at_all(self, start):
        h = start()
        id_ = (await post(h, single())).json()["id"]
        assert (await h.call(f"/monitors/{id_}/total-entry", **json_body({}))).status_code == 422


class TestWhatOnlyThePythonCanGetWrong:
    """The TypeScript parses every answer through its zod schema, which refuses what does not fit and
    drops what it does not name; pydantic, left to its defaults, coerces instead and sets every
    optional key it has."""

    async def test_answers_a_single_leg_row_without_the_keys_only_a_combo_carries(self, start):
        # zod's `.optional()` leaves an absent key absent; a response model would answer it as null
        h = start()
        await post(h, single())
        await post(h, combo())
        quotes = {q["option_type"]: q for q in (await h.call("/quotes")).json()}
        assert not {"legs", "combo_value", "combo_greeks", "error"} & quotes["CALL"].keys()
        assert {"legs", "combo_value", "combo_greeks"} <= quotes["CMB"].keys()

    async def test_passes_through_what_the_provider_sent_beyond_the_fields_it_names(self, start):
        # the quote is a LOOSE object: its named fields are typed, and the rest go through for a human
        # reading JSON — but a named field the provider did not send stays absent rather than null
        code = "US.SPXW" + future()[2:].replace("-", "") + "C6500000"
        h = start(fetch_quotes=quoting({code: {"option_delta": 0.33, "volume": 12}}))
        await post(h, single())
        quote = (await h.call("/quotes")).json()[0]["quote"]
        assert quote["volume"] == 12
        assert "mid_price" not in quote

    async def test_answers_502_for_a_quote_its_schema_refuses_as_the_typescript_s_try_does(self, start):
        # the reply is parsed INSIDE the route's try, so a figure zod refuses is the Provider's 502 there,
        # not the 500 a refused answer is anywhere else
        code = "US.SPXW" + future()[2:].replace("-", "") + "C6500000"
        h = start(fetch_quotes=quoting({code: {"option_delta": "0.33"}}))
        await post(h, single())
        resp = await h.call("/quotes")
        assert resp.status_code == 502
        assert resp.json()["detail"].startswith("moomoo call failed: ")

    async def test_refuses_to_serve_a_stored_rule_its_schema_refuses(self, start):
        # a 500 in the dashboard's shape, as zod's parse failing inside `reply` is. Text a REAL column
        # cannot read as a number stays text, and pydantic's default would serve it where zod refuses
        h = start()
        id_ = (await post(h, single())).json()["id"]
        h.db.execute("update monitors set strike = 'n/a' where id = ?", (id_,))
        resp = await h.call("/monitors")
        assert (resp.status_code, resp.json()) == (500, {"detail": "internal error"})

    async def test_reads_an_absent_key_as_leave_it_and_refuses_an_explicit_null(self, start):
        # zod omits an absent key from what it parsed and refuses a null; the model must not read either
        # as "set it to None"
        h = start()
        id_ = (await post(h, single())).json()["id"]
        assert (await patch(h, id_, {"direction": None})).status_code == 422
        data = (await patch(h, id_, {"direction": "below"})).json()
        assert (data["threshold"], data["field"], data["enabled"]) == (0.6, "option_delta", True)

    async def test_answers_a_delete_with_no_body_at_all(self, start):
        h = start()
        id_ = (await post(h, single())).json()["id"]
        resp = await h.call(f"/monitors/{id_}", method="DELETE")
        assert (resp.status_code, resp.content) == (204, b"")
