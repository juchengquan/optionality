# 31. The service holds the IBKR account while it is asked

Date: 2026-11-24

## Status

Accepted. Decided with the owner in the design session of 2026-11-24 (#476). Issue 1 of 3: the
library watch, built in both IB Gateway clients (#476). Holding it behind `GET /account` (#477) and
the page follow, and say what they add.

**Amends ADR 0019's "every call for market data is a single bounded one"** and **ADR 0030's one
bounded account read**, for the ACCOUNT ALONE: the account may now be HELD — its updates and its P&L
subscribed and kept — while something asks for it. Every other call stays bounded, and ADR 0019's "no
order message" stands, as do ADR 0030's masking, its constructed recordings and "nothing stored".

## Context

ADR 0030's read subscribes to the account's updates, waits for the download to end and unsubscribes.
What it shows is IBKR's own account update, which IBKR refreshes about every three minutes, or when a
holding trades — so the Account page, refreshed by the owner, showed marks minutes old. IB Gateway
can push more than that: `reqPnL` the account's daily, unrealised and realised P&L, and
`reqPnLSingle` one holding's, with its value. The premises the design session took: the account's
P&L is pushed about once a second, a holding's when its figures change; a holding's value and P&L are
in the holding's own currency, as the account read's are, and the account's P&L is in the base
currency.

The owner's decisions of 2026-11-24:

1. **What goes live**: the account's P&L, and each holding's value, P&L and mark. Net liquidation and
   cash stay on IBKR's own account-update push, with no figure estimated.
2. **Daily P&L** is carried, for the account and for each holding.
3. **One connection**: the service's one IB connection (`IBKR_CLIENT_ID`). Re-subscribing after a
   reconnect is the service's job (#477), not the client's.
4. **The account updates stay subscribed** while the watch is held, and the per-holding streams
   follow the holdings list.
5. **This record** amends the bounded-call rule for the account alone.
6. **Recordings are constructed**; no live capture is committed.

## Decision

**A watch, beside the bounded read**, in both clients: `IbkrClient.watchAccount(wanted?)` in
TypeScript, `async IbkrClient.watch_account(wanted=None)` in Python. It subscribes to the account's
updates (`REQ_ACCT_DATA`, subscribe true) and keeps the subscription, subscribes to `reqPnL` for the
account, and once the first download ends subscribes to `reqPnLSingle` for every holding by its conId.
It resolves with a handle on that first complete picture — under the bounded read's deadline and in
its words, its refusals included (`IbkrAccountRefused` for several accounts and none named, or one
named that is not on the login; `IbkrUnreachable` for a gateway it cannot reach). A start that fails
at the deadline cancels the P&L and unsubscribes on its way out; one whose connection closes before
the first picture fails in the read's words.

**The handle** (`IbkrAccountWatch`): `picture()`, the latest picture, a copy the caller may keep;
`lost`, set once when the connection closes under it; `onLost` / `on_lost`, told at once (or now, if
it has already happened); and `stop()`, idempotent: `cancelPnLSingle` for each holding's stream, then
`cancelPnL`, then the account updates unsubscribed. The gateway's 2100 after the unsubscribe is
expected, as for the bounded read.

**The picture** (`IbkrLiveAccount`) is the bounded read's answer — the account masked, `paper`, the
base currency, the update time, the totals and the exchange rates, all still the account updates'
— with `pnl`, reqPnL's last figures (null before it first speaks), and `pnl_at`, when it last spoke
by the client's clock. Each holding (`IbkrLiveHolding`) is the portfolio row with `daily_pnl` added,
and with its `market_value`, `unrealized_pnl` and `market_price` the stream's once the stream has a
figure for each: the mark is the stream's value over the position times the multiplier (none, as for
a stock, is one), per share. A figure the stream left unset leaves the row's; the row's realised P&L,
cost and position stay the row's. A holding a portfolio update names for the first time starts its
own stream; one whose position goes to zero stops its stream and leaves the picture — at the first
download as at any later update.

**Unset is none.** IB writes a figure it has not set as Java's `Double.MAX_VALUE`
(`1.7976931348623157E308`); it reads as no figure, as an empty field does — never as a number. The
mapping is pure, in `ibkr/fields.ts` (`pnlFrom`, `pnlSingleFrom`, `liveHolding`, `UNSET_DOUBLE`), ported
to `ibkr.py` and held in both directions by the vendor corpus.

**Lost, not repaired.** If the connection closes — the gateway goes, a price read fails and drops it,
or the client is closed — the handle says so at once and keeps its last picture. The client does not
reconnect or re-subscribe on its own: a watch is one subscription on one connection, and what to do
when it ends is the caller's.

**One account subscription per client.** IB allows one, so a watch waits for a bounded read that is
running; while a watch is held, a bounded read of the SAME account is answered from the watch's
picture and sends nothing (its own subscribe and unsubscribe would end the watch's), a read of
another account is refused, and so is a second watch. Such a read's answer is therefore the watch's
picture without its P&L — no zero-position rows, and the streams' figures where they have spoken —
rather than the account update's rows as sent; once the service holds the account (#477) it no
longer makes the bounded read, so nothing a person sees depends on that difference. A start whose
caller gives up (a Python caller cancelled) is abandoned as a failed one is: the P&L cancelled and
the account unsubscribed, or the watch stopped if it had already started.

**The wire**, at protocol 157 and above, where every field is present, as `ib_async` 2.1.0's
`client.py` and `decoder.py` and `ibapi` 9.81 have it, with no version field in any of them: out,
`REQ_PNL` 92 (reqId, account, a blank model code), `CANCEL_PNL` 93 (reqId), `REQ_PNL_SINGLE` 94 (reqId,
account, a blank model code, conId), `CANCEL_PNL_SINGLE` 95 (reqId); in, `PNL` 94 (reqId, daily,
unrealised, realised) and `PNL_SINGLE` 95 (reqId, position, daily, unrealised, realised, value). The
Python reads both incoming messages field by field in its own decoder subclass, because `ib_async`'s
turns an empty figure into 0. Neither client gains anything that could place, change or cancel an
order: `messages.ts` has none, and `no_trading.py`'s list is unchanged.

**Recordings constructed.** The conversations in `testdata/vendors/ibkr-gateway/` that watch the
account (`watch-*`) are built from the layouts above with invented figures and placeholder accounts,
and say so. A stream's figures are sent LATER than the request that started them: an exchange's
`later` replies go at a numbered step of the replay, and a picture is recorded after each step.
Every step ends with the account's P&L, and the replay's clock is a counter read once per P&L
message, so the replay knows the client has read a step when the clock has been read once for every
P&L sent — a condition, not a timer — and `pnl_at` in `expected/` counts P&L messages, never a wall
time. A watch's `before` steps are sent while its start still waits, the last ending with the
download end, so a P&L that arrives before the download ends is in the corpus too.

## Consequences

- ADR 0019's invariant gains its first standing subscription, and it is the account's: no market
  data is asked for (`reqMktData` is not used for the marks, and tick-by-tick is out of scope), and
  the watch is held only while something asks — when, and for how long, is #477's.
- A watch held for a long time sees every portfolio update IBKR pushes, so the holdings list follows
  trades as they happen; the totals still move only when IBKR's account update does, so the account's
  P&L and its net liquidation may disagree for up to the update's interval. The picture keeps them
  apart (`pnl` beside `totals`) rather than estimating one from the other.
- A holding closed and reopened in one session leaves the picture and comes back at the end of its
  order, with a new stream.

## The service's hold (#477)

Added by #477, which puts the watch behind `GET /account`. The owner's decisions of 2026-11-24:

- **Held only while asked.** The first `GET /account` starts the watch and waits for its first
  picture, and readers arriving meanwhile join that wait. Every read renews the hold and is answered
  from the picture in memory, with no IB call. The hold is released `ACCOUNT_HELD_FOR_MS` (90 s) after
  the LAST read: the watch is stopped and nothing is kept. The page's slowest refresh is a minute, so
  every refresh keeps it. The page is its only reader; the sweep, the alarms, the bot, the MCP door and
  the book never read it.
- **A failed start is remembered for 5 s** (`ACCOUNT_FAILED_FOR_MS`). While IB Gateway is down or
  logged out, the service tries to start the watch at most once in that time, whoever asks — a first
  start or a re-subscribe — and a read meanwhile is told what the last try came to.
- **A lost connection answers 502 at once**, "The connection to IB Gateway was lost", until the watch
  is back. The read that finds it lost does not wait: the re-subscribe runs in the background, one at
  a time, at the next read and whenever the client answers anything else. A lost watch is dropped,
  never stopped: the loss has already ended it here, so a stop would send nothing.
- **An unset total falls back to the account update's figure.** Once `pnl` has spoken, a total it
  leaves unset takes the account update's figure where there is one, as a holding's does
  (`liveHolding`); it is null only where neither has a figure. The account updates carry no daily
  P&L, so an unset `daily_pnl` is null.
- **`read_at` is when the service answered**, not when anything was read from IB Gateway; `live`
  says when `pnl` last spoke.
