"""The sign of a zero from `to_fixed`, which `==` cannot see (#297's review).

`Number((-0).toFixed(2))` is +0: the string is "0.00". But `Number((-0.004).toFixed(2))` is -0: the
string is "-0.00". Decimal kept the sign of the first, so a sigma worked out from a points figure of
-0 was served as -0.0 by the Python and 0 by the TypeScript — equal to every comparison but this.
The golden cases carry the two as well; this says it where the sign is the whole claim.
"""

import math

from optionality.js import to_fixed
from optionality.quote import strike_distances


def sign(x: float) -> float:
    return math.copysign(1.0, x)


def test_a_negative_zero_comes_back_positive_as_javascript_s_string_does():
    assert sign(to_fixed(-0.0, 2)) == 1.0
    assert sign(to_fixed(-0.0, 0)) == 1.0


def test_a_negative_that_rounds_to_zero_keeps_its_sign():
    assert sign(to_fixed(-0.004, 2)) == -1.0


def test_a_zero_sigma_a_hair_past_the_strike_is_a_positive_zero():
    code = "US.SPXW261218C7300000"
    [d] = strike_distances([code], {code: {"option_implied_volatility": 12}}, 7300.004, 37)
    assert sign(d.points) == -1.0
    assert sign(d.sigma) == 1.0
