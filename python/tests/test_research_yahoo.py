"""The Yahoo research module, with fakes — a test must never reach the network.

What these tests can and cannot say is the whole point of `research/__init__.py`: they check that a
yfinance response is PARSED as intended. Whether the intention is right has no second
implementation to disagree with, because this module mirrors no TypeScript. Nothing here is a golden
case.
"""

import importlib.abc
import math
import pathlib
import re
import sys
import tomllib

import pytest

from optionality.research import yahoo

CALLS = [
    {
        "contractSymbol": "SPXW261218C08100000",
        "strike": 8100.0,
        "bid": 12.3,
        "ask": 13.1,
        "lastPrice": 12.7,
        "volume": 42,
        "openInterest": 1234,
        "impliedVolatility": 0.1821,
    },
]
PUTS = [
    {
        "contractSymbol": "SPXW261218P06500000",
        "strike": 6500.0,
        # a strike nobody has quoted: yfinance hands these back as NaN, not as a missing key
        "bid": float("nan"),
        "ask": float("nan"),
        "lastPrice": 1.05,
        "volume": float("nan"),
        "openInterest": 7,
        "impliedVolatility": 0.4,
    },
]
BARS = [
    {"Open": 6700.0, "High": 6750.5, "Low": 6690.0, "Close": 6740.25, "Volume": 1_500_000},
    {"Open": 6740.25, "High": 6760.0, "Low": 6701.0, "Close": 6702.5, "Volume": 1_400_000},
]


class FakeFrame:
    """What `to_dict("records")` and `.index` give, which is all this module asks of a DataFrame."""

    def __init__(self, rows: list[dict], index: list[object] | None = None) -> None:
        self.rows = rows
        self.index = index if index is not None else list(range(len(rows)))

    def to_dict(self, orient: str) -> list[dict]:
        assert orient == "records"
        return [dict(r) for r in self.rows]


class FakeChain:
    def __init__(self, calls: FakeFrame | None, puts: FakeFrame | None) -> None:
        self.calls, self.puts = calls, puts


class FakeTicker:
    def __init__(self, chain: FakeChain | None = None, history: FakeFrame | None = None) -> None:
        self.chain, self._history = chain, history
        self.asked: list[tuple] = []

    @property
    def options(self) -> tuple[str, ...]:
        self.asked.append(("options",))
        return ("2026-11-20", "2026-12-18")

    def option_chain(self, date: str) -> FakeChain:
        self.asked.append(("option_chain", date))
        assert self.chain is not None
        return self.chain

    def history(self, period: str, interval: str, auto_adjust: bool) -> FakeFrame:
        self.asked.append(("history", period, interval, auto_adjust))
        assert self._history is not None
        return self._history


def ticker_of(fake: FakeTicker):
    return lambda symbol: fake


def test_expirations_are_the_dates_yahoo_offers():
    fake = FakeTicker()
    assert yahoo.expirations("^SPX", ticker=ticker_of(fake)) == ["2026-11-20", "2026-12-18"]


def test_a_chain_carries_both_sides_labelled():
    fake = FakeTicker(FakeChain(FakeFrame(CALLS), FakeFrame(PUTS)))
    chain = yahoo.option_chain("^SPX", "2026-12-18", ticker=ticker_of(fake))
    assert fake.asked == [("option_chain", "2026-12-18")]
    assert (chain.symbol, chain.expiry) == ("^SPX", "2026-12-18")
    assert [r.side for r in chain.calls] == ["call"]
    assert [r.side for r in chain.puts] == ["put"]
    call = chain.calls[0]
    assert call.code == "SPXW261218C08100000"
    assert (call.strike, call.bid, call.ask, call.last) == (8100.0, 12.3, 13.1, 12.7)
    assert (call.volume, call.open_interest, call.implied_vol) == (42, 1234, 0.1821)


def test_a_figure_yahoo_has_not_got_is_none_rather_than_nan():
    # NaN propagates silently through arithmetic and prints as "nan" in a table; None does not
    fake = FakeTicker(FakeChain(FakeFrame(CALLS), FakeFrame(PUTS)))
    put = yahoo.option_chain("^SPX", "2026-12-18", ticker=ticker_of(fake)).puts[0]
    assert (put.bid, put.ask, put.volume) == (None, None, None)
    assert put.last == 1.05 and put.open_interest == 7


