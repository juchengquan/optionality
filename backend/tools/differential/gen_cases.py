"""Generate differential cases: shapes a real watchlist produces, plus the awkward ones."""

import json
import random
import sys

random.seed(20261001)

TYPES = ["CALL", "PUT"]
SIDES = ["sold", "bought"]
DATES = ["2026-10-16", "2026-11-20", "20261016", "2026-12-18"]
# SPX quotes move in 0.05, so mids land on .025 — the half-cent tie is reachable
MIDS = [0.0, 0.025, 0.05, 1.275, 2.675, 5.125, 10.005, 33.33, 120.5, 0.015, 0.005]


def leg():
    return {
        "side": random.choice(SIDES),
        "option_type": random.choice(TYPES),
        "strike": random.choice([7100, 7100.5, 6850, 5000.25, 123]),
    }


def condor():
    return [
        {"side": "sold", "option_type": "CALL", "strike": 7100},
        {"side": "bought", "option_type": "CALL", "strike": 7150},
        {"side": "sold", "option_type": "PUT", "strike": 6800},
        {"side": "bought", "option_type": "PUT", "strike": 6750},
    ]


def position(i):
    shape = i % 4
    legs = condor() if shape == 3 else [leg() for _ in range(shape + 1)]
    return {
        "id": f"id{i}",
        "name": f"p{i}",
        "strike_date": random.choice(DATES),
        "contracts": random.choice([1, 2, 10]),
        "entry": random.choice([None, 0.0, 1.25, 2.675, -3.5, 12.345, 0.125, 0.005, 0.015, -0.125, 0.0025, 1.00005]),
        "legs": legs,
    }


def quote():
    q = {}
    for f, pool in (
        ("mid_price", MIDS),
        ("option_delta", [-0.5, 0.0, 0.335, 0.125]),
        ("option_gamma", [0.001, 0.0]),
        ("option_theta", [-1.5, 0.25]),
        ("option_vega", [0.75, 0.0]),
        ("option_implied_volatility", [12.5, 20.0, 0.0]),
        ("option_contract_size", [100, 100.0, 1, 10, 0, None, "100"]),
    ):
        v = random.choice(pool)
        # a field genuinely absent is different from one present and null
        if random.random() < 0.08:
            continue
        if random.random() < 0.08:
            v = None
        q[f] = v
    return q


FIELDS = ["option_delta", "mid_price", "option_implied_volatility", "option_gamma", "last_price"]
# a threshold of 0 is excluded by `not threshold`, and a negative one has no honest baseline
THRESHOLDS = [0, 0.0, 0.1, 0.5, 1.0, -0.3, 2.675, 0.005, 100.0, 1e-9]


def monitor(i, ps):
    """A monitor over one of these positions' strikes, or a combo over two of them."""
    p = ps[i % len(ps)]
    leg = p["legs"][i % len(p["legs"])]
    combo = i % 3 == 0 and len(p["legs"]) >= 2
    return {
        "id": f"m{i}",
        "strike_date": p["strike_date"],
        "option_type": leg["option_type"],
        "strike": leg["strike"],
        "field": random.choice(FIELDS),
        "threshold": random.choice(THRESHOLDS),
        "direction": random.choice(["above", "below", "ABOVE"]),
        "compare": random.choice(["abs", "signed", "other"]),
        "legs": (
            [
                {"sign": random.choice([1, -1]), "option_type": l["option_type"], "strike": l["strike"]}
                for l in p["legs"][:2]
            ]
            if combo
            else None
        ),
    }


