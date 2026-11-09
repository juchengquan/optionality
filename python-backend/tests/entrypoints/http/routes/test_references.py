"""`/references` — the three doors, and what each one refuses (ADR 0018). Port of
backend/src/entrypoints/http/routes/references.test.ts.

The behaviour this file is mostly about is what does NOT happen: no route writes a Reference's state,
nothing disables one, and GET declares no failure status at all. `tests/test_references.py` holds the
degrade; this holds the surface.

What only the Python can get wrong is at the end.
"""

import math

import pytest
from harness import json_body, quoting
from optionality.quote import Batch

SPY = {
    "code": "US.SPY",
    "name": "SPDR S&P 500 ETF Trust",
    "bid_price": 758.7,
    "ask_price": 758.76,
    "mid_price": 758.73,
    "last_price": 755.72,
    "prev_close_price": 755.72,
}


@pytest.fixture
def begin(start):
    """A Provider that quotes SPY and knows nothing else — which is what the live one does with an index
    code, give or take the sentence. The TypeScript's `start`."""
    return lambda: start(fetch_quotes=quoting({"US.SPY": SPY}))


async def post(h, payload):
    return await h.call("/references", **json_body(payload))


async def created(h, payload) -> str:
    resp = await post(h, payload)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def matches(data: dict, **fields) -> bool:
    """`toMatchObject`: the named fields, and only those."""
    return {k: data.get(k) for k in fields} == fields


