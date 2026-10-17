# 8. One adaptive layout, measured rather than guessed

Date: 2026-09-24

## Status

Accepted. Amended after use: the table's sideways swipe became a mechanism (last section).

## Decision

The phone gets **full parity** — everything, including building a six-leg combo — and the phone
and the desk get **one design at two sizes**, not two designs. This reverses two earlier refusals
to change the desktop layout, on the owner's call, which is why it is recorded.

- **Columns drop by priority.** Rows are watched on different fields, so no single column set
  serves every row; the fallback chain moves the fill bar and the bell to the alarm cell and then to
  the name when the watched column is hidden, so urgency survives down to two columns. Fitting
  **stops at the first column that does not fit**: skipping one and taking a narrower one further
  down made widening a window lose a column instead of gaining one.
- **The column picker is a wish list.** Width wins; ticking means "show this when there is room",
  and the picker only offers columns that could appear at the current width. Unticking still hides.
- **Operations move to a row detail sheet**, and the add-forms with them; a control belongs next to
  the thing it changes. The sheet shows every figure, including those the picker hides.

## Measured, not guessed

Columns are fitted by **measuring**, not by pixel breakpoints: a larger browser font or iOS Dynamic
Type changes what fits while the viewport stays the same, and no breakpoint survives that. So there
are two test suites, both in the default gate — jsdom for logic and interaction, and a small browser
suite (`@vitest/browser`) for what needs real layout. A check you have to remember to run does not
catch what nobody thinks to check by hand.

The browser suite must run the application's own styling and narrow the **viewport**, not the body.
It once did neither, and passed against unstyled markup that no media query ever answered to: a
test environment that differs from the application reports confidence it has not earned.

## Consequences

- A browser binary is part of running the tests (`make test-ui` fetches Chromium), never of
  deploying.
- The detail sheet pushes a history entry so the phone's back button closes it. It is not a router
  — no addresses, nothing shareable — and the entry must be consumed when the sheet closes any
  other way, or back silently does nothing once.

## Reversed after use: swiping is a mechanism, not a last resort

The design session rejected "the table scrolls inside its own box" as a scrollbar rather than a
design. Used for real, the sideways swipe proved perfectly usable, and the owner asked for more
figures on the page rather than fewer. So `SCROLL_BUDGET` lets the table be about two screens wide
before columns drop — the column budget every cell is held to, which is why anything wider than a
number (a date field, a form) lives in the detail sheet — and the identity column is
`position: sticky`, so a swipe never loses the row being read.

The swipe the owner liked existed only because a bug measured the combo column at a third of its
width; it is deliberate now. The same finding retired the second line inside a cell, which every
other figure would have had to earn: `legs` and `expiry` are ordinary columns that drop by priority.
