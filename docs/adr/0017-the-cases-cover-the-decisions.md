# 17. The golden cases cover the decisions, not only the maths

Date: 2026-11-01

## Status

Accepted. Decided with the owner on 2026-11-01. Amends ADR 0014, whose scope was the domain's
pure maths and one of whose four reasons for refusing a second backend has expired. Reverses a
decision recorded in #185, which kept the alarm decision out of `domain/` on the grounds that
"the notebook package has no use for a Telegram sentence".

## Context

The owner asked whether the Python and the TypeScript can be kept at the same functionality. The
question has three readings and they lead to different places, so it was measured before it was
answered.

**What is already held.** `domain/` parity is airtight and better than it reads. `cases.test.ts`
asserts that the cased module list EQUALS the `domain/` directory listing — "the directory is the
fact", added after `domain/greeks.ts` could have been dropped in with no cases and no Python and
left every check green — that every exported function has a case, and that comparison is exact,
with cases landing deliberately on the `.5` boundaries where JavaScript and Python disagree. One
declared exception, `exit.exitPolicy`, with its reason.

**What is not held.** Of 46 public functions in the Python package, 36 are cased and 10 are not:
`api` (3, an HTTP client that mirrors no domain module — correctly outside), `quotes` (2) and
`opend` (1), which mirror TypeScript outside `domain/`, and `_js` (4), which mirrors JavaScript
itself. That last one is the foundation every exact comparison rests on, and it is the one thing
with no case of its own. Measured against real JavaScript on 2026-11-01, it diverges five ways:

    Math.round(-0.5)   js=-0        py=0        (JSON cannot carry -0)
    Number(null)       js=0         py=NaN
    Number("0x10")     js=16        py=NaN
    Number([])         js=0         py=NaN
    truthy([])         js=true      py=false

Every one is currently unreachable, because all six call sites guard `None` before calling
`number()`. The port is correct because its callers are disciplined, not because it is right,
and nothing states which subset it reproduces.

**What full service parity would cost.** Roughly 5,000 lines of Python source plus the tests —
the TypeScript carries 9,776 test lines for 8,117 of source, and a second alarm engine nobody
tested is not insurance but a second thing to be wrong. Against a package that is 1,071 lines
today, that is a tenfold growth.

One of ADR 0014's reasons for refusing it has EXPIRED and is recorded as such: the schemas no
longer diverge. The old Python's database was frozen at the 2026-10-02 cutover and archived, and a
port would read `backend/src/db/schema.sql` and the same five migrations. The other three stand —
one bot token allows one `getUpdates` consumer, one live database tolerates no second writer, and
switching is the rollback measured on 2026-10-15 as a trap.

A cost ADR 0014 did not record also stands against it: the frontend takes its types FROM the
TypeScript (`hc<AppType>`), which is what let ADR 0009 phase 8 delete `contract_version` and its
skew banner. A Python service behind the same dashboard brings runtime skew back.

**What a second implementation has already been worth.** `sweeper.ts` records that deleting an
expired monitor before its links raises `FOREIGN KEY constraint failed` inside the sweep, every
minute, stopping the alarm engine altogether — and that the fault was found by writing the second
implementation (#81). That is the case for this decision, from before anyone designed for it.

Alternatives considered and rejected:

- **A second service.** Measured above, and refused for the three reasons that remain.
- **Stopping at the maths.** What `domain/` holds today is the arithmetic; the bug class ADR 0014
  named is "correct in shape and wrong in what they decided", and the decisions sit outside
  `domain/` where no case can reach them.
- **A declared subset for `_js`.** Cases covering only what a quote field can hold, with the
  docstring stating the limit. Rejected: the module's name and docstring already claim to be
  JavaScript's rules, a partial reproduction that reads as total is the half-truth this codebase
  keeps hunting, and the next call site to drop its null guard would diverge silently.
- **A new case format for stateful replay.** Not needed, which is why this decision is cheap:
  each decision is `(state, input) -> (newState, action)` and the existing JSON — positional
  `args`, `$date`, `$set`, `$throws` — carries it.
- **`buildEntries` as well.** 213 lines that are mostly shape assembly, a twenty-field model the
  package would otherwise never need, and rows a notebook can already fetch from `/quotes`. The
  one piece where the cost is high and the behavioural payoff low. Deferred, not refused.

## Decision

- **`domain/` means everything pure and canonical, not only the maths.** `alarm.ts` moves to
  `backend/src/domain/alarm.ts`, where the existing guards force its cases and its port by
  themselves. #185's reason was a judgement about use and it was wrong: the notice IS the
  decision as communicated. `domain/` already held presentation — `displayTime`,
  `displayTimeShort`, `marketTimeToDisplay` — so this is the existing precedent, not a new one.
- **The Telegram wording is compared exactly**: the direction (`fell ≤` against `crossed ≥`), the
  recovery (`back above`, `back below`), the reminder suffix and the figure at three decimals. Two
  implementations agreeing on that string agree about far more than two agreeing on a boolean —
  and every alarm case then exercises `toFixed`, which nothing checked directly.
- `alarmPolicy` joins `exit.exitPolicy` in `NOT_PORTED`, for the same reason: it reads the
  service's Settings, and the package takes the knobs directly.
- **A new `backend/src/domain/js.ts`** exports the four JavaScript behaviours the port must
  reproduce — `mathRound`, `toFixed`, `number`, `truthy` — so they are cased like anything else.
  Wrapping `Math.round` in a module looks redundant for a second and then does not: it is the
  statement that these four behaviours are part of the contract.
- **`_js.py` is held at FULL fidelity**, not on a subset: hex, binary and octal strings,
  `Infinity`, the whitespace forms, `null` and arrays. `-0` is the one documented exception,
  because JSON cannot carry it and the cases are JSON.
- **Every decision the sweep makes becomes a pure function**: the silence/quarantine verdict over
  its in-memory count, and the expiry verdict over `strike_date`, today and the retention window.
  The sweeper keeps the IO — read the rows, call the fetcher, apply the changes, send the notices.
  This finishes the refactor #185 began for the alarm, and the cases fall out of it rather than
  being bolted on.
- **A second implementation is wanted; a second service is still refused.** Nothing here runs a
  sweep, writes the database or polls Telegram from Python.

## Consequences

- A third language can be held to the same files without touching the TypeScript. It needs four
  things and no new mechanism: the JSON decode and encode, the four primitives from `domain/js.ts`,
  a naming convention, and the domain port. Every behavioural decision the service makes is then a
  cased pure function.
- The cases stop being about arithmetic and start being about conduct, so the sentence the owner
  reads on their phone at 3am is under the same exact comparison as a rounding rule.
- `_js` becomes a real reproduction of JavaScript rather than one valid behind a guard, which
  removes the caller-discipline dependency that currently makes it correct.
- `domain/`'s own description must change wherever it is written down: it is no longer "pure maths
  that imports nothing outside itself" but everything pure and canonical, which includes the
  decisions and their wording.
- Deferred and worth revisiting once this is in: `buildEntries`, and the three remaining uncased
  mirrors (`quotes`, `opend`) whose TypeScript lives outside `domain/`.
