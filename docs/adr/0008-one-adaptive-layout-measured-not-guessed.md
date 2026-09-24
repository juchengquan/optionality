---
status: accepted
---

# One adaptive layout, measured rather than guessed

The dashboard is a thirteen-column grid of numbers with every cell set to `nowrap`, and
nothing wrapping it in a scroll container. On a phone the whole page — heading, status
strip and all — scrolls sideways across something roughly three times the screen. The
owner wants **full parity** there: not a reading view, but everything, including building
a six-leg combo.

Two earlier proposals to change the desktop layout were rejected on the grounds that the
live one was preferred. This decision reverses that, on the owner's call: the phone and the
desk get **one design at two sizes**, not two designs. It is recorded because a future
reader will otherwise find it contradicts the stated preference twice over.

## The shape that falls out

Full parity plus one design forces most of the rest.

**Columns drop by priority.** No single column set serves every row, because rows are
watched on different fields — half of this watchlist on `mid_price`, half on
`option_delta`. The existing fallback chain already moves the fill bar and the bell to the
alarm cell and then to the name when the watched column is hidden, so urgency survives all
the way down to two columns. That chain was built for the column picker and turns out to be
exactly what narrow screens need.

**The column picker becomes a wish list.** Width wins; ticking a column means "show this
when there is room". To stop that feeling arbitrary, the picker only offers columns that
could appear at the current width. Unticking still hides absolutely.

**The `actions` column disappears.** A number box and three buttons per row is hopeless at
any narrow width, and parity says the operations cannot go with it. They move to a row
detail sheet, which also fixes something long slightly wrong: the picker can hide `delta`
for every row, and there was no way to see it for one. The sheet always shows everything.

**The add-forms move into that same sheet**, and the combo's leg rows grow from two rather
than always drawing six. The fixed six were an htmx artefact — generating a variable number
of rows server-side was awkward — and that constraint left with htmx.

## Measured, not guessed

Columns are fitted by measuring, not by breakpoints. Breakpoints in pixels assume a fixed
text size: bump the browser font or let iOS Dynamic Type in, and the viewport is unchanged
while the amount that fits is not. A `640px` rule keeps showing five columns while three now
overflow, and no amount of re-tuning fixes the class of problem.

This was first argued the other way here, on the grounds that measurement cannot be tested
because jsdom has no layout engine. That was wrong — `@vitest/browser` runs tests against
real layout — and the argument was withdrawn once checked. It is the second soft constraint
stated as hard in this project's planning; the first was claiming Tailwind needed PostCSS.

The cost is a second test suite. jsdom keeps the fast tests — logic, interaction, request
payloads, a second to run — and a small browser suite covers only what needs real layout.
Both are in the default gate: the reason for choosing measurement was that it handles cases
nobody thinks to check by hand, and a check you have to remember to run does not do that.

## Consequences

- A browser binary becomes part of running the tests. Not part of deploying — ADR 0006 keeps
  node off that path and tests were never on it — but `make test-ui` on a fresh clone now
  fetches Chromium.
- The detail sheet pushes a history entry so the phone's back button closes it, which is how
  people dismiss things on a phone. This is **not** a router: no addresses, nothing
  shareable, and ADR 0006's baked base path is undisturbed. The entry must be consumed when
  the sheet closes by any other route, or back silently does nothing once.
- The sheet is modal to begin with. Non-modal would be nicer for comparing rows against each
  other and is a later improvement, not a starting point.

## Outcome

All six phases landed together. The measuring works as argued, and five bugs turned up that
the planning did not foresee — four of them found by tests rather than by reading.

**The fitting loop was not monotonic.** It skipped a column that did not fit and took a
narrower one further down the order, so widening a window by twenty pixels could swap one
column for another instead of gaining one — at 260px the name and delta, at 280px the name
and the alarm, delta gone. It stops at the first miss now, which is what "priority order"
should have meant. Found by a property test asserting that every column set is a subset of
every wider one.

**`cellValue` had no case for the identity columns**, because the JSX draws them specially
with their badge and bell. So the measurement asked how wide the widest column on the page
needed to be and was told `—`. One character.

**The hook used a plain ref**, and the table renders nothing until the first quotes arrive —
so the ref was null when the effect ran and the effect never re-ran once the table appeared.
Nothing was ever measured, and jsdom could not tell, because jsdom reports every element as
zero wide either way.

**The identity column is never dropped**, so a long enough contract name overflows alone
however well the rest fits. The table scrolls inside its own box as a last resort. That is a
safety valve, not the mechanism, and it is still better than the page scrolling.

**One test passed with its bug present.** The history-entry test asserted `history.length`,
which does not shrink when you go back and reports 1 in jsdom regardless. It watches for the
`history.back()` call now, which is the actual contract.

The width estimates written in phase 3 survive only as the default argument to `columnsFor`,
used before the first measurement lands. Nothing on screen depends on them.

## A browser suite that was not testing the browser

The layout suite shipped in phase 4 with two harness faults, both of which made it pass
against something that was not the application.

Its Vite config had no Tailwind plugin, so none of the utility classes existed. Every
measurement was of unstyled markup. And it narrowed `document.body` rather than the viewport
— which fixed-position elements ignore entirely, and which no media query ever answers to,
so the phone margin and the muted tables' narrow rule appeared covered while never having
been evaluated once.

Both were found by a misalignment the owner could see on screen and the suite could not.
That is the failure mode a browser suite exists to prevent, so it is recorded: a test
environment that differs from the application is worse than no test, because it reports
confidence it has not earned.

With both fixed, the suite immediately failed on a real overflow it had been hiding, and the
`.table-scroll` valve turned out not to be load-bearing at all until a test was written with
a name longer than the screen.
