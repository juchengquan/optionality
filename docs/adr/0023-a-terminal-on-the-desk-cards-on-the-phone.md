# 23. A terminal on the desk, cards on the phone

Date: 2026-11-10

## Status

Built. `/opt` has served the new page since the swap (#301, 2026-11-13), which deleted the old one;
what the swap dropped is recorded under "What the swap dropped" below. Decided by the owner on 2026-11-09 and 2026-11-10, in the design session that
opened the redesign. It started from five research reports (commercial platforms, open source,
design patterns, an audit of the dashboard as it stood, and a map of what the backend can supply),
went through a grilling, and ended with a three-way prototype the owner tried on both screens:
"A on desk, B on phone", with C's price map "as a desk panel in A".

The prototype is the reference and not the code. It lives on the branch `prototype/ui-revamp`,
which is never merged.

This ADR amends four others:
- **ADR 0008:** one design at two sizes becomes two designs over one capability.
- **ADR 0012:** a quarantined rule joins the top line's inputs.
- **ADR 0007:** the triggered red is no longer the destructive red.
- **ADR 0003:** holdings lead the page.

## Context

The owner's words: the dashboard looks dated and ugly; every flow hurts; and there is no analysis
at all. The audit measured each complaint:

- **Entering a condor the owner's way** (two vertical combos and two short-leg delta rules) took 34
  clicks on the desk and about 40 taps on the phone, with 16 fields typed. Each expiry was typed
  three or four times.
- **Holdings and rules were two jobs.** Recording a holding and setting the rules that watch it were
  separate, and nothing created a holding first.
- **Editing was incomplete.** A rule's field, direction and compare could not be edited, although
  the API accepts all three.
- **A refused form looked like nothing happened**, because its error toast was drawn underneath it.
- **Targets were small:** most were 28px against a 44pt guideline.
- **Alarms were faint.** A ringing row's tint measured 1.20:1 against the page, fainter than the
  gridlines.
- **No charts existed**, although the daily samples were stored.

How it is used shaped the answer as much as what it shows:

- **When it is used:**
  - on a phone at night, during the US session (22:30–05:00 in Singapore in winter);
  - at a desk monitor during the session;
  - for a daytime review after the close.
- **The book is a ladder of vertical spreads across expiries,** not one condor at a time.
- **The watchlist and the holdings do different jobs.** The watchlist's alerts are ENTRY signals on
  candidate spreads ("worth selling now") and not risk. Holdings carry the risk: a stop on cost to
  close, the short leg's delta, and an exit schedule.
- **The owner rejected linking the two lists.** A candidate → held → closed lifecycle was offered
  and declined: they stay separate lists.

The research found three things nobody does, all of which this service can:
- a holding and its alerts made in ONE step (Option Alpha comes closest);
- a burndown against an exit schedule (nobody else has exit schedules);
- a read-only monitor of multi-leg spreads (the open-source field has no maintained one).

## Decision

### Two arrangements over one capability

- **On the desk, "A", a terminal.** One dense table, holdings first and then the watchlist, each
  grouped by expiry:
  - a condor's two spreads sit together, joined by a bracket;
  - a NON-MODAL inspector sits beside the table and stays open, so the table stays live while one
    row is studied (the old sheet blurred the page);
  - a ⌘K command palette, with j/k to move;
  - REVIEW swaps the columns to P&L, captured, pace and days to manage-by, and puts the burndown and
    the IV chart in the inspector;
  - the **price map** (prototype C) is a desk panel: every spread on one shared SPX axis, a lane per
    expiry, spot as a line through them all, and a ±1σ band per lane. REVIEW keeps C's "where SPX
    was against my strikes" chart for a holding.
- **On the phone, "B", cards:**
  - "needs you" as banners at the top;
  - one card per held spread, with a strike strip and a large P&L;
  - watchlist cards with progress toward their entry thresholds;
  - a bottom tab bar: Live, Review, Add, Settings;
  - REVIEW is one holding per screen, with its burndown as the main chart;
  - detail and add open as bottom sheets, closed by Back.
- **Parity:** anything that can be done in one arrangement can be done in the other. ADR 0008's
  phone parity holds; its "one design" does not.
- **Which arrangement:** the measured viewport width chooses it, B below about 900 CSS pixels and A
  above, and a per-device setting (cookie) can force either.
- **Columns:** A's columns are still fitted by measurement, never by breakpoints (ADR 0008).

### Live and Review are modes

- **LIVE** is the session: detect and act, on the live poll as today (ADR 0010).
- **REVIEW** is after the close: understand. It reads the stored samples plus one asked-for batch
  when opened, and it does not poll.
- **The default** follows the clock in `DISPLAY_TZ`, with a visible switch and an override.
- **Both modes** carry the "needs you" line and every fault. A review mode that hid a firing alarm
  would be a trap.

### The spread is the unit, and the two lists stay apart

- **Grouping:** spreads are grouped by expiry. A condor is two spreads on one expiry, or one 4-leg
  holding; both are supported, and the owner chooses per trade.
- **Adding a spread** creates it AND its two usual alerts in one step, each pre-filled and
  switchable before saving:
  - a holding: a stop at 2× the entry and the short leg's delta at 0.30;
  - a watched spread: its entry thresholds.
  - The form shows a live payoff at expiry, which catches a wrong leg sign before anything is saved.
- **Editing alerts:** every field of an alert is editable in place, beside a sentence that says it:
  "spread value ≥ 6.01 — now 2.00, 4.01 away".
- **Fired alerts:**
  - A fired ENTRY alert is good news and has its own "opportunity" style, never alarm red. A
    viewer setting can make it look the same as risk instead.
  - A quarantined rule is named in the top line as a fault. That changes ADR 0012's inputs, not its
    rule: the line still uses only what is already polled, and its silence is still not an all-clear.

### Colour, figures and charts

- **Three colour families:**
  - **Direction** (up/down) is the viewer's setting, green-up by default.
  - **Outcome** (P&L) follows the same setting.
  - **Attention** (alarm, warning, fault, entry) never flips, and never shares the "down" hue: it
    differs in lightness and shape too, a filled chip with a glyph.
  - The old palette made a ringing row and an error message the same red; a red-up viewer would
    have read both as the market rising.
- **Privacy:** a setting hides $ amounts and keeps %, Δ and DTE.
- **Figures:**
  - tabular numerals, with fixed decimals per field (gamma loses its six places);
  - dark first;
  - on the phone, 44px targets and 16px inputs, so iOS does not zoom.
- **Payoff at expiry only.** There is no T+0 curve, "today" line or probability until a pricing
  model exists, and that model is its own ADR: the backend map measured moomoo's IVs mispricing
  the far wings by 9–23% under a naive model. Never draw what the system does not know.
- **The burndown** draws the daily samples against the planned decay of ADR 0011. A point that is
  not a close (`observed_at`, ADR 0011's amendment) is marked as such.

### How it ships

- **Beside the old, then a swap.** The new dashboard was a second page in the same Vite build. It
  therefore went into the committed bundle and was served by the same Caddy on the same API, at
  `/opt/next`.
- **Slice by slice.** It was built in slices (#287 to #346) while the old dashboard kept working.
- **The swap.** When it covered everything the old one did, `/opt` swapped over and the old
  dashboard and its tests were deleted (#301, 2026-11-13): what went was listed beforehand in a
  test held to the import graph (#337), so the deletion was mechanical. `/opt/next` is kept as a
  page that sends a bookmark on to `/opt/`; it is a page and not a Caddy redirect because tailscale
  strips the prefix and rewrites no `Location`, so only the build, which knows `UI_BASE`, can name
  `/opt/`. The source stays in `frontend/src/next/` for now; moving it up into `src/` is a rename
  of its own. ADR 0005's "no client-side router" holds: modes and arrangements are state, not
  routes.
- **The prototype is rewritten, not promoted.** It was written without tests and against a static
  book.

## What the swap dropped

The old page did five things the new one does not, and the owner decided on 2026-11-13 (#338) that
each was dropped rather than ported:

- **The near-firing highlight** ("flag on" a reading, "flag above" a band): the fill bar already
  shows how close a rule is to firing. Its two preferences (`ui_signal`, `ui_band`) are no longer
  read.
- **Grouping by calls and puts, or not at all:** the page groups by expiry only (`ui_group` is no
  longer read).
- **Closed holdings in LIVE:** LIVE shows only what is open. Correcting or deleting an older close
  is done in REVIEW's journal.
- **A column picker on the phone:** cards on the phone, and the picker on the desk only. The desk's
  choice is still the `ui_cols_combo` cookie, so a choice made on the old page's combo table
  carried over.
- **Unmuting past expiry**, whatever muted the rule (#324).

One gap is known and deferred rather than dropped: a butterfly or a 1×2 ratio cannot be entered,
because the add form refuses the same contract twice and carries no quantity per leg. The old
page's combo builder allowed it through repeated legs. The owner put it after the swap (#351).

The add form was renamed with the swap, since it adds a single contract as well as a spread (#331):
the desk's `+` is "add", and its panel and the phone's sheet are "Add a spread or contract".

## What the data supports

From the backend map; each slice says which it needs.

- **Exists:**
  - the watchlist, its alerts and states;
  - holdings, their valuation, schedule, pace and levels;
  - closed holdings (ADR 0022);
  - References and health;
  - the payoff at expiry (legs and entry);
  - the per-leg delta, IV and vega of every sample (ADR 0011).
- **Exists but not served:** the daily samples. The burndown and IV charts need one read-only route.
- **Decided by ADR 0024:** SPX's price, live and in each sample (PR 3b, #288). It is derived from the batch's
  `option_premium`, and waits on a market-hours check against an independent price. The strike
  strip, the price map and the payoff's spot marker depend on it. They do NOT borrow the Reference
  strip's SPX, because a Reference is a figure nothing derives from (ADR 0018), and a dot placed
  against strikes, with its distance in points and σ, is a derivation.
- **Not stored:** an alarm log. Alert history is limited to what the samples imply until a
  migration adds one.
- **Out of scope here:** strike templates by delta (a chain call: a new bounded call and its own
  decision), broker-position import, and intraday history.

## Consequences

- **Two arrangements to build and test.** The browser suite measures both, at an iPhone profile and
  at desk width, as ADR 0008 required for one.
- **Double polling during the rollout.** While both pages existed, the old and the new dashboards
  each polled when open; two open tabs were two batches per poll (ADR 0010). The swap ended it.
- **The owner has to accept or override the clock's mode.** A desk opened at 21:00 Singapore time
  shows REVIEW until the session opens; the override exists for exactly that.
- **The prototype branch will rot,** and that is intended: it answers "what should this look like"
  as of 2026-11-10 and nothing after.
