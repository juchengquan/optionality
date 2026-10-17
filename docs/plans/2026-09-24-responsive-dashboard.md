# One dashboard, phone to desk

Six phases, a PR each. Reasoning in
[ADR 0008](../../adr/0008-one-adaptive-layout-measured-not-guessed.md).

Ordered so the detail sheet exists before anything depends on it, and so every phase leaves
the dashboard usable. Phases 1-2 change the desktop; that is intended (ADR 0008) and is the
part to look at hardest.

## Where it starts

- 13 single-leg columns, 11 combo, every cell `nowrap`, nothing in a scroll container — the
  **page** scrolls sideways, heading included.
- The viewport meta tag is already correct. That was never the problem.
- The combo form draws **six leg rows always**, ~24 controls, half of them empty for the
  combos actually in use.
- Rows are watched on different fields, so no fixed column set serves them all.
- `signalColumns` already walks watched → alarm → identity, so urgency survives to two
  columns without new machinery.

## Priority orders

What survives longest as the screen narrows.

**Single-leg:** `contract` (pinned) · alarm · delta · mid · dte · bid · ask · IV · theta ·
vega · gamma · last trade

**Combos:** `combo` (pinned) · alarm · value · P&L · entry · dte · delta · theta · vega ·
gamma

`delta` and `mid`/`value` outrank everything because every rule here is built on one of
them. `entry` sits against `P&L` because it is the number the P&L is computed from — if you
distrust the one you want the other beside it.

---

## Phase 1 — The row detail sheet, alongside everything

Additive. Nothing is removed and nothing moves.

Tapping a row opens a sheet from the right holding **every figure for that row regardless of
which columns are showing**, plus threshold, entry, rename, mute and delete. On a wide
screen it is a side panel with the table still visible; on a phone it fills the screen.

Modal to start. The `actions` column stays where it is for now, so the sheet can be lived
with before anything depends on it.

**Done when:** every operation is reachable from the sheet, and the greeks a hidden column
was concealing are visible there for a single row.

## Phase 2 — Retire the `actions` column

The controls live only in the sheet. `PROTECTED` loses `actions`, and the table gets
narrower on every screen.

This is the phase that changes the desk experience most: setting a threshold goes from one
click in the row to a tap and a click. Worth judging against a real session before phase 3
builds on it.

**Done when:** no row renders a control, and phase 1-3's mutation tests pass through the
sheet.

## Phase 3 — The fitting rule, without the measuring

A pure function — `columnsFor(availableWidth, ticked, priority)` — plus the priority orders
above and the picker's new meaning: width wins, ticking means "when there is room",
unticking still hides absolutely, and the picker offers only what could fit.

Fed a width that is always "plenty" for now, so nothing visibly changes. **The point of this
phase is that the rule is exhaustively testable in jsdom before anything measures anything**
— every width, every preference set, with no browser involved.

**Done when:** the function is covered at the widths that matter, including the degenerate
case where only the pinned column survives, and the fill bar's fallback is asserted at each.

## Phase 4 — Measure

A `ResizeObserver` on the table container feeds real width to phase 3's function. Columns
start dropping.

Brings `@vitest/browser` and a second, small suite: does the right set survive at 390px,
does a long contract name push one off, does doubling the text size reduce the count. Both
suites in the default gate.

**A fresh clone now downloads Chromium to run tests.** Not on the deploy path (ADR 0006),
but it changes what checking out the repo costs, and `make test-ui` should say so when it
happens rather than appearing to hang.

**Done when:** the table never causes the page to scroll sideways at any width, and text
scaling changes the column count without any breakpoint being re-tuned.

## Phase 5 — The add-forms move in

Both forms open in the sheet from buttons near the tables. The page becomes the watchlist;
creating things is somewhere you go.

The combo form starts at **two** leg rows with an "add leg" button up to six. The blank-row
filter stays as a safety net but stops being load-bearing — phase 1 of the shadcn rebuild
has a test pinning it either way.

**Done when:** a six-leg combo can be built at 390px, and the add-form tests pass with their
assertions untouched.

## Phase 6 — Back, muted tables, chrome

- `pushState` when the sheet opens, `popstate` closes it. **Consume the entry when the sheet
  closes any other way** — Escape, the X, tapping outside — or back silently does nothing
  once. That failure deserves a test, not a comment.
- Muted tables take the same priority mechanism and the same sheet.
- The heading, status strip, refresh selector, picker buttons and add buttons laid out to
  wrap sensibly rather than overflow.

**Done when:** back closes the sheet and only the sheet, and nothing on the page overflows
at 390px.

---

## Checklist

- [x] Phase 1 — detail sheet, additive
- [x] Phase 2 — retire the actions column
- [x] Phase 3 — `columnsFor`, tested in jsdom, nothing visible yet
- [x] Phase 4 — ResizeObserver + browser-mode suite
- [x] Phase 5 — add-forms into the sheet, legs grow from two
- [x] Phase 6 — back-to-close, muted tables, page chrome
