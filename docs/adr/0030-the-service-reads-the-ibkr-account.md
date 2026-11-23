# 30. The service reads the IBKR account

Date: 2026-11-23

## Status

Accepted. Decided with the owner in the design session of 2026-11-23 (#469). Issue 1 of 3: the
library read, built in both IB Gateway clients (#469). The endpoint (#470) and the page follow, and
say what they add.

**Supersedes ADR 0019's "nothing account-shaped"**: the IB Gateway client ADR 0019 built asked for
prices and nothing else, and the documents built on it said so in those words — the corpus README,
`messages.ts`, the Python port's docstring and its gateway test: "a quote fetch has nothing
account-shaped in it (ADR 0019)". That stays true of a quote fetch. The client as a whole now also
reads ONE account, read-only, and this record says how far that goes. Everything else in ADR 0019
stands, its "no order message" included (scoped to the TypeScript by ADR 0021, held in the Python by
`no_trading.py`).

## Context

The service reaches IB Gateway only for prices: References, and a Provider where the owner chooses
one. What is in the owner's IBKR account — every stock and option, IBKR's own mark, value and P&L
for each, and the account's totals — it cannot see. The owner's decisions of 2026-11-23:

1. **IBKR only**, not moomoo's trade context.
2. **One IB Gateway**, logged in to the live account on 4001 with its **Read-Only API** switch on,
   shared with the price feed (`openVendors` opens each vendor once; one connection per client id).
3. **reqAccountUpdates**: one bounded read showing IBKR's own marks, so no market-data subscription
   is needed per holding.
4. **Nothing stored.**
5. **No trading** through the API, now; trading later needs a decision record of its own.
6. **Several accounts**: a new `.env` setting, `IBKR_ACCOUNT`, names which, and with it unset the read
   refuses rather than guessing (read by the backends in #470).
7. **The account id is masked everywhere.**
8. **Recordings are constructed**: the repository is public, so the real capture never leaves the
   owner's machine.

## Decision

**Read-only, with two locks.** No message that could place, change or cancel an order exists in
either client: `messages.ts` gains reqAccountUpdates and nothing else, and the Python sends exactly
what the TypeScript sends, on `ib_async`'s `Client`, its order calls refused anywhere in the package
by `no_trading.py`'s list, which needs no exemption for this. IB Gateway's Read-Only API switch is
the second, independent lock. Reading an account is not trading it.

**The messages**, encoded and read as `ibapi` 9.81 does at protocol 157 (the rule `messages.ts`
states for every layout): out, `REQ_ACCT_DATA` (6) — subscribe with the account code, then the same
with subscribe false; in, `ACCT_VALUE` (6), `PORTFOLIO_VALUE` (7, version 8), `ACCT_UPDATE_TIME` (8),
`ACCT_DOWNLOAD_END` (54), and `MANAGED_ACCTS` (15), which arrives with every handshake and was
ignored until now. They carry the account's name and no request id, so the read is routed by account
rather than through the per-id `waiting` map.

**One bounded read**, `IbkrClient.account(wanted?)` in both languages: subscribe, collect until the
download's end, unsubscribe, answer. A deadline — the client's `requestTimeoutMs`, as for a quote —
fails it with its own words, and the unsubscribe is sent on that path too. IB allows one account
subscription per client at a time, so a second caller for the same account while a read runs JOINS
it; a caller for another account waits for it to finish, then takes the connection — and chooses
the account — afresh, since the read it waited on may have ended because the connection went. A
read whose connection goes fails at once, in its own words, rather than at its deadline. Never asked by the sweep, nor by anything
on a timer: it is read when asked for (#470), over the price feed's connection and client id.

**Which account**: the login's only one; of several, the one `wanted` names; refused, with the ids
masked, where several are managed and none is named ("several accounts on this login; set
IBKR_ACCOUNT to one of …") or where the one named is not on the login. A refusal is its own error
(`IbkrAccountRefused`), a fact about the configuration rather than the gateway's health, and it
sends nothing.

**Masked**: the account id leaves the client only masked — its leading letters and its last three
characters kept, every character between replaced by `•` (`U1234567` is `U••••567`, `DU1234567`
is `DU••••567`; the owner's decision on #469: the letters say what kind of account, the last three
which one) — in the answer, every error and every log line. At least one character after the
letters is always hidden, so a short id shows at most all but one of its last three (`U001` is
`U•01`, `U1` is `U•`), and an id that is letters through and through has no prefix kept: neither
rule can ever show an id whole. `paper` says
whether it is a paper account (an id that starts `DU`).

**The answer**: the masked account, `paper`, the base currency (the one NetLiquidation is sent in);
`updated_at`, ACCT_UPDATE_TIME as sent — a time of day with no date; the totals NetLiquidation,
TotalCashValue, UnrealizedPnL and RealizedPnL in the base currency, each from its `BASE` row where the
gateway sends one and otherwise from its row in the base code; and every PORTFOLIO_VALUE row as a
holding, in its own currency, its average cost PER SHARE (IB's `averageCost` includes the
multiplier). The mapping is pure, in `ibkr/fields.ts`, ported to `ibkr.py` and held in both
directions by the vendor corpus.

**Nothing stored**: no table, no column, no sample. The read answers and is gone.

**Recordings constructed, never captured into the repository**, and `parseConversation` refuses a
conversation that reads the account and says it was recorded. The conversations committed in
`testdata/vendors/ibkr-gateway/` are built in ibapi's layout with invented symbols, quantities,
prices, totals and placeholder accounts, each saying so in its `provenance`. A capture from the live
gateway, run by the orchestrating session with the owner's go-ahead on a client id that is not the
service's, is kept on the owner's machine only long enough to learn the exact layout and the
`ACCT_VALUE` keys and currencies, then deleted. `recordings.test.ts` refuses any account id but the
placeholders, in every message that carries one.

## Consequences

- The market-data invariant gains no call: an account read asks for no market data. Its marks are
  IBKR's, refreshed at IBKR's pace (a faster source for them is a later decision, once that pace is
  measured).
- A holding closed today can arrive with a position of 0 and its realised P&L; the read keeps every
  row as sent, and what a page shows of it is the page's decision.
- Python reads the account messages field by field rather than through `ib_async`'s readers, whose
  PORTFOLIO_VALUE drops a whole row over one empty figure; `ib_async`'s DEBUG log writes every wire
  field, the account id included, which is one more reason the Python backend holds every library at
  WARNING.
