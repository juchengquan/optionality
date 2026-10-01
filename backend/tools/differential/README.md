# Differential checks against the Python

The rewrite is a faithful port (ADR 0009), and quotes are never persisted, so there is no recorded
history to replay and no way to run the two services side by side over a week. These scripts are
what stands in for that: they put the **same inputs** through both implementations and compare the
results exactly.

They are a porting tool, not a test suite. The Python goes away in phase 10 and these go with it —
so anything they find has to be written into `backend/src/**/*.test.ts` before the branch merges.
That is the whole point of running them.

## Two modes

```sh
make diff-api        # generated inputs: ~400 cases, ~10k compared values
make diff-api-live   # the owner's real positions and one live quote set
```

**Generated** (`gen_cases.py` → `run_py.py` / `run_ts.mjs` → `compare.py`) covers the shapes a real
watchlist produces and the awkward ones it does not: missing quotes, a field present but null, a
field absent entirely, every scope, a contract size of 0 or absent, strikes with fractions, both
spellings of a strike date, thresholds of zero and of 1e-9, directions and compare modes that are
neither of the two legal values.

It also carries a fixed grid of **instants** for days-to-expiry — the hours when New York's calendar
day and the owner's disagree, and the two mornings a year when the clocks move. Fixed rather than
`now()`, because a differential that reads the wall clock is one that flakes at midnight.

**Live** (`live_py.py` → `live_ts.mjs`) reads the real positions and fetches quotes ONCE, in one
process, then runs both implementations over that single snapshot. The one-process part is not
incidental: phase 0 reported a false disagreement by comparing a WebSocket read against a TCP
baseline taken half a minute earlier, and read ordinary market drift as a divergence. It is
read-only — nothing writes to the DB, and the OpenD call is the same bounded single call `/quotes`
and `/positions/values` already make.

## Comparison is exact, never approximate

Both sides do the same arithmetic in the same order on the same doubles, so a bit-for-bit match is
the only honest pass. `0.47499999999999987` on one side and `0.475` on the other is a divergence,
not noise — and tolerating it would have hidden every finding below.

## What it found that the tests did not

- **`positions_holding` was never ported at all.** It has no Python test, so porting test-by-test
  skipped it silently. Ported, and given the six tests the Python never had.
- **`threshold_fill` has exactly one assertion in 3,278 lines of Python test** (`fill == 50`), and
  it is what colours the imminent band on the dashboard. The monitor half of the domain was almost
  entirely unguarded; it now has eighteen tests, every expectation checked here first.
- **CPython's `sum()` is not a left-to-right addition.** Since 3.12 it carries a compensation term
  (Kahan–Babuška/Neumaier), so `sum([0.1, 0.2, 0.3])` is exactly `0.6` where a plain `reduce` gives
  `0.6000000000000001`. Three of four hundred cases diverged. The per-leg sums are unaffected,
  because Python accumulates those with a plain `+=` — so the port has to be naive in one place and
  compensated in the other.
- **`round()` rounds the stored double, not the decimal.** Half-to-even applies only to a genuine
  tie, so `0.005` goes up and `0.015` goes down. `Math.round(v * 100) / 100` destroys the precision
  that decides this and diverged on twelve values; `toFixed(2)` alone diverged on the exact halves.
- **`build_spx_code` accepted less than the Python did.** `date.fromisoformat` takes `20261016` as
  well as `2026-10-16` and rejects `2026-02-30`; the first port took one spelling and would have
  built a code for the 30th of February. `days_to_expiry` had the same bug, found the same way,
  after the first had already been fixed — which is the argument for a harness over care.
- **`contracts` was typed nullable** when the column is `Mapped[int]`, so the port carried a guard
  the Python has no equivalent of — dead code that would have diverged had it ever been reached.

## Verifying the harness itself

A comparison that cannot fail proves nothing. Every finding above was confirmed by breaking the
thing it guards and watching the count go up: the sign of a greek, the compensation term, the
rounding (both halves of it), the partial-sum rule, the scopes, the double-hold rule, the strike
truncation, the put/call letter, the leg signs, the IV guard, the exact-threshold breach, the fill
clamp, the fill ratio, the market date. **Twenty-four mutations, twenty-four caught** — by the
harness, and then by the committed tests.

Three of those were not caught on the first attempt, and each was a hole in the checking rather
than in the code:

- The generator never emitted `option_implied_volatility`, so the rule that combos must never sum
  it was never exercised. A missing field and a forbidden field look identical when both return
  nothing.
- The mutation runner ignored node's exit code, so a mutation that made the TypeScript *crash*
  left the previous output file in place and the comparison read clean. A silent pass from a run
  that never happened.
- `compare.py` assumed a list of cases and zipped the top level. Given the live run's single
  object it compared two key NAMES and reported "0 divergences over 2 compared values" — which is
  why it now prints the number of leaves it looked at, and takes a floor below which it fails.

That last one is the reason for the floor argument in the Makefile. A clean result and a result
from not looking are the same sentence unless the count is in it.
