# Optionality

Watching SPX options positions during the US session and raising alarms when they move
against you. One trader, one account, one always-on machine.

## Language

**Position**:
An options structure you actually hold — its legs, how many contracts, and what you took in
or paid to open it. The thing a trader thinks in.
_Avoid_: holding, trade, structure

**Leg**:
One contract within a Position, together with the Side you are on. Legs belong to the Position,
never to a Monitor.
_Avoid_: option, contract (when you mean the leg rather than the instrument)

**Side**:
Whether a Leg was sold or bought. A fact about the Position, not a choice about how to add its
legs up — so it is never expressed as a +/- sign the trader picks.
_Avoid_: direction (that word means above/below on a Monitor), sign, long/short

**Cost to close**:
What it would cost right now to buy the Position back. Always positive for a credit structure,
and the single meaning of a Position's current value.
_Avoid_: combo value, signed sum, mid

**Entry**:
What you took in when you opened the Position, per contract. Quoted in points, like every other
price in the system.
_Avoid_: entry_price, premium, credit

**P&L**:
Entry minus Cost to close, across the contracts held. The one figure expressed in money rather
than points, because it is the one you act on.
_Avoid_: profit, return, pnl

**DTE**:
Days from today until a Position's or Leg's expiry. Always this abbreviation — the trader's unit
for how much time a structure has left.
_Avoid_: days to expiry, time to expiry, tenor

**Opened**:
The day you put a Position on. A different fact from the day you recorded it here, and the one
the decay maths needs — a Position entered at 45 DTE and told to the app a fortnight later has
an Opened of the earlier day.
_Avoid_: created, added, entry date (that last one invites confusion with Entry, which is a price)

**On-pace**:
What a Position's Cost to close would be at a given DTE if nothing but time had passed. A
REFERENCE, never a rule: it says whether a trade is working, and no alarm is ever raised from it.
_Avoid_: expected value, fair value, theoretical price, target

**Target**:
The Cost to close at which you take the profit, as a fraction of Entry. Flat in DTE — time does
not change what you are willing to accept, only whether you have got it yet.
_Avoid_: take profit, TP, goal

**Stop**:
The Cost to close at which the trade is over, as a multiple of Entry. Also flat in DTE.
_Avoid_: stop loss, SL, max loss

**Manage-by**:
The DTE at which a Position is dealt with whatever its P&L, because the risk of holding stops
being paid for. A deadline, not a level.
_Avoid_: roll date, close date, expiry (that word means the contract's own date)

**Monitor**:
A rule that watches one value and raises an alarm when it crosses a threshold. It watches
either a single Leg or the Position as a whole. A Monitor exists to warn, never to record what
you own, so it holds no legs of its own.
_Avoid_: watch, rule, alert, combo monitor

**Quote**:
Live market data for a contract. Always this word — moomoo's "snapshot" jargon stays out of
the domain.
_Avoid_: snapshot, tick, price data

**Sweep**:
One pass of the alarm engine: fetch quotes for every enabled Monitor, evaluate each threshold,
send what changed.
_Avoid_: poll, scan, refresh

**Alarm**:
The state of a Monitor whose threshold is currently breached, and the Telegram message sent
when that state changes.
_Avoid_: alert, warning, trigger
