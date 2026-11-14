"""Quote batches and the OpenD client, with fakes — a test must NEVER reach the real moomoo SDK, which
blocks for ever on a dead port, so a missing fake looks like a hung suite (CLAUDE.md)."""

import pytest

from optionality import opend

A, B, C = "US.SPXW261120P6500000", "US.SPXW261120P6501000", "US.SPXW261120C7100000"


class FakeFrame:
    def __init__(self, rows):
        self.rows = rows

    def to_dict(self, orient):
        assert orient == "records"
        return [dict(r) for r in self.rows]


class Poisonable:
    """moomoo refuses the WHOLE batch while an unknown code is in it, naming it WITHOUT its prefix.

    Driven through the client rather than through a bare fetcher, because containment lives INSIDE
    the provider now (ADR 0017): reading moomoo's error prose is moomoo's business, and the port
    answers with which codes could not be priced. It read that prose above the port until ADR 0017
    found the TypeScript had moved it in #168 and the Python had not followed.
    """

    def __init__(self, bad: str, named: str | None = None):
        self.bad, self.named = bad, named or bad.removeprefix("US.")
        self.asked: list[list[str]] = []
        self.closed = False

    def get_market_snapshot(self, codes):
        self.asked.append(list(codes))
        if self.bad in codes:
            return -1, f"Unknown stock. {self.named}"
        return 0, FakeFrame([{"code": c} for c in codes])

    def close(self):
        self.closed = True


def connect(ctx):
    return lambda host, port: ctx


def test_drops_the_named_culprit_and_keeps_the_rest():
    ctx = Poisonable(B)
    with opend.OpenD(connect=connect(ctx)) as od:
        batch = od.quotes([A, B, C])
    assert [r["code"] for r in batch.records] == [A, C]
    assert batch.unknown == [B]
    _records, unknown = batch  # unpacks, for a notebook's one-liner
    assert unknown == [B]
    # it asked twice: the whole batch, then the batch without the culprit
    assert ctx.asked == [[A, B, C], [A, C]]


def test_a_failure_that_names_no_culprit_is_not_contained():
    # retrying an outage one code at a time would present it as a watchlist of unknown contracts
    ctx = FakeContext(error=RuntimeError("Client connection failed!"))
    with pytest.raises(RuntimeError, match="connection"), opend.OpenD(connect=connect(ctx)) as od:
        od.quotes([A])


def test_a_culprit_it_cannot_map_is_not_contained():
    ctx = Poisonable(A, named="SPXW991231P1000")
    with pytest.raises(RuntimeError, match="Unknown stock"), opend.OpenD(connect=connect(ctx)) as od:
        od.quotes([A])


def test_verify_says_which_contract_does_not_exist():
    with opend.OpenD(connect=connect(Poisonable(B))) as od:
        assert od.verify([A, B]) == f"contract does not exist: {B} — check strike and expiry"
    with opend.OpenD(connect=connect(Poisonable(B))) as od:
        assert od.verify([A]) is None


def test_verify_refuses_while_opend_is_down():
    ctx = FakeContext(error=RuntimeError("Client connection failed!"))
    with opend.OpenD(connect=connect(ctx)) as od:
        assert od.verify([A]) == "cannot verify contract: the Provider did not confirm it — Client connection failed!"


def test_verify_notices_a_contract_moomoo_quietly_left_out():
    ctx = FakeContext(rows=[{"code": A}])
    with opend.OpenD(connect=connect(ctx)) as od:
        assert od.verify([A, C]) == f"contract does not exist: {C} — check strike and expiry"


class FakeContext:
    def __init__(self, ret=0, rows=None, error=None):
        self.ret, self.rows, self.error = ret, rows or [], error
        self.closed = False
        self.asked = []

    def get_market_snapshot(self, codes):
        self.asked.append(list(codes))
        if self.error:
            raise self.error
        return self.ret, (FakeFrame(self.rows) if self.ret == 0 else "Unknown stock. SPXW261120P6501000")

    def close(self):
        self.closed = True


def test_derives_a_mid_only_from_both_sides():
    ctx = FakeContext(rows=[{"code": A, "bid_price": 2.0, "ask_price": 2.5}, {"code": C, "bid_price": 1.0}])
    with opend.OpenD(connect=connect(ctx)) as od:
        records = od.fetch([A, C])
    assert records[0]["mid_price"] == 2.25
    assert "mid_price" not in records[1]  # a mid from one side looks like a price and is not one


def test_an_empty_book_is_no_mid_and_keeps_its_sides():
    # moomoo quotes every option bid 0 / ask 0 out of hours, and a mid of 0 valued the book at 0.00
    # every evening (#380): no ask above zero is no price, by `quote.mid_price`
    rows = [{"code": A, "bid_price": 0.0, "ask_price": 0.0}, {"code": C, "bid_price": 0.0, "ask_price": 0.05}]
    ctx = FakeContext(rows=rows)
    with opend.OpenD(connect=connect(ctx)) as od:
        records = od.fetch([A, C])
    assert "mid_price" not in records[0]
    assert (records[0]["bid_price"], records[0]["ask_price"]) == (0.0, 0.0)
    assert records[1]["mid_price"] == 0.025  # a worthless wing offered at 0.05 is a quote


def test_closes_the_connection_even_when_the_call_fails():
    # the TypeScript's #128: every OpenD failure leaked a websocket that reconnected for ever
    ctx = FakeContext(error=RuntimeError("timeout"))
    with pytest.raises(RuntimeError), opend.OpenD(connect=connect(ctx)) as od:
        od.fetch([A])
    assert ctx.closed


def test_a_refused_batch_raises_with_moomoo_s_words_so_containment_can_read_them():
    ctx = FakeContext(ret=-1)
    with opend.OpenD(connect=connect(ctx)) as od, pytest.raises(RuntimeError, match="Unknown stock"):
        od.fetch([A])


def test_quotes_and_verify_reuse_one_connection():
    ctx = FakeContext(rows=[{"code": A}])
    opened = []
    with opend.OpenD(connect=lambda h, p: opened.append((h, p)) or ctx) as od:
        od.quotes([A])
        od.verify([A])
    assert len(opened) == 1
    assert ctx.asked == [[A], [A]]


def test_without_the_extra_says_how_to_get_it(monkeypatch):
    monkeypatch.setattr(opend, "_sdk_connect", None)
    with pytest.raises(ImportError, match=r"optionality\[opend\]"), opend.OpenD():
        pass
