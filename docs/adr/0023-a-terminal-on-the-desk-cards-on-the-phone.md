# 23. A terminal on the desk, cards on the phone

Date: 2026-11-10

## Status

Built. `/opt` has served the new page since the swap (#301, 2026-11-13), which deleted the old one;
what the swap dropped is recorded under "What the swap dropped" below. **Amended 2026-11-13: one
page, by the session** (last section): Live and Review merge into one page with no switch, and
what is fetched follows New York's session instead of a mode. That supersedes "Live and Review are
modes", REVIEW's own columns, the phone's Live and Review tabs and its one-holding pager, and the
clock's-mode consequence; it partly reverses #338's "closed holdings in REVIEW only" and re-keys
#354's rule from the mode to the session. The superseded text is kept below and marked; the
amendment is what binds, and it is built (#371–#375, the last on 2026-11-14), with the
corrections its build needed written into it and named there. Decided by the owner on 2026-11-09 and 2026-11-10, in the design session that
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
    the IV chart in the inspector; *(superseded 2026-11-13: one column set, and the charts sit in
    the inspector's history section — see the amendment)*
  - the **price map** (prototype C) is a desk panel: every spread on one shared SPX axis, a lane per
    expiry, spot as a line through them all, and a ±1σ band per lane. REVIEW keeps C's "where SPX
    was against my strikes" chart for a holding. *(superseded 2026-11-13: that chart is the third of
    a holding's history charts, in the inspector's and the phone sheet's history section, at every
    hour — see the amendment)*
- **On the phone, "B", cards:**
  - "needs you" as banners at the top;
  - one card per held spread, with a strike strip and a large P&L;
  - watchlist cards with progress toward their entry thresholds;
  - a bottom tab bar: Live, Review, Add, Settings; *(superseded 2026-11-13: Book, Add, Settings)*
  - REVIEW is one holding per screen, with its burndown as the main chart; *(superseded
    2026-11-13: the pager goes, and a holding's sheet carries its history)*
  - detail and add open as bottom sheets, closed by Back.
- **Parity:** anything that can be done in one arrangement can be done in the other. ADR 0008's
  phone parity holds; its "one design" does not.
- **Which arrangement:** the measured viewport width chooses it, B below about 900 CSS pixels and A
  above, and a per-device setting (cookie) can force either.
- **Columns:** A's columns are still fitted by measurement, never by breakpoints (ADR 0008).

### Live and Review are modes

*Superseded 2026-11-13 by "one page, by the session" (last section). Kept as the record of what
was built at the swap and why; none of it binds the page any longer, except that the session's
edges (09:30–16:15 New York) and "never hide a firing alarm" carry over.*

- **LIVE** is the session: detect and act, on the live poll as today (ADR 0010).
- **REVIEW** is after the close: understand. It reads the stored samples plus one asked-for batch
  when opened, and it does not poll.
- **Amended 2026-11-13 (#353):** a holding's history is available in both modes, read once on
  demand — open in REVIEW, a collapsed section in LIVE that reads the samples when opened; no poll reads them.
- **The default** follows the clock in `DISPLAY_TZ`, with a visible switch and an override.
- **Both modes** carry the "needs you" line and every fault. A review mode that hid a firing alarm
  would be a trap.
- **A holding's Levels in REVIEW** (decided by the owner on 2026-11-13, #354, option (b)): the needs
  line says no holding's Levels in REVIEW, because REVIEW values the holdings once on entering it
  rather than polling them (ADR 0012). That holds for the holdings and equally for a rule linked to
  one, whose `schedule` is the holding's and arrives on the `/quotes` REVIEW still polls: the line
  states none of them, and still says each rule's own alarm and every fault. Every Level chip of a
  holding, where one is drawn (Target, Stop, Manage-by: on its row, in the desk's inspector, on the
  phone's page and sheet, and in the saved picture), says instead when that valuation was made,
  from the time the service stamped on it: "at stop · as valued at 21:04". The note saying when the
  holdings were valued reads the same stamp, so the page states one clock for it. The chip and the
  line then cannot read as a disagreement. LIVE is unchanged: both read the same poll there, and
  the chip carries no time. *(Re-keyed 2026-11-13: the same rule, with "outside the session"
  where this says REVIEW and "in session" where it says LIVE.)*

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
  `/opt/`. The source stayed in `frontend/src/next/` until #363 moved it up into `src/`, a rename
  of its own. ADR 0005's "no client-side router" holds: modes and arrangements are state, not
  routes. *(Since 2026-11-13 there are no modes: arrangements are the only such state.)*
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
  is done in REVIEW's journal. *(Partly reversed 2026-11-13: with no REVIEW, the closed trades are
  a folded section at the bottom of the one book, shut by default and read only when opened. What
  stands is that the open book never mixes them in.)*
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
  each polled when open; two open tabs were two batches per poll (ADR 0010). The swap ended the
  two-page double polling, with two qualifications. Each LIVE tab now costs one market-data call
  more per poll than the old page did *(since 2026-11-13: each tab in session, and outside it one
  call per poll, `/quotes`)*: `/quotes`, `/references` and `/positions/values`, where the
  old page polled the valuation only while its Holdings panel was open. And a tab of the old page
  left open across the deploy keeps polling as before until it is reloaded.
- **The owner has to accept or override the clock's mode.** A desk opened at 21:00 Singapore time
  shows REVIEW until the session opens; the override exists for exactly that. *(Superseded
  2026-11-13: there is no mode to override. Before the open the page shows everything, valued
  once, and its refresh button re-values it.)*
- **The prototype branch will rot,** and that is intended: it answers "what should this look like"
  as of 2026-11-10 and nothing after.

## Amended 2026-11-13: one page, by the session

Decided by the owner on 2026-11-13, in a grilling session after a day of using the swapped page.

**Why.** Two modes were one concept too many, and the clock chose the wrong one at the times the
page is most used:
- the owner kept flipping between them: to LIVE in the evening for the value, Δ and SPX → short,
  and to REVIEW after the close for the pace gap;
- the clock opened the "wrong" mode, for instance REVIEW at 21:00 Singapore time, before the open,
  when the owner is getting ready for the session.

What differed between the modes that mattered was never what the page SHOWS but what it FETCHES,
and that follows the session, not a choice. So the page is one page, and the session decides
the fetching.

**One desk column set.** LIVE's columns plus the pace gap. They survive narrowing in this order:
value, P&L, Δ, pace gap, DTE, manage-by, SPX → short, captured, legs, rule — the rule's sentence
still last, as the widest (ADR 0008). "On pace" leaves the table for the inspector's figures, and
"DTE → manage-by" goes: DTE and manage-by are each a column already.

**Closed trades.** A folded section at the bottom of the book, shut by default, and read only
when it is opened — no poll reads it. This partly reverses #338's "closed holdings in REVIEW
only" (see "What the swap dropped"): there is no REVIEW to hold them, and the open book still
never mixes them in. Correcting or deleting a close is done from that section.

**Fetching follows New York's session** (09:30–16:15 New York, both ends included, weekends out,
holidays not detected: the same edges `inSession` and the daily sample use, ADR 0011):
- **In session,** everything refreshes as LIVE does today: `/quotes`, `/positions/values` and
  `/references` on every poll (ADR 0010).
- **Outside it,** the holdings and SPX's price are valued ONCE, when the page opens, and the page
  says so: "market closed — valued at HH:MM", with a refresh button
  that values them once more. The refresh is what the mode override was for, e.g. a desk opened
  just before the open.
  - *Corrected in the build (#371):* "once, when the page opens" is once per ASK, never by the
    poll. The page values the holdings and reads the References outside the session on opening,
    at each edge of the session (one slept through by a phone included: which session the page
    is in or after is tracked, not only whether), on either refresh button (the header's, and the
    one on the market-closed line), on opening Settings, and after every write the page makes. A
    valuation from before the session's last edge is dated ("valued at Sat 05:15"), so a time
    alone never reads as this morning's.
- **`/quotes` keeps polling in both,** so a rule's alarm and every fault always reach the page, as
  they did in REVIEW (ADR 0012). The bounded-call invariant is unchanged: in session this is the
  three calls per poll LIVE made; outside it, one per poll plus one asked-for valuation.
- **The Reference strip stays on screen outside the session, read once with the rest and labelled
  with its time** (the owner's choice of 2026-11-13), e.g. "SPX 7,592.40 · last at 16:15"
  *(built as "read at 16:15", dated when it is another day's, and "tried at" for a reading that
  came back empty; a reading with no stamp is not drawn outside the session at all, #371)*, from
  the service's own stamp on each reading; the same refresh button reads it again. REVIEW hid it
  because a figure frozen at entry would be read as current (ADR 0018). The time is what answers
  that here: outside the session no reading is drawn without one. After the close, the last
  close is the figure the owner wants, and hiding it would send them to another app for it.

**The needs-you line** states holdings' Levels only in session. Outside it, a Level appears only
on its chip, with "as valued at HH:MM": #354's rule (option (b) and its clarification), keyed by
the session instead of the mode. In session the chip carries no time, as LIVE's did. A rule's own
alarm and every fault show at every hour.

**The phone** has three tabs: Book, Add, Settings. The Review pager (one holding per screen) goes.
A holding's sheet opens its history section by default outside the session and shut in session.

**The desk's inspector** has its history section shut in session and open outside it, and its
charts are read once when the section opens, as #353 had them. "On pace" joins the inspector's
figures.

**No switch.** The Live/Review toggle, Settings' mode override and the palette's "switch mode"
action all go. Outside the session the refresh button covers what the override did; in session
there is nothing to switch to, because the page already shows everything.
- *As built (#375):* Settings drew no mode control by the time it was built — the override was
  the header's switch and the phone's Live and Review tabs — so what went from Settings was its
  mode wording. The saved picture's header, which said "live" or "review", says the session
  instead: "in session" or "market closed", by the same `inSession` the page fetches by.

**What this supersedes** (marked where it stands above, not deleted): "Live and Review are modes"
whole, with its #353 amendment folded into this one; REVIEW's column swap; the phone's Live and
Review tabs and its one-holding REVIEW; and the consequence that the owner must accept or
override the clock's mode. **What it re-keys:** #354's rule, from REVIEW to "outside the
session". **What it partly reverses:** #338's placement of closed holdings. ADR 0005's "modes are
state, not routes" survives with one fewer state.

CLAUDE.md describes the page as built: one page, the session deciding the fetching (its polling
invariant and the frontend's Layout entry), updated by each build issue as it landed and by #375
last.
