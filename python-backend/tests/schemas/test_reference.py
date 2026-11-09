"""What the API accepts for a Reference, and every vendor one may name.

backend/src/schemas/reference.ts and sources.ts have no tests of their own: their callers' suites rely
on them. So this holds what they rely on — `entrypoints/http/routes/references.test.ts` on a code
being kept trimmed and upper-cased, an empty code refused, a source it has never heard of refused
(the schema's enum, not the registry), and a Reference with no source refused; and
`vendors/index.test.ts` on `SOURCES` being every vendor a Reference may name.
"""

import pytest

from optionality_backend.schemas import SOURCES as PUBLISHED
from optionality_backend.schemas.reference import SOURCES, ReferenceIn
from optionality_backend.schemas.sources import SOURCES as LISTED
from optionality_backend.schemas.zod import ZodError, parse, prettify_error


def detail(body) -> str:
    with pytest.raises(ZodError) as err:
        parse(ReferenceIn, body)
    return prettify_error(err.value)


class TestAReference:
    def test_keeps_a_code_trimmed_and_upper_cased_and_a_label_trimmed(self):
        # `us.spy` typed into a box is the same Security as US.SPY, and must not become a second row
        given = parse(ReferenceIn, {"code": "  us.spy ", "label": " S&P ", "source": "moomoo"})
        assert (given.code, given.label, given.source) == ("US.SPY", "S&P", "moomoo")

    def test_lets_the_code_be_its_own_name(self):
        assert parse(ReferenceIn, {"code": "^GSPC", "source": "yahoo"}).label is None

    def test_refuses_an_empty_code_and_an_empty_label(self):
        assert (
            detail({"code": "   ", "source": "moomoo"})
            == "✖ Too small: expected string to have >=1 characters\n  → at code"
        )
        assert detail({"code": "US.SPY", "label": " ", "source": "moomoo"}) == (
            "✖ Too small: expected string to have >=1 characters\n  → at label"
        )

    def test_refuses_a_source_it_has_never_heard_of_and_a_reference_with_no_source(self):
        unknown = '✖ Invalid option: expected one of "moomoo"|"ibkr"|"yahoo"\n  → at source'
        assert detail({"code": "US.SPY", "source": "bloomberg"}) == unknown
        assert detail({"code": "US.SPY"}) == unknown


class TestTheSources:
    def test_are_every_vendor_a_reference_may_name_in_one_list(self):
        assert SOURCES == ("moomoo", "ibkr", "yahoo")
        assert LISTED is SOURCES and PUBLISHED is SOURCES, "one list, re-exported"