class TestKeepingASecurityOnThePage:
    async def test_takes_a_raw_code_a_label_and_a_source(self, begin):
        h = begin()
        resp = await post(h, {"code": "US.SPY", "label": "SPX", "source": "moomoo"})
        assert resp.status_code == 201
        assert matches(resp.json(), code="US.SPY", label="SPX", source="moomoo")

    async def test_takes_a_code_with_no_label_where_the_code_is_its_own_name(self, begin):
        h = begin()
        assert matches(
            (await post(h, {"code": "US.SPY", "source": "moomoo"})).json(), code="US.SPY", label=None, source="moomoo"
        )

    async def test_upper_cases_and_trims_the_code_so_one_security_cannot_become_two_rows(self, begin):
        h = begin()
        assert matches(
            (await post(h, {"code": "  us.spy ", "source": "moomoo"})).json(), code="US.SPY", source="moomoo"
        )
        # and the duplicate check then sees it, which is the half that matters
        assert (await post(h, {"code": "US.SPY", "source": "moomoo"})).status_code == 409

    async def test_refuses_a_second_reference_on_the_same_security(self, begin):
        h = begin()
        await created(h, {"code": "US.SPY", "source": "moomoo"})
        resp = await post(h, {"code": "US.SPY", "label": "SPY", "source": "moomoo"})
        assert resp.status_code == 409
        # two References on one Security would be two figures that cannot differ
        assert "already kept on the page" in resp.json()["detail"]

    async def test_refuses_a_duplicate_without_spending_a_provider_call(self, start):
        # the order is the point, as it is in `create-monitor.ts`: everything free comes before anything
        # that costs a bounded call, and the database already knows the answer
        calls = 0
        quote = quoting({"US.SPY": SPY})

        async def counting(codes: list[str]) -> Batch:
            nonlocal calls
            calls += 1
            return await quote(codes)

        h = start(fetch_quotes=counting)
        await created(h, {"code": "US.SPY", "source": "moomoo"})
        spent = calls
        assert (await post(h, {"code": "US.SPY", "source": "moomoo"})).status_code == 409
        assert calls == spent, "the duplicate reached the Provider"

    async def test_probes_the_provider_strictly_as_monitor_creation_does(self, begin):
        h = begin()
        resp = await post(h, {"code": "US.NOPE", "source": "moomoo"})
        assert resp.status_code == 422
        assert "does not exist" in resp.json()["detail"]
        # and nothing was written: a permanent dash is better found at creation than on the page
        assert h.db.execute("select count(*) as n from reference_securities").fetchone()[0] == 0

    async def test_refuses_an_index_the_provider_answers_about_and_declines_without_calling_it_an_outage(self, start):
        # the measurement ADR 0018 is built on: moomoo refuses every US stock index as a CLASS, naming no
        # culprit, so the containment loop re-throws and this is the path `US..SPX` takes. The gateway
        # is up; "unreachable" would send the owner to look at the wrong thing.
        async def declining(codes: list[str]) -> Batch:
            raise RuntimeError("snapshot API failed: US stock indices are not supported")

        h = start(fetch_quotes=declining)
        resp = await post(h, {"code": "US..SPX", "label": "SPX", "source": "moomoo"})
        assert resp.status_code == 422
        detail = resp.json()["detail"]
        assert "US stock indices are not supported" in detail
        assert "unreachable" not in detail

    async def test_refuses_a_source_it_has_never_heard_of(self, begin):
        # the schema's enum, not the registry: a name outside SOURCES is a typo rather than an
        # unconfigured vendor, and the two deserve different sentences
        h = begin()
        assert (await post(h, {"code": "US.SPY", "source": "bloomberg"})).status_code == 422

    async def test_probes_the_named_vendor_not_the_provider(self, start):
        # the claim ADR 0019 rests on, and it was unprovable until the registry became injectable: with
        # only the Provider in it, `sources[source]` and `deps.provider.fetch_quotes` are the same
        # function, so a mutation swapping them changed nothing and no test failed.
        asked: list[list[str]] = []

        async def knows_nothing(codes: list[str]) -> Batch:
            # the Provider knows nothing, so a probe sent there would refuse the code
            return Batch(records=[], unknown=["SPX"])

        async def ibkr(codes: list[str]) -> Batch:
            asked.append(list(codes))
            return Batch(records=[{"code": "SPX", "name": "S&P 500"}], unknown=[])

        h = start(fetch_quotes=knows_nothing, reference_sources={"ibkr": ibkr})
        resp = await h.call(
            "/references",
            method="POST",
            headers={"content-type": "application/json"},
            content='{"code":"SPX","source":"ibkr"}',
        )

        assert resp.status_code == 201
        assert asked == [["SPX"]]

    async def test_refuses_a_code_the_named_vendor_does_not_know_even_where_the_provider_would_price_it(self, start):
        # the other direction: the Provider must not rescue a code its vendor cannot quote
        async def prices_it(codes: list[str]) -> Batch:
            return Batch(records=[{"code": "SPX"}], unknown=[])

        async def ibkr(codes: list[str]) -> Batch:
            return Batch(records=[], unknown=["SPX"])

        h = start(fetch_quotes=prices_it, reference_sources={"ibkr": ibkr})
        resp = await h.call(
            "/references",
            method="POST",
            headers={"content-type": "application/json"},
            content='{"code":"SPX","source":"ibkr"}',
        )
        assert resp.status_code == 422

    async def test_refuses_a_source_with_no_client_in_this_build_saying_which(self, begin):
        # `ibkr` is a name SOURCES knows and this build cannot reach, so the refusal names the vendor
        # rather than claiming the code does not exist (ADR 0019)
        h = begin()
        resp = await post(h, {"code": "SPX", "source": "ibkr"})
        assert resp.status_code == 422
        assert "no ibkr client in this build" in resp.json()["detail"]

    async def test_refuses_a_reference_with_no_source_at_all(self, begin):
        # required, because a Reference whose vendor is unknown cannot be fetched
        h = begin()
        assert (await post(h, {"code": "US.SPY"})).status_code == 422

    async def test_refuses_an_empty_code(self, begin):
        h = begin()
        assert (await post(h, {"code": "   ", "source": "moomoo"})).status_code == 422


