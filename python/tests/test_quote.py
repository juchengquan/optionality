"""What a golden case cannot state about `display_records`.

A case is one call, and this claim is about the ARGUMENT afterwards: the function copies, so the
records it was handed come back untouched. A case comparing one call's output cannot tell a copy
from a mutation, and a sweep found exactly that — replacing `dict(raw)` with `raw` passed all 223
cases. The TypeScript has had this test since the function was written (`quotes.test.ts`); the port
never did, because the port never had the function at all until ADR 0017.

Testing it also found the REASON both sides gave for copying was false. They said
`market_time_to_display` is not idempotent; measured, a second conversion is a no-op in both
languages, because the pattern requires a naive time and declines a value that already carries an
offset. The copy is still right — these records are shared — but the comment was not.
"""

from datetime import UTC, datetime

from optionality.quote import display_records

CODE = "US.SPXW261120C7100000"
AT = datetime(2026, 11, 19, 13, 47, 30, tzinfo=UTC)


def test_copies_rather_than_mutates_because_conversion_is_not_idempotent():
    # the service renders its cached records on every dashboard poll; mutating them would convert
    # an already-converted timestamp a second time
    record = {"code": CODE, "update_time": "2026-08-09 20:15:00"}
    display_records([record], "Asia/Singapore", AT)
    assert record["update_time"] == "2026-08-09 20:15:00"
    assert "fetched_at" not in record
