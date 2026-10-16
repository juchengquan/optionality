# The OpenD client, against the Python SDK

```sh
make diff-opend     # needs OpenD up with its websocket enabled
```

The TypeScript client speaks **WebSocket** because the npm package speaks nothing else — the Python
SDK's TCP protocol has no JavaScript implementation. Phase 0 established that the two transports
agree, comparing the same contract within one second and finding 0 of 56 fields differing. This
checks the thing phase 0 did not: that the **mapping** from protobuf to the record the service reads
is right.

That mapping is the one place in the rewrite where a wrong name is silent. A missing `option_delta`
does not throw — it makes a monitor stop alarming.

## Bracketed, because the market moves while we look at it

The Python is read **before and after** the TypeScript read. A value that matches either bracket is
drift; one that matches neither is a divergence, and a volatile field that lands between the two
brackets is the same quantity a moment apart.

```
8 codes from the live watchlist
python: 8 snapshots in 0.02s
typescript: 8 snapshots in 0.10s
python: 8 snapshots in 0.02s
the three reads span 0.79s
0 divergences over 288 compared values (4 moved with the market and matched a bracket)
```

The codes come from the live database — every monitor's legs and every position's legs — rather than
being invented, because the mapping has to be right for the contracts the owner actually holds.

## The bracket has to be fresh

The first mutation sweep against this reported eight of eight mapping mutations caught. It was wrong.
The brackets were read once and reused across all eight, so by the end drift alone produced 49
divergences and four mutations were "caught" by nothing but the passage of time.

Re-run with a fresh bracket per mutation, **four of the eight survived**:

| mutation | live comparison |
|---|---|
| a greek read from the wrong source | caught |
| the market prefix dropped from the code | caught |
| the CALL/PUT enum inverted | caught |
| `prev_close_price` read from `curPrice` | caught |
| mid derived from one side instead of both | **not caught** |
| an int64's upper 32 bits ignored | **not caught** |
| contract size read from the multiplier | **not caught** |
| an absent field written as zero | **not caught** |

Each of the four is a case **live data never produces**: both quote sides are always present, SPX
volumes never exceed 32 bits, `contractMultiplier` and `contractSizeFloat` are both 100 for SPX, and
no consumed field is ever missing. They are covered by `src/opend/snapshot.test.ts` instead, which is
the honest division: the live comparison proves the field sources, the unit tests prove the edges.

This is the third time in the rewrite that a baseline going stale read as a divergence — phase 0
compared a WebSocket read against a TCP baseline half a minute older, and phase 4's copy verified
against a live file the sweeper was still writing to. A moving reference is the recurring mistake.

## What is mapped, and what is not

The Python SDK returns 143 columns, nearly all `'N/A'` or `None` for an option. `compare.py`'s
`CONSUMED` list names the 36 the service actually reads — the dashboard's columns, the bot's tables
and the domain's maths — and that list is in the file so a reviewer can see what the mapping claims
to cover. Transcribing a column nothing reads would be unverified either way.

## The connection is kept, where the Python's is not

`fetch_snapshot` opens a client, asks, and closes, every time. Over TCP that is cheap; over WebSocket
it is a handshake and a keyed login per sweep, for ever. So `OpendClient` holds the connection and
tears it down on **any** failure, so the next call reconnects. That keeps what the per-call version
got for free: a socket that has quietly died produces a failed sweep and a visible
`last_sweep_ok: false`, not a silent stream of empty batches.
