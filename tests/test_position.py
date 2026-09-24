"""Domain maths for a Position: what it costs to close, what it's exposed to, what it's worth."""

from datetime import UTC, datetime, timedelta

from optionality.service.models import Position
from optionality.service.position import (
    contract_size,
    cost_to_close,
    position_greek,
    position_leg_codes,
    position_pnl,
)


def _future() -> str:
    return (datetime.now(UTC).date() + timedelta(days=30)).isoformat()


def _condor(entry: float = 3.0, contracts: int = 1) -> Position:
    return Position(
        name="1016_IC",
        strategy="iron_condor",
        strike_date=_future(),
        contracts=contracts,
        entry=entry,
        legs=[
            {"side": "sold", "option_type": "CALL", "strike": 8050.0},
            {"side": "bought", "option_type": "CALL", "strike": 8075.0},
            {"side": "sold", "option_type": "PUT", "strike": 7100.0},
            {"side": "bought", "option_type": "PUT", "strike": 7075.0},
        ],
    )


def _quotes(position: Position, mids: list[float], **extra) -> dict:
    """Map each leg's code to a quote carrying the given mid."""
    return {
        code: {"code": code, "mid_price": mid, "option_contract_size": 100.0, **extra}
        for code, mid in zip(position_leg_codes(position), mids, strict=True)
    }


def test_cost_to_close_buys_back_what_you_sold():
    p = _condor()
    # sold 5.00 and 3.00, bought 2.00 and 1.50
    value = cost_to_close(p, _quotes(p, [5.0, 2.0, 3.0, 1.5]))
    assert value == 4.5  # (5.0 + 3.0) - (2.0 + 1.5)


def test_cost_to_close_needs_every_leg():
    p = _condor()
    by_code = _quotes(p, [5.0, 2.0, 3.0, 1.5])
    del by_code[position_leg_codes(p)[2]]
    # no partial sums, ever — same rule the combo engine already held to
    assert cost_to_close(p, by_code) is None


def test_exposure_signs_are_the_inverse_of_cost_to_close_signs():
    """A sold leg costs money to buy back (+) but contributes negative exposure (-)."""
    p = _condor()
    by_code = _quotes(p, [1.0, 1.0, 1.0, 1.0])
    for code, leg in zip(position_leg_codes(p), p.legs, strict=True):
        by_code[code]["option_delta"] = 0.5 if leg["option_type"] == "CALL" else -0.5

    # cost to close: sold legs add, bought legs subtract -> all mids equal -> 0
    assert cost_to_close(p, by_code) == 0.0
    # exposure: bought minus sold. calls +0.5 each, puts -0.5 each
    #   bought(C 0.5 + P -0.5) - sold(C 0.5 + P -0.5) = 0
    assert position_greek(p, by_code, "option_delta") == 0.0

    # now make the short call dominate, so the two signings cannot coincide
    by_code[position_leg_codes(p)[0]]["option_delta"] = 0.9
    assert position_greek(p, by_code, "option_delta") == -0.4  # short a 0.9-delta call


def test_pnl_is_entry_less_cost_to_close_in_money():
    p = _condor(entry=3.0, contracts=2)
    by_code = _quotes(p, [5.0, 2.0, 3.0, 1.5])  # cost to close 4.5
    # sold for 3.00, costs 4.50 to buy back, 2 contracts, 100 per point
    assert position_pnl(p, by_code) == (3.0 - 4.5) * 2 * 100


def test_contract_size_comes_from_the_quote_not_a_constant():
    p = _condor()
    by_code = _quotes(p, [5.0, 2.0, 3.0, 1.5])
    assert contract_size(by_code) == 100.0
    for q in by_code.values():
        q["option_contract_size"] = 10.0
    assert contract_size(by_code) == 10.0
    assert position_pnl(p, by_code) == (3.0 - 4.5) * 1 * 10.0


def test_pnl_is_unknown_when_a_leg_is_missing():
    p = _condor()
    by_code = _quotes(p, [5.0, 2.0, 3.0, 1.5])
    del by_code[position_leg_codes(p)[0]]
    assert position_pnl(p, by_code) is None  # never a half-priced position


def test_cost_to_close_matches_the_old_signed_sum_magnitude():
    """Regression against the live 1016_IC, which read -1.55 as a combo monitor.

    Its legs carried '-' on sold and '+' on bought, so the old signed sum was the
    negative of the cost to close. Same quotes must now yield +1.55.
    """
    p = _condor()
    mids = [5.0, 2.0, 3.0, 4.45]
    old_signed_sum = sum((-1 if leg["side"] == "sold" else 1) * mid for leg, mid in zip(p.legs, mids, strict=True))
    assert round(old_signed_sum, 2) == -1.55
    assert round(cost_to_close(p, _quotes(p, mids)), 2) == 1.55


def test_pnl_is_rounded_to_money_precision():
    p = _condor(entry=3.21, contracts=1)
    # 3.21 - 1.60 in binary floating point is 1.6100000000000003
    by_code = _quotes(p, [5.0, 2.0, 3.0, 4.4])
    assert position_pnl(p, by_code) == 161.0  # not 160.99999999999986


def test_scope_selects_a_wing_of_the_condor():
    p = _condor()
    by_code = _quotes(p, [5.0, 2.0, 3.0, 1.5])
    # calls: sold 5.00, bought 2.00 -> 3.00 to close that wing
    assert cost_to_close(p, by_code, scope="calls") == 3.0
    # puts: sold 3.00, bought 1.50 -> 1.50
    assert cost_to_close(p, by_code, scope="puts") == 1.5
    # the wings add up to the whole
    assert cost_to_close(p, by_code) == 4.5


def test_scope_narrows_exposure_too():
    p = _condor()
    by_code = _quotes(p, [1.0, 1.0, 1.0, 1.0])
    for code, leg in zip(position_leg_codes(p), p.legs, strict=True):
        by_code[code]["option_delta"] = 0.4 if leg["option_type"] == "CALL" else -0.3
    # calls wing: bought 0.4 - sold 0.4 = 0.0; make the short call dominate
    by_code[position_leg_codes(p)[0]]["option_delta"] = 0.9
    assert position_greek(p, by_code, "option_delta", scope="calls") == -0.5
    assert position_greek(p, by_code, "option_delta", scope="puts") == 0.0


def test_unknown_scope_is_the_whole_position():
    p = _condor()
    by_code = _quotes(p, [5.0, 2.0, 3.0, 1.5])
    assert cost_to_close(p, by_code, scope=None) == 4.5
    assert cost_to_close(p, by_code, scope="all") == 4.5


def test_pnl_is_unknown_until_an_entry_is_recorded():
    p = _condor()
    p.entry = None  # migrated from a combo, which never recorded what was taken in
    by_code = _quotes(p, [5.0, 2.0, 3.0, 1.5])
    assert cost_to_close(p, by_code) == 4.5  # still knows what it costs to close
    assert position_pnl(p, by_code) is None  # but not how that compares to entry
