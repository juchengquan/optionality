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
