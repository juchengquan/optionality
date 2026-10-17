"""Quote batches and the OpenD client, with fakes — a test must NEVER reach the real moomoo SDK, which
blocks for ever on a dead port, so a missing fake looks like a hung suite (CLAUDE.md)."""

import pytest
from optionality.quotes import fetch_resilient, verify_contracts

from optionality import opend

A, B, C = "US.SPXW261120P6500000", "US.SPXW261120P6501000", "US.SPXW261120C7100000"


def poisonable(bad: str):
    """moomoo refuses the WHOLE batch while an unknown code is in it, naming it WITHOUT its prefix."""

    def fetch(codes):
        if bad in codes:
            raise RuntimeError(f"snapshot API failed: Unknown stock. {bad.removeprefix('US.')}")
        return [{"code": c} for c in codes]

    return fetch


def test_drops_the_named_culprit_and_keeps_the_rest():
    batch = fetch_resilient([A, B, C], poisonable(B))
    assert [r["code"] for r in batch.records] == [A, C]
    assert batch.bad == [B]
    _records, bad = batch  # unpacks, for a notebook's one-liner
    assert bad == [B]


def test_a_failure_that_names_no_culprit_is_not_contained():
    def down(_codes):
        raise RuntimeError("Client connection failed!")

    with pytest.raises(RuntimeError, match="connection"):
        fetch_resilient([A], down)


def test_a_culprit_it_cannot_map_is_not_contained():
    with pytest.raises(RuntimeError, match="Unknown stock"):
        fetch_resilient([A], poisonable_named("SPXW991231P1000"))


def poisonable_named(name: str):
    def fetch(_codes):
        raise RuntimeError(f"snapshot API failed: Unknown stock. {name}")

    return fetch


def test_verify_says_which_contract_does_not_exist():
    assert verify_contracts([A, B], poisonable(B)) == f"contract does not exist: {B} — check strike and expiry"
    assert verify_contracts([A], poisonable(B)) is None


def test_verify_refuses_while_opend_is_down():
    def down(_codes):
        raise RuntimeError("Client connection failed!")

    assert verify_contracts([A], down) == "cannot verify contract: OpenD unreachable (Client connection failed!)"


def test_verify_notices_a_contract_moomoo_quietly_left_out():
    assert verify_contracts([A, C], lambda codes: [{"code": A}]) == (
        f"contract does not exist: {C} — check strike and expiry"
    )


class FakeFrame:
    def __init__(self, rows):
        self.rows = rows

    def to_dict(self, orient):
        assert orient == "records"
        return [dict(r) for r in self.rows]


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


def connect(ctx):
    return lambda host, port: ctx


def test_derives_a_mid_only_from_both_sides():
    ctx = FakeContext(rows=[{"code": A, "bid_price": 2.0, "ask_price": 2.5}, {"code": C, "bid_price": 1.0}])
    with opend.OpenD(connect=connect(ctx)) as od:
        records = od.fetch([A, C])
    assert records[0]["mid_price"] == 2.25
    assert "mid_price" not in records[1]  # a mid from one side looks like a price and is not one


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
