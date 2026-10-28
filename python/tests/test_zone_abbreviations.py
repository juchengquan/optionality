"""How tzdata names a zone, against how ICU names it (testdata/zone-abbreviations.json).

`display_time_short` is the one function in this package that CANNOT reproduce the TypeScript, and
it says so in its docstring. That made it the one function whose divergence nothing checked: it has
one golden case, in Asia/Singapore, which is a zone where the two agree, so the port could have
drifted anywhere outside that single row and the suite would have stayed green.

The table is the fix, and it is data both suites read. This file asserts the `py` column — tzdata's
answer, which is what this package prints — and the TypeScript asserts the `ts` column from the same
rows (backend/src/domain/zone-abbreviations.test.ts). A change in tzdata fails here, a change in ICU
fails there, and nobody can quietly teach this function ICU's answer to make the two match.

The rows where they agree are golden cases as well, and those are compared exactly as everything
else is. The rows where they do not agree cannot be: the golden mechanism has no tolerance by
design, and an "expected to differ" exemption inside it is exactly the hole that would hide a
rounding divergence that matters.
"""

import json
from datetime import datetime
from pathlib import Path

import pytest

from optionality.timefmt import display_time_short

TABLE = json.loads(
    (Path(__file__).resolve().parents[2] / "testdata" / "zone-abbreviations.json").read_text()
)
ROWS = TABLE["rows"]


def test_the_table_has_rows_on_both_sides():
    # all-agreeing rows would leave the divergence assertions below vacuous while staying green
    differ = [r for r in ROWS if r["ts"] != r["py"]]
    assert len(ROWS) >= 13
    assert len(differ) >= 7
    assert len({r["zone"] for r in differ}) == 5


@pytest.mark.parametrize("row", ROWS, ids=lambda r: f"{r['zone']} at {r['at'][:10]}")
def test_tzdata_names_the_zone_as_the_table_says(row):
    # fromisoformat takes the trailing Z since 3.11, and this package needs >= 3.12
    when = datetime.fromisoformat(row["at"])
    assert display_time_short(when, row["zone"]) == row["py"]


@pytest.mark.parametrize("row", [r for r in ROWS if r["ts"] != r["py"]], ids=lambda r: r["zone"])
def test_a_divergence_is_tzdata_having_a_name_icu_lacks(row):
    # the ONE rule behind every disagreeing row: Python prints a name, ICU falls back to the offset
    name = row["py"].rsplit(" ", 1)[1]
    assert name.isalpha(), f"{row['zone']}: expected an abbreviation, got {name}"
    assert row["ts"].rsplit(" ", 1)[1][0] in "+-"
    # and the two agree on everything before the zone: same instant, same wall clock
    assert row["py"].rsplit(" ", 1)[0] == row["ts"].rsplit(" ", 1)[0]


def test_london_parts_from_the_typescript_only_in_summer():
    # a zone is not agreeing or disagreeing, an INSTANT is: ICU has GMT and lacks BST, so one
    # DISPLAY_TZ reads exactly to the TypeScript in January and differs from it in July
    winter, summer = (r for r in ROWS if r["zone"] == "Europe/London")
    assert winter["ts"] == winter["py"]
    assert summer["ts"] != summer["py"]
    assert display_time_short(datetime.fromisoformat("2026-01-15T12:00:00+00:00"), "Europe/London") == "2026-01-15 12:00 GMT"
    assert display_time_short(datetime.fromisoformat("2026-07-15T12:00:00+00:00"), "Europe/London") == "2026-07-15 13:00 BST"
