"""The optionality service, in Python (ADR 0021): the standby backend beside the TypeScript one.

Empty for now. It will run the whole service — the sweep and its alarms, the database, the API the
dashboard calls and the bot — so that either backend can be the live one, one at a time.

Two lines it may not cross, held by its own suite rather than promised here:

* it imports only the PUBLIC modules of the `optionality` library — never a private `_` module,
  never `optionality.research`, which no golden case holds (ADR 0020), and never the library's
  source by path (`tests/test_library_boundary.py`);
* it places, modifies, cancels and exercises no order. The only place that may is a `trading/`
  module that does not exist until an ADR creates it (ADR 0021, Decision 8;
  `tests/test_no_trading.py`).
"""