def test_a_chain_yahoo_answered_nothing_for_is_a_failure_not_an_empty_chain():
    fake = FakeTicker(FakeChain(None, None))
    with pytest.raises(RuntimeError, match="no chain"):
        yahoo.option_chain("^SPX", "2026-12-18", ticker=ticker_of(fake))


def test_one_side_present_is_a_chain_with_an_empty_other_side():
    fake = FakeTicker(FakeChain(FakeFrame(CALLS), None))
    chain = yahoo.option_chain("^SPX", "2026-12-18", ticker=ticker_of(fake))
    assert len(chain.calls) == 1 and chain.puts == []


def test_bars_pair_each_row_with_its_own_timestamp():
    index = ["2026-11-06 00:00:00-05:00", "2026-11-07 00:00:00-05:00"]
    fake = FakeTicker(history=FakeFrame(BARS, index))
    bars = yahoo.daily_bars("^SPX", period="5d", ticker=ticker_of(fake))
    assert fake.asked == [("history", "5d", "1d", False)]
    assert [b.date for b in bars] == ["2026-11-06", "2026-11-07"]
    assert (bars[0].open, bars[0].high, bars[0].low, bars[0].close) == (6700.0, 6750.5, 6690.0, 6740.25)
    assert bars[1].volume == 1_400_000


def test_a_frame_whose_index_and_rows_disagree_is_a_failure():
    # zip would pair what it can and drop the rest, which is the silence `zip(strict=False)` bought
    # in the golden harness: a bar would carry another day's date
    fake = FakeTicker(history=FakeFrame(BARS, ["2026-11-06 00:00:00-05:00"]))
    with pytest.raises(ValueError):
        yahoo.daily_bars("^SPX", ticker=ticker_of(fake))


class Absent(importlib.abc.MetaPathFinder):
    """yfinance is not installed, as far as the function under test is concerned."""

    def find_spec(self, name, path=None, target=None):
        if name == "yfinance" or name.startswith("yfinance."):
            raise ModuleNotFoundError(f"No module named {name!r}", name=name)
        # anything else: not ours to find, so the next finder on the path handles it


def test_asking_without_the_extra_says_what_to_install(monkeypatch: pytest.MonkeyPatch):
    """Every entry point, with the lazy `import yfinance` actually failing.

    Blocked rather than assumed absent: the extra may or may not be installed in whatever venv runs
    this suite, and a test that passed only because it happened not to be would say nothing here and
    reach the network there. Nothing is injected, so this is the real import path."""
    monkeypatch.setattr(sys, "meta_path", [Absent(), *sys.meta_path])
    monkeypatch.delitem(sys.modules, "yfinance", raising=False)
    with pytest.raises(ModuleNotFoundError):  # the blocker bites, or what follows proves nothing
        importlib.import_module("yfinance")
    for call in (
        lambda: yahoo.expirations("^SPX"),
        lambda: yahoo.option_chain("^SPX", "2026-12-18"),
        lambda: yahoo.daily_bars("^SPX"),
    ):
        with pytest.raises(ImportError, match=r"optionality\[yahoo\]"):
            call()


def test_nan_and_none_both_mean_absent():
    assert yahoo._number(float("nan")) is None
    assert yahoo._number(None) is None
    assert yahoo._number(3) == 3.0
    assert not math.isnan(yahoo._number(1.5))


def test_the_extra_the_message_names_actually_exists(monkeypatch: pytest.MonkeyPatch):
    """The literal above says WHICH extra; this says it is real.

    Found by a mutation: the message named `optionality[research]` after that extra had been renamed
    to `yahoo`, and the test above passed because it asserted the same stale literal. A message
    telling somebody to install something that does not exist is worse than no message — they run
    it, uv refuses, and the package looks broken rather than unconfigured.
    """
    monkeypatch.setattr(sys, "meta_path", [Absent(), *sys.meta_path])
    monkeypatch.delitem(sys.modules, "yfinance", raising=False)
    with pytest.raises(ImportError) as err:
        yahoo.expirations("^SPX")
    named = re.findall(r"optionality\[([a-z,]+)\]", str(err.value))
    assert named, f"the message names no extra at all: {err.value}"
    pyproject = tomllib.loads(
        (pathlib.Path(__file__).resolve().parents[1] / "pyproject.toml").read_text())
    declared = set(pyproject["project"]["optional-dependencies"])
    for group in named:
        for name in group.split(","):
            assert name in declared, f"the message names extra '{name}', which is not declared"
