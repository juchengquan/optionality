# 13. A Leg's Side is long or short

Date: 2026-10-17

## Status

Accepted. Decided with the owner on 2026-10-17. Reverses the wording #111 chose, not its aim.

## Context

Side has been worded three ways. Long/short on the add-combo form; sold/bought everywhere else,
which #111 (2026-10-14) made universal because two forms were using two words for one fact; and
now long/short again, everywhere.

The case for sold/bought was real: "long" and "short" also describe greek exposure — a short put
is long delta, an iron condor is short gamma and short vega — and this app reports exposure.
"The short put makes the position longer delta" is correct and is exactly the sentence that
produces a sign bug. sold/bought can only mean what happened to the Leg.

The owner chose the trading terms anyway, for less confusion where it is actually read: options
literature, broker statements and the trader's own head say "long a put", not "bought a put".

## Decision

- A Leg's Side is `long` or `short` — stored, sent by the API, shown on every form.
- sold/bought name the TRADES that open or close a Leg, and only those. Cost to close is "buy
  back the short legs, sell the long ones".
- Greek exposure is never described with these words. It is always a signed number (Δ −0.12), so
  "short" means a Leg and nothing else. This rule is what makes the reversal safe; dropping it
  brings back the ambiguity the previous wording existed to prevent.
- A combo you only watch labels its legs long/short too. #111's point — one word per concept on
  both forms — survives; only the word changed.

## Consequences

- Migration 0004 rewrites `positions.legs` through SQLite's JSON functions, not text replacement:
  rows that came across from the Python were written with a space after each colon.
- `LegOut` narrows `side` to the two values, so a stored leg that escaped the migration fails
  loudly instead of being served as a Side every figure would read as long.
- The API refuses `sold`/`bought` with a 422. There are no callers outside this repo.
- `backend/tools/copy-db` and the differentials still speak sold/bought. They compare against the
  Python, which phase 10 deletes; they are not updated.