cases = []
for i in range(400):
    ps = [position(i * 7 + k) for k in range(random.choice([1, 1, 2, 3]))]
    codes = set()
    for p in ps:
        # build the codes the implementation will ask for, then drop some quotes entirely
        for l in p["legs"]:
            codes.add((p["strike_date"], l["option_type"], l["strike"]))
    by_code_src = [
        {"strike_date": d, "option_type": t, "strike": s, "quote": quote()}
        for (d, t, s) in sorted(codes)
        if random.random() > 0.1
    ]
    # which of the positions' own legs a Monitor watches: a whole, a part, or a stranger.
    # Indices into the position/leg grid, so each side builds the codes with its own builder.
    picks = [(pi, li) for pi, p in enumerate(ps) for li in range(len(p["legs"]))]
    random.shuffle(picks)
    keep = random.choice([0, 1, 2, len(picks)])
    cases.append(
        {
            "positions": ps,
            "quotes": by_code_src,
            "contract_picks": picks[:keep],
            "monitors": [monitor(i * 5 + k, ps) for k in range(3)],
            "stranger": random.random() < 0.15,
            "scope": random.choice([None, "calls", "puts", "all", "leg"]),
        }
    )
# Days-to-expiry is counted from the MARKET date, so the instants that matter are the ones where
# New York and the owner's own calendar disagree, and the ones around a daylight-saving change.
# These are fixed rather than "now": a differential that depends on the wall clock is a
# differential that flakes at midnight.
CLOCK = {
    "instants": [
        "2026-09-30T17:17:00+00:00",  # 01:17 next day in Singapore, still the 30th in New York
        "2026-10-01T03:59:59+00:00",  # 23:59:59 EDT — last second of the market day
        "2026-10-01T04:00:00+00:00",  # 00:00:00 EDT — the market day rolls
        "2026-11-01T04:30:00+00:00",  # 00:30 EDT, before the clocks go back
        "2026-11-01T06:30:00+00:00",  # 01:30 EST, after they do — same local hour twice
        "2026-11-02T04:59:59+00:00",  # 23:59:59 EST, now a five-hour offset
        "2026-11-02T05:00:00+00:00",
        "2027-01-01T04:59:59+00:00",  # still 2026 in New York
        "2026-03-08T06:59:59+00:00",  # 01:59:59 EST, the morning the clocks go forward
        "2026-03-08T07:00:00+00:00",  # 03:00:00 EDT — 02:00 never happens
    ],
    "dates": [*DATES, "2026-10-01", "2026-09-30", "2025-01-02", "2028-02-29"],
}

# Display formatting: storage is UTC and display converts via DISPLAY_TZ, so the instants that
# matter are the ones where the two disagree and the ones that straddle a daylight-saving change
# in either zone. Zones chosen for awkwardness: a half-hour offset, a 45-minute one, one whose
# abbreviation is a bare offset, one that is UTC, and the host default (empty string).
DISPLAY = {
    "zones": [
        "Asia/Singapore",
        "America/New_York",
        "Europe/London",
        "UTC",
        "Asia/Kolkata",
        "Asia/Kathmandu",
        "Australia/Lord_Howe",
        "Pacific/Chatham",
        "America/St_Johns",
    ],
    "instants": [
        "2026-08-10T03:35:32+00:00",
        "2026-01-15T23:59:59+00:00",
        "2026-11-01T05:30:00+00:00",  # inside the hour the US repeats
        "2026-03-08T07:00:00+00:00",  # the hour the US skips
        "2026-03-29T01:00:00+00:00",  # Europe forward
        "2026-10-25T01:00:00+00:00",  # Europe back
        "2026-12-31T16:00:00+00:00",  # a new year in some zones and not others
        "2026-06-30T23:59:59+00:00",
    ],
    # naive strings as moomoo sends them, meaning US Eastern exchange time
    "market_times": [
        "2026-08-09 20:15:00",
        "2026-01-15 09:30:00",
        "2026-11-01 01:30:00",  # ambiguous: happens twice
        "2026-03-08 02:30:00",  # does not exist
        "2026-12-31 23:59:59",
        "2026-07-04 12:00:00",
        "N/A",
        "",
        "not a time",
        # fits the shape and is not a time: Date.UTC rolls this into February 2027 unless the
        # components are checked, which is how the first port of this function was wrong
        "2026-13-45 99:99:99",
        "2026-02-30 12:00:00",
        "2026-00-10 12:00:00",
        "2026-06-30 24:00:00",
    ],
}

with open(sys.argv[1], "w") as f:
    json.dump({"cases": cases, "clock": CLOCK, "display": DISPLAY}, f)
print(f"{len(cases)} cases")