class TestReadingThem:
    async def test_answers_the_figure_the_field_it_came_from_and_the_day_s_move(self, begin):
        h = begin()
        await created(h, {"code": "US.SPY", "label": "SPY", "source": "moomoo"})
        rows = (await h.call("/references")).json()
        assert len(rows) == 1
        assert matches(
            rows[0],
            code="US.SPY",
            label="SPY",
            source="moomoo",
            name="SPDR S&P 500 ETF Trust",
            figure=758.73,
            field="mid_price",
            error=None,
        )

    async def test_answers_200_with_a_dash_while_the_provider_is_wholly_down(self, start):
        # the one surface here that cannot fail: the page it decorates must still draw, and a backdrop
        # that can 502 is a backdrop that can take the watchlist's screen with it
        async def down(codes: list[str]) -> Batch:
            raise RuntimeError("Client connection failed!")

        h = start(fetch_quotes=down)
        h.db.execute(
            """insert into reference_securities (id, code, label, source, created_at)
               values (?, 'US.SPY', 'SPY', 'moomoo', '2026-11-02 00:00:00.000000')""",
            ("r" * 32,),
        )
        resp = await h.call("/references")
        assert resp.status_code == 200
        rows = resp.json()
        assert matches(rows[0], figure=None, field=None, change=None)
        assert "Client connection failed!" in rows[0]["error"]

    async def test_answers_an_empty_list_before_anything_is_kept(self, begin):
        h = begin()
        assert (await h.call("/references")).json() == []


class TestRemovingOne:
    async def test_removes_it_and_says_so_with_no_body(self, begin):
        h = begin()
        id_ = await created(h, {"code": "US.SPY", "source": "moomoo"})
        assert (await h.call(f"/references/{id_}", method="DELETE")).status_code == 204
        assert (await h.call("/references")).json() == []

    async def test_names_the_noun_when_there_is_nothing_to_remove(self, begin):
        h = begin()
        resp = await h.call("/references/nope", method="DELETE")
        assert resp.status_code == 404
        assert resp.json()["detail"] == "reference not found"

    async def test_is_the_only_way_one_ever_goes_reading_them_never_writes(self, begin):
        h = begin()
        await created(h, {"code": "US.SPY", "label": "SPY", "source": "moomoo"})
        before = [tuple(r) for r in h.db.execute("select * from reference_securities").fetchall()]
        # a code the Provider cannot price, read twice: a Monitor would be quarantined for this and a
        # Reference is not, because quarantine is about a rule that cannot be EVALUATED
        h.db.execute(
            """insert into reference_securities (id, code, label, source, created_at)
               values (?, 'US.NOPE', null, 'moomoo', '2026-11-02 00:00:01.000000')""",
            ("n" * 32,),
        )
        await h.call("/references")
        await h.call("/references")
        after = h.db.execute("select * from reference_securities where code = 'US.SPY'").fetchall()
        assert [tuple(r) for r in after] == before
        assert h.db.execute("select count(*) as n from reference_securities").fetchone()[0] == 2


class TestWhatOnlyThePythonCanGetWrong:
    async def test_a_created_reference_answers_its_stored_instant_unconverted(self, begin):
        # `created_at` as STORED, which is not what `/positions` does with its own: the TypeScript's
        # `out` copies the column and converts nothing, and the door scenarios hold the stored text
        h = begin()
        assert (await post(h, {"code": "US.SPY", "source": "moomoo"})).json()["created_at"] == (
            "2026-10-02 05:26:06.299000"
        )

    async def test_a_removal_answers_no_body_and_no_content_type(self, begin):
        # Hono's `c.body(null, 204)`; a FastAPI route that returned None would answer `null` as JSON
        h = begin()
        id_ = await created(h, {"code": "US.SPY", "source": "moomoo"})
        resp = await h.call(f"/references/{id_}", method="DELETE")
        assert (resp.status_code, resp.content, resp.headers.get("content-type")) == (204, b"", None)

    async def test_a_minute_count_the_answer_cannot_carry_is_a_500_not_a_lie(self, start):
        # zod's `z.number()` refuses an infinity, and a pydantic model left to its defaults would serve
        # one as `Infinity`, which no JSON parser reads (`allow_inf_nan=False`)
        h = start(fetch_quotes=quoting({"US.SPY": {**SPY, "delayed_by_minutes": math.inf}}))
        await created(h, {"code": "US.SPY", "source": "moomoo"})
        resp = await h.call("/references")
        assert (resp.status_code, resp.json()) == (500, {"detail": "internal error"})
