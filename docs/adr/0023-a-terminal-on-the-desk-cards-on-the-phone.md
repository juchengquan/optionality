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
corrections its build needed written into it and named there. **Amended 2026-11-14 (#380):** outside
the session the holdings are valued from their latest close, by the service, and the market-closed
line names that close. **Amended 2026-11-15 (#394):** the saved picture is one plain table, from
the desk and the phone alike, and "Copy as text" puts the same table on the clipboard as Markdown
(last section), with fewer, shorter columns and the watchlist's value as a price at every hour
(#400, its last subsection). **Amended 2026-11-15 (#402):** a watched row has a history, and a
holding's burndown carries the days it was watched (last section). **Amended 2026-11-15 (#405):** the add
form's rules, and the Monitor editor's, choose their direction with a ≥ / ≤ pair, and a held debit
spread's value rule starts at ≤ (last section). **Amended 2026-11-15 (#408):** the add form keeps
what is typed between Watch and Hold, says on each choice what it does, and "Record as held" opens it
prefilled from a watch rule, replacing #336's "I hold this" (last section). **Amended 2026-11-15
(#410):** one refresh button, the header's; the header is held at the top of the screen on both
arrangements, and on the phone carries Add and Settings, whose tab bar is retired; on the phone
Settings is a bottom sheet over the book like Add's (last section). **Amended 2026-11-16: one
format and one vocabulary, first half** — every figure written by one formatter, each row kind's
figures in one order, Δ said three ways, Greek labels never in capitals, and the saved view's tables
per section (its section). **Amended 2026-11-16: one vocabulary, second half** — every clock with its
zone and every date in prose or compact, "rule" for "Monitor", sentence case and one order of
actions, one set of words for why a rule is off, ONE section order for the inspector and the sheet,
the phone's cards saying what the desk's rows say, the payoff's maximums said once, and errors in
plain words. **Amended 2026-11-17: each thing said once** — a description that repeated its
title, or a sentence said twice on one screen, removed or shortened, and the fill bar removed in
favour of the rule's arrowed distance (last section). **Amended 2026-11-17: one book** — holdings
and watches together under each expiry, held spreads first, a "held" tag, a holding's own rule on
its row; it supersedes "holdings first and then the watchlist" on every surface and the saved
picture's Holdings and Watchlist sections (last section). Decided by the owner on 2026-11-09 and 2026-11-10, in the design session that
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
  and declined: they stay separate lists. *(2026-11-17: they are still not LINKED — a watch rule
  is no holding's — but they are drawn as one book by expiry, a holding told apart by its "held"
  tag; see the last section.)*

The research found three things nobody does, all of which this service can:
- a holding and its alerts made in ONE step (Option Alpha comes closest);
- a burndown against an exit schedule (nobody else has exit schedules);
- a read-only monitor of multi-leg spreads (the open-source field has no maintained one).

## Decision

### Two arrangements over one capability

- **On the desk, "A", a terminal.** One dense table, holdings first and then the watchlist, each
  grouped by expiry *(superseded 2026-11-17: ONE book, each expiry once with its held spreads, its
  watched spreads and its lone contracts under it — see the last section)*:
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
  - watchlist cards with progress toward their entry thresholds; *(superseded 2026-11-17: no bar —
    the rule's arrowed distance says how close)*
  - a bottom tab bar: Live, Review, Add, Settings; *(superseded 2026-11-13: Book, Add, Settings;
    and 2026-11-15, #410: no tab bar — Add and Settings are buttons in the sticky header)*
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
  *(Amended 2026-11-14, #388: the page DRAWS every rule in a short form with symbols —
  "|val| ≥ 6.01   2.00  ↑4.01", "|Δ| ≥ 0.20   −0.250  ▲ past 0.050", "close ≥ 9.44   3.05  ↑6.39",
  "|val| ≥ 5.51   —  last 3.05 Fri 16:14" — on the desk's rule column, the phone's cards and sheet,
  the inspector and the editor, whose draft is the short rule as typed. The sentence above stays,
  as each one's hover title and what a screen reader hears. Fields are `val` (a spread's price),
  `mid` (a contract's), `Δ Γ Θ ν` and `IV` — `value` for both prices since #404, below; vega is
  `ν`, not `V`, which would read as a value. The arrow points the way the figure — its size, under
  `abs` — must move to reach the threshold; `▲`/`▼` mark it at or past. The words are the
  domain's (`alarm.ts`'s `ruleShort`, `figureShort`, `distanceShort`), which Telegram's messages
  use too, and the page's copy is held to their golden cases.)*
  *(Amended 2026-11-15, #404: ONE vocabulary. A price is `value`, a spread's and a single
  contract's alike — `val` and `mid` are gone — in the short form, on screen and in Telegram
  ("|value| ≥ 4.51   2.10  ↑2.41"), AND in the sentence, which now uses the short form's words:
  the Greeks as `Δ Γ Θ ν`, the threshold to the short form's places, every minus the real one —
  "|value| ≥ 5.51 — no figure", "|Δ| ≥ 0.20 — now −0.087, 0.113 away". A held credit's stop keeps
  its own words, `close ≥` short and `cost to close ≥` in full. The sentence's field words
  (`needs.ts`'s `fieldWords`) are held to the domain's golden cases with the short form's, and
  where a quarantined rule's sentence is now its short line, the desk draws it once, with no title
  repeating it. The inspector's figures are labelled in the same words — `value`, `Δ Γ Θ ν` — where
  they were `spread value`, `γ`, `θ` and `vega`; a contract's `mid` beside its bid and ask stays,
  being a quote's and no rule's. The palette still finds a rule by the field's spoken name,
  "delta" or "price", and a spread's by "spread".)*
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
  - *(A fourth family, for what a leg IS — its type — since 2026-11-14 (#391): see the amendment
    at the end.)*
- **Privacy:** a setting hides $ amounts and keeps %, Δ and DTE. *(Amended 2026-11-15, #395: it
  hides dollars and anything across the contracts held, and keeps points per contract — so the
  burndown's axis, Levels and crosshair readout say the per-contract Cost to close, plan and pace
  gap in points, as the table's value column, the inspector's Entry, Target and Stop and the payoff
  already did.)*
- **Figures:**
  - tabular numerals, with fixed decimals per field (gamma loses its six places); *(Amended
    2026-11-16: one formatter, `shared/numbers.ts`, and the true minus on every negative — see the
    last section.)*
  - dark first;
  - on the phone, 44px targets and 16px inputs, so iOS does not zoom.
- **Payoff at expiry only.** There is no T+0 curve, "today" line or probability until a pricing
  model exists, and that model is its own ADR: the backend map measured moomoo's IVs mispricing
  the far wings by 9–23% under a naive model. Never draw what the system does not know.
- **The burndown** draws the daily samples against the planned decay of ADR 0011. A point that is
  not a close (`observed_at`, ADR 0011's amendment) is marked as such. *(Since #395 the IV chart
  beneath it shares its crosshair: a day pointed at in either is crossed in both, each with its
  own readout. Amended 2026-11-17, #430: the history is TWO panels, the burndown and the IV
  chart. A third, "SPX against the strikes" — SPX each day against the holding's strikes, with
  each short strike's distance in points and σ — was removed by the owner's decision, and #431
  stopped the samples routes serving each day's `short_strikes`, which only it read. Each day
  still carries `spx`; the strike strip and the price map, which read today's, are unchanged.)*

### How it ships

- **Beside the old, then a swap.** The new dashboard was a second page in the same Vite build. It
  therefore went into the committed bundle and was served by the same Caddy on the same API, at
  `/opt/next`.
- **Slice by slice.** It was built in slices (#287 to #346) while the old dashboard kept working.
- **The swap.** When it covered everything the old one did, `/opt` swapped over and the old
  dashboard and its tests were deleted (#301, 2026-11-13): what went was listed beforehand in a
  test held to the import graph (#337), so the deletion was mechanical. `/opt/next` was kept as a
  page that sent a bookmark on to `/opt/` (a page and not a Caddy redirect, because tailscale
  strips the prefix and rewrites no `Location`, so only the build, which knows `UI_BASE`, can name
  `/opt/`), until the owner had it removed on 2026-11-14 (#364); `/opt/next` now falls through to
  the dashboard like any unknown path. The source stayed in `frontend/src/next/` until #363 moved it up into `src/`, a rename
  of its own. ADR 0005's "no client-side router" holds: modes and arrangements are state, not
  routes. *(Since 2026-11-13 there are no modes: arrangements are the only such state.)*
- **The prototype is rewritten, not promoted.** It was written without tests and against a static
  book.

## What the swap dropped

The old page did five things the new one does not, and the owner decided on 2026-11-13 (#338) that
each was dropped rather than ported:

- **The near-firing highlight** ("flag on" a reading, "flag above" a band): the fill bar already
  shows how close a rule is to firing. *(Superseded 2026-11-17: the fill bar is gone; the rule's
  arrowed distance, `↑1.31` (#388), is what shows how close — see "each thing said once".)* Its two preferences (`ui_signal`, `ui_band`) are no longer
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
    one on the market-closed line — *retired by #410: the header's is the one there is*), on opening Settings, and after every write the page makes. A
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

**The phone** has three tabs: Book, Add, Settings. *(Superseded 2026-11-15, #410: no tabs — Add and
Settings are header buttons, each opening a bottom sheet over the book.)* The Review pager (one holding per screen) goes.
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

## Amended 2026-11-14: outside the session, the latest close (#380)

Decided by the owner on 2026-11-14 (#380), after the first evening of the one page: valued once
outside the session, the book read **0.00** "at target" with 100% captured, because moomoo quotes
every option bid 0 / ask 0 out of hours. The first part of #380 made such a quote no price at all,
so the same valuation became dashes. This part says what the page shows instead.

- **The service values it, not the page.** Outside New York's session (`inSession`, the domain's,
  with the page's edges: 09:30:00–16:15:00, weekdays, no holidays) `/positions/values` and the bot's
  `/holdings` value each holding from its **latest close**: the latest daily sample with a Cost to
  close taken in 09:30–16:15 New York; where none was, the latest with a cost of any timing, its
  timing stated (F6); and where none has a cost, live as before — a dash out of hours, never a 0.
  Only the holdings valued live are asked for, so the usual evening valuation makes no market-data
  call at all. **And where that call fails** (#387, 2026-11-14), outside the session only, it costs
  only the holdings that needed it: each is a dash with `valued_reason` (the 502's own words, "moomoo
  call failed: …"), and the rest are served from their closes, where it had been a 502 for the whole
  book. In the session a failed call is still the 502 the page reports.
- **What it carries.** The answer gains `valued_from` (`live` or `close`), `valued_on` (the
  sample's market day) and `valued_timing` (its `valuedTiming`: `sampleTiming`, except that a row
  observed on a weekend, by New York's date and at any hour, is `weekend` — never `close`, nor
  "after the close" of a session that day did not have — the same weekday test that chooses the row,
  #387). Its `fetched_at`, the stamp every
  Level chip and the market-closed line read (#354), is the sample's observed time. P&L uses the
  contract size each sample now stores (F3, migration 0013; earlier rows have none, so their P&L
  is a dash). Levels, the schedule and the pace use the sample's own DTE (F5); the holding's DTE and
  manage-by are today's. Delta and vega are the legs' stored ones, strike distances use the stored
  SPX and IVs, and gamma and theta, which no sample stores, are dashes.
- **The words.** The market-closed line names the close on New York's clock, since the close is
  New York's: "market closed — as of the close, Fri 13 Nov 16:14", a reading that is not a close as
  "as of Fri 13 Nov 20:30, after the close", then how many holdings were valued from another row and
  how many had none ("1 with no close, valued live" — or "1 with no close, and the Provider could
  not be asked", #387). A weekend's reading is said by its time alone, "as of Sat 14 Nov 11:00"
  (#387). A chip from a close says "at target · as of
  the close" and no time, so the page still states one clock for a valuation. The bot keeps its
  four columns and adds the same line under the table, outside the session only.
- **The watchlist** has no samples to fall back on (F8). The service serves its dash; the page puts
  the rule's last reading from `/monitors` beside it, with its time on New York's clock, as the
  market-closed line says the close — "no figure out of session; last 3.05 at Fri 13 Nov 16:14" —
  so the page states one clock for the close; and only a reading taken IN the session: one read outside it may be the
  0 a 0/0 quote stored before #380, and nothing else tells the two apart.
- **The manage-by notice**, sent once, waits for a cost rather than going without one, and says
  the cost the page and the bot say (#387): the sweep's batch in the session, and outside it the
  latest close, named in it, even where the batch prices the holding overnight. The wait is bounded: once a whole
  weekday session has closed since the holding entered its window with still no cost, it goes
  without its "now" line, as before, and is stamped.
- **A close is a weekday's.** A row counts as a close only if it was observed in the session — a
  weekday's 09:30–16:15 — so a priced Saturday-noon row (possible where a Provider quotes at the
  weekend) never beats Friday's close; it is at most the fallback, stated by its timing — as a
  `weekend` reading, never as a close (#387).

The page's refresh still values the book once more; outside the session that now re-reads the
latest close, which changes only after the next session.

## Amended 2026-11-14: a fourth colour family, for what a leg is (#391)

Decided by the owner on 2026-11-14 (#391), choosing variant D of a prototype (branch
`prototype/leg-colours`, never merged). Every pair on the add form had been the same grey control,
the chosen one turned white, so a leg entered as the wrong type was easy to miss until the payoff
looked odd.

- **Type, by hue.** CALL is teal (oklch hue 195), PUT orange (hue 50 on the light ground, 55 on
  the dark), `--call` and `--put` beside the other families in `next.css`, in both schemes. A type
  is not a direction: neither flips for a red-up viewer. The hues sit away from direction's red
  (27) and green (150) and from attention's magenta, violet and blue; PUT's orange lies between red
  and the warning's amber, and differs from the warning by shape, since a warning is a filled chip
  with a glyph and a type is a letter or a tinted button. The values: light `oklch(0.49 0.1 195)`
  and `oklch(0.52 0.15 50)`, dark `oklch(0.74 0.11 195)` and `oklch(0.76 0.14 55)` — the
  prototype's light ones darkened, because at 0.52 and 0.58 a letter fell under 4.5:1 on the
  palette's selected option and an unchosen type button's words on their own tint.
  - **Readable where drawn.** The browser suite holds every type letter and every type button at
    4.5:1 against the ground it is actually composited onto, in both schemes: a calm row, a
    selected row and a row tinted for attention, the inspector, the palette's selected option, a
    phone card in any state, and the add form's tints and solid fills over the panel or the sheet.
    At these values the narrowest is the palette's selected option on the light ground, 4.69:1.
  - **Apart from the other families**, held as the attention family's ≥ 0.15 is, by OKLab distance
    in both schemes: CALL from PUT ≥ 0.23, CALL from entry's blue ≥ 0.07, CALL from green (gain,
    in either direction setting) ≥ 0.10, PUT from red (loss) ≥ 0.085, PUT from the warning's amber
    ≥ 0.11. The floors sit at the values chosen (light: 0.24, 0.075, 0.12, 0.088, 0.12; dark:
    0.24, 0.23, 0.10, 0.10, 0.12), lower than the attention family's because a type is never a
    chip: it is told from them by shape and place as well as hue, so a floor here stops a drift
    rather than proving a glance.
- **Side, by weight and a sign — never a hue.** A short leg is solid and bold with a "−", a long
  one outlined (dashed on the add form) with a "+". Variants E and F gave the side a hue as well;
  they were tried and not chosen. The wheel is already crowded by three families, every hue left
  for a side sat near one of them, and the sign already says the side wherever a leg is written.
- **The add form.** A leg's type button is tinted in its type (12% fill, coloured text and
  border); of the one contract's PUT/CALL pair, the chosen one is solid, with the page's ground as
  its ink. The side buttons carry the sign and the weight, in no hue. The mode pairs ("a spread" /
  "one contract", "I hold it" / "Watch it") stay the neutral control.
- **Across the book**, every place that writes a leg draws it through one component
  (`shared/Legs.tsx`): its C/P letter — or the word, in the inspector's "short PUT 7150" — in its
  type's colour, and a short leg bold. That is the desk's legs column and inspector, the phone's
  cards and sheet (and their short Δ, where a holding has more than one short leg to name), the
  palette, the closed trades, the strike strip's caption, the price map's
  labels and band label, and the leg names of the IV and SPX charts. The colour goes where the
  letter is drawn; figures, P&L and the attention chips are untouched.
- **The rule for a written leg:** a leg named beside its figure is coloured (a legs column, a
  card's legs, `P6300 Δ −0.250`, `±1σ 401 pts · P7150's IV`); a leg named inside a sentence is not
  (the overlap notes, "contains 1231_7700's C7700"), since a coloured word mid-sentence reads as a
  link or a warning rather than as what the leg is.
- **Colour is never the only signal.** Every place keeps its letter and its sign, character for
  character, and privacy is unaffected.

## Amended 2026-11-15: the saved picture, one plain table (#394)

Decided by the owner on 2026-11-15 (#394). The saved picture (#300) drew the page as it stood: A's
table with its chips, fill bars, condor brackets, colours and the short rule form (#388) from the
desk, and B's cards from the phone. It is now read later, by a person or another model, and a card
lays each figure out in a place of its own while colour, bars and symbols carry meaning a reader of
an image can miss. **This supersedes #300's "A's table from the desk, B's cards from the phone".**

- **One plain table, from either arrangement.** The phone saves the desk's table, not cards. *(The
  order and the sections superseded 2026-11-17: ONE book section in the one book's order, then the
  muted and expired — see the last section.)* The
  holdings first, then the watchlist, each grouped by expiry under a heading row with its DTE (the
  watchlist's quarantined rules last, under a heading of their own), then the muted and expired
  rules as one ungrouped list, as the desk's fold has them; every column the viewer ticked (`ui_cols_combo`), under headers that
  say their unit; a first column saying what each row is (a holding, "a condor with" its partner, a
  rule on a holding, a watched spread, a rule on a leg of one, a quarantined or muted rule), since
  the indent and the bracket are gone; and a **status column** in the page's own words for what the
  screen says by colour or chip — `chipWords`'s ("ringing", "entry signal", "at stop · as of the
  close", "manage-by"), "fault: " and the rule's error, "quarantined: " and its reason, and the
  muted fold's reasons ("muted by you", "expired", "holding closed"). No state is new.
- **Words and numbers only.** No chip, fill bar, bracket, sparkline, arrow or symbol shorthand, and
  no colour (the field's own symbols excepted since #404 — `Δ`, as the column headers write it): a
  leg is its letters and sign (`-C7300 +C7350`) without #391's type colour, the pace gap
  its words ("behind by 0.40"), the strike strip the nearest short strike and its distance in words.
  Dark ink on a white ground in either colour scheme, in a monospace face with tabular figures, at
  13px; as wide as its widest row, so nothing is clipped or wrapped. The browser suite measures it,
  at the desk and under the iPhone 13 profile: one ground, one ink, no drawn element, no type under
  12px, nothing cut short, and the same table from both.
- **Rules in full sentences** (`sentence`: "|Δ| ≥ 0.20 — now −0.170, 0.030 away" since #404, in
  the short form's words; it read "|delta| ≥ 0.2 — now -0.170, …" before). The screen keeps the
  short form (#388).
- **A header block says what the table is:** when it was taken, on New York's clock and on
  DISPLAY_TZ's (`/health`'s `display_tz`); the session, in the page's words ("in session", or the
  market-closed line's); how fresh the figures are (the Freshness line); any warning; the
  References in the strip's words, with the time each was read outside the session and, after a
  dash, why (the strip's title to a pointer); and the
  needs-you line with every item named, since a picture cannot be opened to read "+N more". As on
  the page, with nothing needing you the line is absent, which is not an all-clear.
- **"Copy as text"** sits beside "Save as image" wherever that is offered — the header on the desk
  and the phone, and the ⌘K palette — and puts the same view on the clipboard as Markdown: the
  header block as lines above a Markdown table per section, an expiry's heading as a row with the
  heading in its first cell. Everything the service sent is put on one line, one space between
  words, in the picture and the text alike, and the text escapes a pipe in a cell and a backtick or
  an asterisk anywhere, so a name or an error can neither end a row nor open code or emphasis. It says "copied as text", and where the
  browser refuses the clipboard, or the page has none, or the text could not be built, says so with
  the reason. Safari grants the clipboard only inside the owner's gesture, so the text is built and
  written in the press itself — from the palette, in the pick, before the palette's close runs.
- **One builder** (`snapshot/plain.ts`, pure) makes the rows and the words; the picture
  (`Still.tsx`) and the text (`toMarkdown`) each only write them out, and a test reads both back
  and requires the same rows and cells. Privacy goes in with the figures, so what the screen hides
  ("$•••") both hide in the same words. Nothing interactive goes in, as before.

### Amended 2026-11-15 again: fewer, shorter columns, and the value is a price (#400)

Decided by the owner on 2026-11-15 (#400), looking at a real picture. **This supersedes the bullets
above on the first column, the status column, the headers' units, the strip's words and the
References' line.**

- **No "what" column and no status column.** A row is its name alone — no bracket note: "1231_8100",
  not "1231_8100 (shares C8100 with 1231_8050)"; the page keeps its overlap note. A row's attention
  is said where the page says it, and each state the status column carried was checked to reach
  one, a test per state: ringing, an entry signal, a fault and its error, each quarantine and its
  reason, and a holding's Level in the session are in the needs-you line; a rule's own state is in
  its sentence. Two would have been lost, and are said instead: **outside the session**, where the
  needs-you line names no holding's Level (#354), a **"Levels" line** in the header in the chips'
  own words (`levelWords`, "1231_8100 at stop · as of the close", every holding's joined by "; "),
  absent in the session, where the line says them; and the **muted rules' reasons**, as heading
  rows grouping the "Muted and expired" section in the desk's fold's order, in the phone's words
  ("expired", "its holding closed", "muted by hand", "reason not recorded"). That a condor held as
  two spreads is one condor is no longer said; it is not a state.
- **Short headers:** "name", "legs", "value", "P&L ($)", "captured (%)", "pace gap (pts)", "Δ",
  "SPX→short", "DTE", "manage-by", "rule" — those the viewer ticked.
- **SPX→short, compact:** `C8050 488 · 1.64σ` — the nearest short strike, whole points, σ to two
  places, no "pts" and no "away"; a strike SPX is past with its sign as served, `C6800 −101 · −0.25σ`,
  and a distance that rounds to nothing `0 · 0.00σ`, never with a sign
  (`strip.ts`: `compactWords`).
- **The References a list,** one per item: a nested list in the Markdown, a line each in the picture.
- **The value column is always the price** — a contract's mid, a spread's value — on the page (the
  desk's table and inspector) and in the picture and its Markdown, at every hour. `/quotes`' `combo_value` is
  the rule's OWN field summed, so a delta rule's is its delta: that figure is the Δ column's and the
  rule sentence's, never the value's. A delta rule on a spread shows the price of a price rule on
  the very same contracts in the same poll, and a dash where there is none; nothing is summed on
  the page (`lastknown.ts`: `priceOf`).
- **Out of the session, the watchlist's last in-session price.** moomoo quotes every leg bid 0 /
  ask 0 out of hours, which is no price, and a watched spread has no close to fall back on, so a
  WATCHLIST row's value says the price rule's last reading in the session (`last_reading`, #380)
  with its time on New York's clock, `4.12 (Fri 16:14)` — its date too once it is older than six
  days, `(Fri 6 Nov 16:14)`, as the rule's short line then says it — and a dash where there is none (a
  contract watched only on its delta, or never read in the session). A reading taken out of the
  session — the stored 0.0 of a Saturday night — is never shown. The same on the desk, the
  phone (a watch card adds a "value" line out of the session only) and the picture; in the session
  nothing changes. A rule on something held keeps its cost to close.

## Amended 2026-11-15: the watchlist's history (#402)

The owner's decisions of 2026-11-15, built on ADR 0011's watch samples:

- **A watched row has a history**, in the desk's inspector and the phone's sheet, opened as a
  holding's is (open outside the session, shut in it): its value each day against its price rule's
  threshold and its legs' IV — the holding's two panels on #399's one crosshair (three until
  2026-11-17, when "SPX against its strikes" was removed, #430). The value is drawn as the price
  rule compares it (its size under `abs`, the figure under `signed`); with no price rule, a spread
  watched only on its delta, its size and no threshold.
  In points per contract: a watched row has no count and no money.
- **One chart, more lines as more is known.** Recorded as held, the same contracts' watch days are
  drawn in the holding's burndown and IV panels BEFORE its own, faint, with a rule where it was
  entered, and every readout says "before entry". The plan, the Target and the Stop start at Opened.
- **The payoff and the value cell fall back to the last close.** A watched spread's payoff is drawn
  at its last close out of the session, always — never at a value quoted out of it — and in the
  session where the rule watches no price; said "drawn at its close, Fri 16:14, 4.12, as the
  credit", or the reading's own timing where it was not a close. The out-of-hours value cell (#400)
  says the same last close where one is stored, and the sweep's last in-session reading otherwise.
  The closes are read apart from `/quotes` (`GET /monitors/closes`), out of the session and whenever
  `/quotes` fails, so a watched row keeps its last close through a Provider outage: while `/quotes`
  is failing the value cell says the close, as out of the session (owner's decision, 2026-11-15).
- **The entry day's watched close.** Where a holding recorded in New York's evening has no Cost to
  close on the day it was entered, its burndown draws that day's watched close as the day's point,
  saying "the close, watched before entry" (`entry_close`).

## Amended 2026-11-15: ≥ / ≤ on the add form (#405)

The owner found no way to make a "≤" rule from the add form, and did not find a contract's value
among the Greeks it watches. Decided:

- **A spread's two rules each choose ≥ or ≤**, a two-button pair between the rule's words and its
  threshold (`|value| [≥|≤] 0.40`, `short leg's |Δ| [≥|≤] 0.05`), the form's own segmented pair
  rather than a dropdown. ≤ is posted as `direction: "below"`; ≥ posts no direction, the route's
  default, so a rule at or above posts what it did before.
- **A held credit's stop offers no choice.** It stays "cost to close ≥ 2× the Entry", posted signed
  and below (#343), whatever was pressed while the draft was something else.
- **A held debit's value rule starts at ≤** when it is switched on (owner's decision, 2026-11-15):
  its stop is a fall in value, and the hint says so. It still starts switched off with no figure
  (#322), and ≥ stays pressable. Watched spreads, credit stops and every |Δ| rule start at ≥, as
  #293 set them.
- **A held spread's |Δ| at ≤ is called a close-cheap signal**, and at ≥ a risk, as before.
- **One contract** chooses its direction with the same pair, and lists its value first in what it
  watches; it still starts on Δ. **The Monitor editor** chooses direction with the same pair.

## Amended 2026-11-15: from Watch to Hold (#408)

The owner asked whether "I hold it" and "Watch it" could be one choice. They cannot: they differ in
what the rules mean (a stop and risk, against entry signals), in what saving does (holding a spread
replaces a watch rule on it, #293/#336) and in where the result lives. So the two stay, and moving
between them is made light. Decided:

- **Switching loses nothing typed.** Watch ↔ Hold, any number of times, keeps the expiry, the legs,
  their sides, types, quantities and strikes, the names, the |Δ| figure and its ≥ / ≤; the fields
  only one side has (Opened, the Entry, the count, a contract's side) are set aside and come back.
  **A spread's VALUE figure is kept per choice** (owner, 2026-11-15): typed while watching it is an
  entry signal, not a stop, so on "I hold it" it gives way to the holding's default — 2× the Entry
  for a credit, an empty ≤ for a debit, on, for the stop to be typed — and switching back to Watch
  shows what was typed, with its ≥ / ≤. The held figure, once typed, is likewise kept for Hold. A
  rule switched off by hand stays off either way. (Checking switching first found a value rule typed
  while watching DROPPED from the save on switching to Hold with a debit's Entry, its box still
  showing the figure; the rule now stays on, at the default above.)
- **Each choice says what it does, on itself**, under its words: "I hold it — records a holding; its
  rules become a stop and risk", "Watch it — rules only, as entry signals". The buttons' names stay
  their words, the line their description; two equal columns, wrapping on the phone.
- **"Record as held"** is offered in the desk's inspector and the phone's sheet of a WATCH rule — on,
  linked to no holding, on nothing an open holding holds — of a spread or one contract. It opens the
  add form as "I hold it": on the desk the panel above the table *(superseded 2026-11-15: a side
  sheet, like Settings — "Add as a side sheet on the desk", below)*, the Entry focused; on the phone the
  Add sheet OVER the rule's sheet, Back or Cancel closing only the Add sheet (the page's sheets now
  share one history list, so one Back closes one sheet). The owner types Opened (today's New York
  trading day until changed), the Entry and the count; the save is `POST /spreads`. Where `/monitors`
  has not been read, the spread's legs are the row's own from `/quotes`.
  - **A watched spread** is prefilled with its expiry, its legs — each sign a side (minus is short,
    ADR 0013), each quantity kept (#351) — and its name, the watch rule's code, so the held spread's
    value rule is made under it and replaces it. Where a holding on record, closed ones included,
    already has that name, the form says so before saving — the save would be refused — and that
    renaming it means the watch rule is KEPT, linked to the new holding, rather than replaced. Its
    rules are a holding's defaults, not the watch
    thresholds, which were entry signals (owner, 2026-11-15): held for a credit, the stop at cost to
    close ≥ 2× the Entry and the short legs' |Δ| ≥ 0.30, both watch rules replaced; held for a DEBIT,
    the value rule starts ON at ≤ with an empty threshold, refused in words until the stop is typed,
    so the old entry-signal rule is replaced rather than adopted with its threshold. That applies to
    the prefill only: a debit typed fresh keeps #405's "off, ≤ when switched on".
  - **A watched contract** is prefilled with its expiry, type, strike, its derived name (apart from
    every holding on record, closed ones too) and the watch rule as saved — its field, direction,
    compare and threshold — so the route replaces it and keeps its alarm (#336); the side starts
    short. This is the ONE way to record a watched contract as held: #336's "I hold this", a form of
    its own inside the rule's controls, is retired with its preview of the other rules the holding
    would adopt — which comes back for both forms, below.
  - **On the desk**, Escape or Cancel hands the focus back to the "Record as held" that opened the
    panel.
- **What a held save does to the rules already there, said before it is made, and read back after**
  (owner, 2026-11-15), for a spread or a contract, from "Record as held" or a fresh add:
  - **"Replaces the watch rules: …"** — a rule linked to no holding on a (code, field) the save
    makes: a spread's value under its name, a short leg's Δ, a contract's rule. Deleted and made
    again as the holding's own.
  - **"Also links to this holding: … — kept as they are; edit or delete them after."** — every other
    rule the service then ADOPTS (`adoptOrphanMonitors`), worked out as it works it
    (`positionsHolding` against every open holding, the new ones included): a watched spread's Θ, Γ,
    ν or Δ, which "Record as held" does NOT replace; a long leg's Δ; a watched spread holding the
    contract; on or off. Nothing is taken over in silence. Linked to nothing where a contract is held
    twice (a roll day); as the whole of a holding where it watches exactly what is held, and as one
    leg of it otherwise. Held to every door scenario that saves, among them one made for this:
    `POST /spreads takes over a watched spread's theta and its long leg's delta`. Where the holdings
    are not read, the form says it cannot tell yet.
  - **The toast reads both back** from `/monitors` after the save: "added 1 holding and 2 Monitors,
    replacing 2 watch rules; also linked to it: 1218_P7150 |Θ| ≥ 0.50".

## Amended 2026-11-15: one refresh, a sticky header, Settings as a sheet (#410)

The owner asked for three layout changes. Decided:

- **One refresh button, the header's.** The market-closed line's "refresh" goes, on the desk and the
  phone; the line keeps its words. Nothing is lost: the line's button was the header's refresh under
  another name (`refreshNow` — the line, the holdings' valuation, the References and the closes, then
  the poll restarted; outside the session that is the one valuation and one read #371 promised).
  Held by a test that presses the header's button outside the session on both arrangements and
  counts each of those reads once, and by one that the line has no button left.
- **The header is held at the top of the screen while the page scrolls**, on the desk and the phone:
  `position: sticky`, opaque, under the sheets and dialogs. Its top padding is the larger of its own
  and the safe area's top (`env(safe-area-inset-top)`, which `viewport-fit=cover` makes non-zero
  under a notch), its sides the gutter or the safe area's, as before. **Nothing lands under it:** its
  measured height is kept on the document (`--nx-head-h`) and the document's `scroll-padding-top`
  clears it — so a needs-you banner leading to a row, the palette, j and k and the price map land a
  row below it — and, on the desk, below the table's own sticky column heads too, which now stick at
  the header's bottom edge, as the inspector does. A phone card's sheet closed by Back (or any other
  way) brings its card back clear of the header once the sheet's scroll lock has let go: opened from
  a card half under the header, the restored scroll alone left it there.
- **On the phone, Add and Settings are buttons in that header** — the same "add" and "settings" the
  desk has, 44pt targets like every phone control — and **the bottom tab bar is retired**, since the
  Book is the page itself. The header's six controls (the title and five buttons) sit on one row at
  390px; at 320px the title is cut short rather than the row pushed sideways. The page's end clears
  the home indicator only, where it cleared the bar.
- **On the phone, Settings is a bottom sheet over the book**, like the Add sheet and drawn by the same
  component (`PhoneSheet`): it rises from the bottom, never the whole screen, closes on Back, its
  Close button, Escape and a tap outside, and takes its Back entry from the one list every sheet on
  the page shares (#408's `useDismissOnBack`), so one Back closes one sheet. The book stays drawn
  under it, where it was. A close's account (#294) stays drawn under it too, where the Settings
  screen used to replace it. **The desk keeps its Settings side sheet.** Switching arrangement with
  Settings open — which Settings itself offers — closes the one sheet and opens the other under ONE
  Back entry, held by the page for as long as Settings is open. An entry per sheet raced: the
  browser's back() for the sheet going ran after the push for the sheet coming, went one entry too
  far, and the next close left the dashboard (found while building; held by a test each way).
- *Swipe-down:* the issue asked for Settings to close "by Back, swipe-down and Cancel like Add". The
  Add sheet has no swipe-down (it is a Base UI Dialog, not a Drawer) and no Cancel of the sheet's own
  — Cancel is the add form's button. Settings, built as the same component, closes exactly as Add
  does: Back, Close, Escape, a tap outside. A swipe to dismiss, for both sheets, is left to the owner.

What this supersedes, marked where it stands above: the phone's three tabs (#374, the 2026-11-13
amendment's "The phone has three tabs") and its bar along the bottom; the market-closed line's own
refresh button (#371). The saved picture is unchanged: its header was always its own, with nothing
to press.

## Amended 2026-11-15: Add as a side sheet on the desk

The owner asked for the desk's Add to be what its Settings is. Decided:

- **On the desk, the add form is a side sheet over the book**, drawn by the same component as the
  desk's Settings (`DeskSheet`): it slides in from the right, the book stays drawn under it, and it
  closes on Back, its Close button, Escape, a tap outside, and the form's Cancel or Save. It is
  wider than Settings' (48rem against 24rem) so a spread's payoff still sits beside its fields
  (the form's 44rem container query); at Settings' width it fell under them.
- **Its Back entry is the page's**, as Settings' is, held for as long as Add is open on either
  arrangement: the desk's side sheet and the phone's bottom sheet are one Add, so a switch of
  arrangement with it open pushes no second entry (the race #410 found for Settings).
- **The focus goes back to what opened it** — "+", or the inspector's "Record as held" — by
  whatever way it closes, as the panel's did.
- **"+" opens Add; it no longer toggles it**, as the settings button opens Settings: the sheet is
  modal, so "+" cannot be pressed while it is open.
- The desk's keys need no rule of their own for it: an open sheet is a dialog, and j and k already
  stand still under one.

What this supersedes, marked where it stands above: "on the desk the panel above the table" in
#408's "Record as held", and with it the add panel's region above the table (#293).

## Amended 2026-11-16: one field for cost and pace, nothing said twice, smaller buttons

The owner decided, from the live page:

- **A holding's Cost to close and its pace gap are one field**, drawn `3.05 −1.57`: the gap keeps
  #379's sign rule and colour (`+` behind, in the loss colour; `−`, the true minus, ahead), and the
  two are said in words to a pointer and a reader ("cost to close 3.05, pace gap behind by 1.57").
  No gap, the cost alone; no cost, a dash. On the desk it is the value column, and the pace gap's own
  column goes: its key joins the retired ones (#372), so a column cookie that names it hides
  nothing, the picker no longer offers it, and reset clears it. On the phone's card it is the one
  "cost to close" field. The saved picture and Copy as text keep the value and the pace gap in
  columns of their own, for analysis, ticked together with the value; the inspector and the phone's
  detail sheet keep them apart too.
- **The Add sheet says nothing twice.** No subtitle under its title (its footer, "One save makes all
  of it…", now in both forms, held or watched, is the sheet's description); a draft rule whose short
  form IS its words is written once (`ShortWords`), not once drawn and once for a reader; no
  "Watching a contract records no holding", nor "an entry signal" under a watched spread's rules —
  "Watch it" says both; no line beside a held contract's Monitor switch repeating the sentence under
  it; the payoff's blank is "type the strikes" under its own heading.
- **A leg's side is drawn − or +**, the book's notation (−P6800 +P6750), named "short" or "long"
  and titled with the word.
- **Buttons are drawn smaller**: 26px on the desk, where they were 28 to 32. On the phone a button
  is drawn 32px and keeps its 44pt target through an invisible area above and below it (its
  `::after`, raised over positioned content drawn after it — the strike strip under a watched
  spread's Monitor buttons had covered its bottom 6px). What is guaranteed is measured, not
  assumed: every phone suite asks where a tap LANDS (`__browser__/targets.ts`), and each control's
  44pt must be its own — no other control's area and nothing else of its layer over it. Rows of
  buttons that wrap or stack sit 12px apart for that reason. "I hold it" and "Watch it" are a
  control's height, each consequence drawn under its button rather than inside it (#408's
  description, unchanged). The held contract's Monitor switch says "Monitor on" / "Monitor off".
- **A gap of nothing to two places is "on pace"**, drawn 0.00 in no colour — never "ahead by 0.00".

## Amended 2026-11-16: the Curb and the overnight session are live, and say so (#416)

The 2026-11-13 and 2026-11-14 amendments keyed the page to New York's session and valued the book
from the latest close outside it, on the belief that "out of hours moomoo quotes every option 0/0".
That is true only while nothing trades: SPX options trade in the Curb (16:15–17:00) and in GTH
(20:15–09:25 New York; Sunday 20:15 starts Monday's trade date), and moomoo quotes them live. The
owner's decisions (2026-11-16), as built:

- **The page polls in the Curb and GTH as in session** (`marketPhase`, `frontend/src/session.ts`;
  ADR 0012, amended): `/quotes`, `/positions/values`, `/references`. Alarms ring in GTH, every rule,
  as they always did — a rule with no two-sided quote is still held (#384).
- **A holding is valued LIVE where every leg has a two-sided quote**, and from its latest close where
  one has none (`valuesFromClose`), in both backends; while nothing trades, from the close as before.
- **The session line says which session**: "overnight session — live quotes, thin" (or "Curb — live
  quotes, thin"), then how many holdings were valued from a close for want of a quote, and which
  close — never "market closed". `/holdings` says the same line under its table.
- **A watchlist row's value cell is the live price** where the poll quotes one, and its last close
  where not. **A Level chip valued live in the Curb or GTH carries the time**: "at stop · live at
  21:04"; one valued from a close says "as of the close".
- **SPX outside the regular session is the last close's level**: moomoo's index quote stands still
  overnight and every premium is worked out against it, so `derivedSpx` inverts to Friday's 7561.68
  all weekend and night. The service says so beside the price (`spx_reason`, `sessionSpx`; ADR 0024,
  amended), and the page draws it: a hollow dot on the strike strip with the reason in its words,
  the reason on the price map's line and beside the payoff's marker. The strike distances and σ are
  still measured against it, and say so through that reason. Never presented as current.

## Amended 2026-11-16: one format and one vocabulary — numbers, figures, Δ (first half)

An audit of the live page (2026-11-16) found the same figure written several ways — `-2.95` in the
table, `−2.95` in a rule's sentence, `7,561.67` on the strip beside `SPX 7561.70` on the strike
strip, ν drawn as "N" by an upper-case label, "short leg Δ" on the desk and "short Δ" on the phone.
The owner set one standard (2026-11-16) in fourteen parts; this half builds five of them (A–E) and
the picture's (M). The rest — clocks and zones, "rule" for "Monitor", sentence case and the actions'
words, the muted reasons, one section order for the inspector and the sheet, the phone's cards, the
payoff's maximums and the errors' words — is the second half, built and recorded in the next section.

- **One number formatter** (`frontend/src/shared/numbers.ts`). Every figure on the page goes
  through it: points and prices to 2 places, Δ to 3, Γ to 4, Θ and ν to 2, IV to 2 and a `%`,
  breakevens and SPX's crosshair levels to 2 (`6295.00`, where a whole level was `6295`). Every
  negative carries the true minus, U+2212 — money (`−$4,528`), points, greeks, percentages, the
  burndown's axis, a long's stored Exit — where the table, the payoff and the inspector had the
  hyphen-minus and only the rule's sentence and the pace gap had the true one. A served non-zero that
  rounds away is a bound, `<0.0001` or `>−0.0001`, never `0.0000` or `-0.0000`; a Reference's day
  move too small for its places is `<+0.01%`. A chart's axis TICK is no figure: it names a gridline and is written to the places it needs (`tick`: `20%`, `−$400`), as the burndown's always were — two idle zeros on the IV axis widened the margin the three history panels share and put a readout on its point at 272px. A typed input keeps what was typed: the formatter writes
  figures, never the text of a box. **Every box that reads a figure reads one pasted from the page**
  (`readNumber`, review of #418): the rule editor's threshold and total Entry, the add forms' strikes,
  Entry and thresholds, and the holding forms' Entry and Exit take a leading U+2212 as the minus a
  keyboard types, and nothing that is not a plain decimal.
- **SPX one way, with no thousands separator**: `7561.67` on the References strip, as on the strike
  strip, the price map, the payoff and the SPX chart — read against strikes (`C8050`) and breakevens
  (`8054.72`), which carry none. The strip's `7,561.67` was the only separated figure on the page.
- **Legs with the true minus, short first** (`format.shortFirst`): `−C8050 +C8100`, a condor's two
  short legs before its wings, in every LIST of legs: the legs column, the cards, the sheet's heading,
  the inspector's list, the palette, the picture. A label on the payoff's axis keeps STRIKE order, left
  to right as the axis runs, one that joins several strikes' legs included (review of #418): short
  first is for a list, not for an axis. The legs form "minus" is gone: there is one signed form. The
  palette still finds a leg typed with a hyphen-minus. A name the add form derived and stored
  (`1231_-C8050+C8100`) is data, written as stored.
- **A row's figures in one order, by what the row is** (`quotefigures.ts`, drawn alike by the
  inspector and the sheet):
  - a single contract: its **value** (the mid — called what a rule on it calls it) first, then
    Δ Γ Θ ν and its IV, then the quote's detail: bid, ask, last and the last trade;
  - a spread on the watchlist: its **value**, signed as the service signs a combo, then Δ Γ Θ ν. A
    delta rule's spread says the price its value cell says (#400) or a dash with why — never its
    summed delta under "value". **No cost to close on the watchlist**, a spread that shares a
    contract with a holding included: its "shares … with …" note says what it shares;
  - a spread on something **held**: its **cost to close** first, then Δ Γ Θ ν, and its signed value
    after them as detail.
- **A held spread's rule row says its cost to close** in the desk's value column, positive as its
  holding's, and a dash where the service could not price it — never its signed value in its place.
  Watchlist rows keep the signed value. A rule's sentence is unchanged: `|value| ≥ 5.51 — now −2.95`.
- **Δ said three ways** (`shared/words.ts`): `short Δ` on a holding (the desk's "short leg Δ"
  retired), `Δ` on a spread or a contract, `position Δ` for a holding's net delta — and its other net
  greeks `position Γ`, `position Θ`, `position ν`, on the desk and the phone alike, where the desk
  said `position γ θ vega` and the phone `Δ γ θ vega`. The pace split's "net vega" is `position ν`.
- **A label carrying a Greek letter is never set in capitals.** An upper-case ν is "Ν", which reads
  as N: the inspector's and the payoff's figure labels are drawn as written, and a table header with
  a Greek letter keeps its case (`data-greek`). Measured in the browser, desk and iPhone
  (`__browser__/NextGreekLabels*`): no element whose own text has a lower-case Greek letter is drawn
  with `text-transform: uppercase`.
- **The saved picture and Copy as text** (#394, #400): each section has its own columns — the
  watchlist's *(one book since 2026-11-17: its one table has every column, blank on a watched row)*
  and the muted rules' carry none that only a holding fills (P&L, captured, pace gap,
  manage-by); a figure's column is set to the right, in the picture and as `---:` in the Markdown;
  and a unit sits in a header only where the cells do not say it — `P&L` above `+$177`, `captured`
  above `38%`, `pace gap (pts)` above "ahead by 1.53". The two stay held to each other
  (`NextPlainView`, `NextSaveImage`), the sign set aside.
- **Copy as text writes a figure's minus as the hyphen-minus** (the owner, 2026-11-16): `-2.95` and
  `-$4,528` in a right-aligned cell, so the text pastes into a spreadsheet as numbers — a cell that
  starts with U+2212 is read there as text. The page and the saved picture keep the true minus, and
  the text keeps it in words (a rule's sentence, a leg, the pace gap). One constant decides it
  (`MARKDOWN_FIGURE_MINUS`, `snapshot/plain.ts`), and Copy as text is therefore the one view the
  hyphen-minus guard does not walk.
- **Held by** `NumberFormat.test.tsx` and `NumberFormatPage.test.tsx`: nothing the page says — its
  text and every title and aria-label — uses a hyphen-minus as a sign, in the desk's table and every
  inspector, the phone's cards and every sheet, in session and out (histories and payoffs drawn), the
  References strip, the price map, the closed trades, a holding's edit form (its quantity's payoff
  comparison drawn) and close form, a rule's total Entry split, every payoff's crosshair readout and
  tooltip as the keys move it, and the saved picture. Not Copy as text (above). A held spread's value
  cell is read to a screen reader as "cost to close", as it is drawn.

## Amended 2026-11-16: one vocabulary across the page — times, words, order (second half)

The rest of the owner's standard of 2026-11-16: parts F–L and N. Frontend only; the bot's wording
is out of scope, and where a line here says "the bot's words" it now differs from the bot by the
zone mark.

- **F. Every clock carries its zone** (`frontend/src/shared/times.ts`). Two clocks, by what a time
  is about. The MARKET's — a close, a last trade, a Level reached live in the Curb or GTH, the
  session's own edges ("after the 16:15 ET close") — on New York's clock, marked `ET` all year
  (`newYorkWhen`, `marketClock`; never EST/EDT, which named one clock two ways). The VIEWER's — when
  the service fetched, when the screen updated, when a holding was valued or a Reference read, the
  picture's "taken" — on DISPLAY_TZ's clock, marked with that zone's short name, `SGT` for
  Asia/Singapore, and never the `+08:00` it was served with. "Screen updated" is said on DISPLAY_TZ's
  clock too, where it was the device's: one viewer's clock on the page, not two.
  - The short name is the tz database's, asked of a few English locales in turn, since each names
    only its own region's zones (en-US says `GMT+8` for Singapore, en-SG says `SGT`); where none has
    one, the offset's name, `GMT+5:45`. A stamp is never said in a zone it was not written in: one
    whose offset is not DISPLAY_TZ's is named by its offset.
  - DISPLAY_TZ is `/health`'s `settings.display_tz`, set as page state when health arrives
    (`setDisplayZone`), so every pure reader of a served stamp — the Levels, the References, the
    closed line, the picture — names one zone without each being handed it. Before it is known, the
    device's zone stands in where its offset agrees with the stamp's. The suites clear it after every
    test (`testing/zone.setup.ts`).
  - **The last trade** is the market's: `Mon 16 Nov 00:22 ET`, where it was `2026-11-16 13:22:02`.
  - **Dates are never ISO on screen.** An expiry is compact, `261231`, where the page is dense — the
    table's groups, the picture, the palette — and prose, `Thu 31 Dec`, in a sentence: the meta line
    under a holding's or a rule's name, the phone's expiry headings, the closed trades, the expired
    rule's note and the day it is deleted on. An opened or closed day is prose too. No year: every
    date on the page is the weekday, the day and the month, as `marketDayWords` and the bot write a
    market day. A service's own refusal ("closed on 2026-10-30, before it was opened on …") is its
    words and is shown as they are.
    *(Superseded 2026-11-17, "one date format": every date is YYYYMMDD, `20261231`, dense or in
    prose, with its weekday only beside a time.)*
  - **Manage-by is days left**, `in 24d` or `due`, on the desk's column, its inspector and the phone's
    sheet alike, the threshold as its detail, `at 21 DTE` (`pace.manageBy`).
- **G. "rule", never "Monitor", on screen.** The save button says `Record holding + 2 rules`, the
  sections are `Rules`, a holding with none says `no rule on it`, the toasts say `added 1 holding
  and 2 rules`, and every refusal, note and label that said Monitor says rule. The API and CONTEXT.md
  keep the word: the palette still FINDS a rule by "monitor" (`commands.ts`'s `RULE_SYNONYMS`), and
  calls each kind `rule`, `quarantined rule`, `muted rule`, `expired rule`.
- **H. Sentence case, and one order of actions.** No stylesheet sets capitals: the desk's section
  titles and table header, the payoff's and the history's headings, the history's toggle and the
  palette's groups are written as read — `Holdings`, `Payoff at expiry`, `History`, `Go to` — and set
  apart by weight and size. Headings take their capital (`Rules on held contracts`, `Quarantined —
  switched off by the service`, `Needs you`); a figure's label stays as it is written, lower case
  (`cost to close`, `short Δ`), as the first half wrote them.
  - The actions are lower-case verbs in one order: a rule's `edit · mute · record as held · delete…`,
    with `split entry` and `switch back on` before the delete where they are offered; a holding's
    `edit · close… · delete…`. An ellipsis only where a question follows, which a rule's delete has as
    a holding's does. Every question ends `… / keep it`: a rule's and a holding's delete
    (`delete it / keep it`), a holding's close (`close it / keep it`), switching a quarantine back on
    (`switch it on / keep it`), and Settings' removal of a Reference. An edit form's are `save /
    cancel`. Settings' References submit is `add` (named "add reference" to a reader, beside the
    header's add), where it was "keep it" — the words of a refusal. The sheet's own close button is an
    icon named `close sheet`, where "Close" sat beside a holding's `close…`.
- **I. One set of words for why a rule is off** (`shared/groups.ts`'s `REASONS`): a LABEL for a list
  — `unknown contract`, `figure never arrived`, `could not be read`, `expired`, `holding closed`,
  `muted by you`, `reason not recorded` — and a CLAUSE for a sentence, the quarantines' being the
  needs-you line's (`the provider does not know its contract`). The desk's fold and quarantined rows,
  the phone's switched-off cards, the needs-you line, a closed holding's account of its rules and the
  picture's headings all read them; the phone's "muted by hand" and "its holding closed" are gone. A
  quarantine said in full before switching it back on starts with its clause.
- **J. ONE section order for the inspector and the sheet** (`sections.ts`, drawn by
  `DetailSections.tsx` on both). A holding: its P&L and Level, legs (in words, short first), strike
  strip, payoff, figures (cost to close, entry, contracts, short Δ, position Δ Γ Θ ν), `Exit schedule`
  (target, stop, on pace, pace gap, manage-by), the pace explained, `Rules`, its actions, its history.
  A rule: the same shape — its state, legs, strip, payoff, figures opening with what it `watches` and
  how it compares, `Rules` (itself and the rules on its legs, each with its controls), history. Under
  the name, on both, one line: `Thu 31 Dec · 45 DTE · opened Wed 11 Nov`. The desk's inspector no
  longer lists every column's figure (#372's "every figure, the hidden ones included"): its figures
  are the list above, and the P&L and the captured share lead it, as on the phone. A rule's own
  progress — its arrowed distance, since 2026-11-17 — is its line's in `Rules`. Each section is marked `data-section`, and `NextDetailOrder`
  holds both surfaces to the list and to each other, for every holding and watched row of the
  owner's book. A rule's chip and its fault are its level section's, said once: its own line in
  `Rules` draws neither (review of #420). A holding's chip is the same on both — its Level or its
  Manage-by, in the row's words (`AttentionChip`). Out of the session a watched row's value figure is
  its last in-session price and when, as its row and card say it; a short leg's Δ is read from the
  one source the table reads, a delta rule's watched figure included.
- **K. The phone's cards say what the desk's rows say.** A watch card gives its value and Δ as its
  desk row writes them (`columns.ruleCells`) — the live price in session and the last in-session one
  out of it, a held spread's cost to close — where it had a value only out of session. Every rule
  line on a holding's card draws its progress toward its threshold, as a watch card draws its own.
  *(The bar is superseded 2026-11-17, "each thing said once": every rule line says its arrowed
  distance, and none draws a bar.)*
  A holding's DTE is its expiry heading's alone: the card's pill repeated it.
- **L. The payoff's maximums said once**: in the list under the chart, `+4.72 pts per contract ·
  +$472`. The chart keeps a dashed rule at each and writes no figure beside it. A watched spread's
  figures are `pts per contract` as a holding's are: it is one contract, and "pts" beside a holding's
  "pts per contract" read as two units.
- **N. Errors in plain words** (`shared/errors.ts`): what failed and that it can be tried again —
  `the figures could not be refreshed — the service did not answer; tried again at the next poll`,
  `the holdings could not be valued — the service failed (502); refresh to try again`. A browser's
  "Failed to fetch" (and Safari's and Firefox's spellings), a socket's `ECONNREFUSED` and the page's
  own `/quotes → 502` are never the WORDS on screen. What was thrown or served stays one tap away: a
  "details" disclosure beside the words (`ErrorWords.tsx`) — on the banner, the holdings' note, every
  form's refusal, the payoff's, the history's, the pace split's and the closed trades' failures, a
  rule's fault in its detail and a Reference's in Settings — which a finger and a screen reader
  reach, where a `title` reached a pointer alone (review of #420); a toast carries it as its detail.
  A failure names its VENDOR: `moomoo could not be reached`, a Reference's by its source — never
  "the provider" where the vendor is known, since the References exist to tell vendors apart. A
  reason the service SERVES for a dash (`error`, `spx_reason`, `valued_reason`, a Reference's error)
  is made plain at the API boundary (`api.ts`), its served text kept beside it (`<field>_raw`). A refusal is the
  service's words, said as they are, with no retry promised. **Settings' privacy note** says what it
  keeps: `%, Δ, DTE and points`, and that figures in points per contract — cost to close, entry, the
  pace gap, the payoff — stay.
- **Held by** `WordsPage.test.tsx`, over the page walk the hyphen guard uses (`testing/pageWalk.tsx`,
  now with Settings, the Add sheet, a rule's editor and delete question, and the desk's palette), on
  the desk and the phone, in session and out: no clock without its zone (ET or the viewer's, SGT —
  no other mark passes), no
  offset for a zone, no ISO date, no "Monitor", no raw error — each check held to a planted fault.
  `NoCapitals.test.ts` holds every stylesheet and component to no capitals set by CSS, and the
  browser's `NextGreekLabels` to what it computes on every heading, label and button. `NextReasons`
  holds the reason words across five surfaces, `NextDetailOrder` the section order, `NextPhone` the
  cards against the desk's rows, `PlainErrors` the errors, `Times` the clocks.


## Amended 2026-11-17: each thing said once

The owner, from the live page: "we can still remove some descriptive text more, currently there are
still duplicate about them and their titles". An audit of the live page at desk width and on the
iPhone 13 profile, and of the source for what the live book could not show, found these; each is
said once now, on both arrangements, and the fact only the repeat carried is kept:

- **SPX's reason, once in a detail**: the strike strip says `SPX 7416.64 (index not computed
  overnight — the last close's level)`; the payoff under it no longer says the same line again
  (#416's line stays where no strip is drawn — the add form's preview, a holding with no short leg).
- **A short strike's Δ, once on its strip**: drawn over its strike on the scale; the line under the
  scale says it to a reader only, to whom the scale is decoration (`C7300 399.50 pts · 1.00σ away`
  drawn, `C7300 Δ 0.330 · 399.50 pts · 1.00σ away` heard).
- **The rule editor says no "as saved:" line**: it repeated the rule's own line, drawn just above
  the form, which keeps the served figure and distance (ADR 0005). The draft line stays.
- **A rename's note**: `the holding 1218_C7300 keeps its name`, where "Renames this rule only" and
  "the service never renames a holding" said it twice more.
- **The phone draws no rule's name under its own card's or sheet's heading** (`1231_8050` under
  1231_8050); a leg rule's name, and a rule over more than the card, keep theirs. The desk's
  inspector never drew one.
- **A reason several dashes share is said once**, under the figures, naming them: `Δ Γ Θ ν: a leg has
  no figure, and no sum is taken from part of them`, where it sat beside each of four dashes. A reason
  one dash alone has stays beside it (#332).
- **A quarantined rule's note says what the service found** (`US.SPXW261211C8300000: its strike or its
  expiry is not one it lists.`), under the line or card that already ends in the clause (part I); the
  question before switching it back on still says the whole of it, clause first.
- **The Add sheet is titled `Add`**: its first control says "a spread / one contract"; the dialog's
  name stays "Add a spread or contract" for a reader. The palette's action keeps the long words.
- **The add forms' payoff notes drop "per contract"** (`at 2.40 credit`, `no Entry given, so drawn at
  0`): every figure under the chart says `pts per contract` (part L). The payoff's hint is `point at a
  price, or use the arrow keys, for the P&L there` under its heading `Payoff at expiry`.
- **Settings**: privacy's option is `hidden`, and its note says what stays — `%, Δ, DTE and figures in
  points per contract`; a Reference's source note says a vendor it cannot reach "is refused here too,
  with that reason", where "rather than becoming a permanent dash" was the code note's sentence again.
- **A holding's edit note**: `The name, the contracts and their sides stay as recorded. Keep a wrong
  name: the daily samples are worth more than it.` — "the service does not edit them", "a wrong name
  cannot be changed" and "a quantity typed wrong is corrected above" (the fields just above) went.
  **Its delete question** says `If this was a real trade, closing keeps all of it.`, beside the button
  `close it instead`.

- **No bar toward a threshold, anywhere** (the owner, 2026-11-17): the desk's rule cell and inspector
  rule lines lose their fill bar, the phone's watch cards the bar under value and Δ, and every rule
  line on a card or in a sheet the bar #420's K gave it. Each repeated the rule line's arrowed
  distance (`↑1.31`, `▲ past 0.20`, #388), which stays, as do the chips and the row's colour by its
  state. Gone with it: `DeskBook`'s `Fill`, `Cards`' `Progress`, `.nxd-fill` and `.nxp-progress`, and
  the rule column's width allowance for the bar (`charsOf`). **Where the rule's column drops** (the
  owner, 2026-11-17), the row's name cell draws the arrowed distance its rule line draws — `↑3.60`,
  `▲ past 0.05`, `▲ at` — where the bar fell back before, and a reader hears it in the rule's
  sentence; where the column is drawn the name cell draws none. The fitting gives the name that room
  (`NAME_WITH_DISTANCE`), which, measured on the owner's book, costs the strip at 900px shut and
  1280px open and manage-by at 900px open. The service still serves `fill` (ADR
  0010's `buildEntries`) and the domain's `thresholdFill` and its golden cases stay — shared with the
  backend and the bot; the page simply no longer draws it. #338's reason for dropping the
  near-firing highlight now rests on the arrowed distance.

- **A short strike's Δ under its strip where two short labels would touch** (review of #423): an
  iron fly's two shorts at one strike, or 8000P and 8050C with SPX far off, draw no label over the
  scale, and the line under it draws each one's strike and Δ.
- **A closed trade's note under the desk's table** says only that a closed holding has no quote to
  give it a dollar size: the table's caption says what "made" is.
- **The Add sheet's dialog keeps its full name**, "Add a spread or contract", for a reader; "Add" is
  what is drawn.
- **SPX's reason, once per book** (the owner, 2026-11-17): under the Holdings heading, beside the
  session line, `* SPX: index not computed overnight — the last close's level`, on the desk and the
  phone (`SpxNote`, `bookSpxReasons`). Each card's strip on the phone marks its price `SPX 7416.62*`
  (or `SPX —*`), the mark hidden from a screen reader, which hears the note once; the desk's rows
  draw the hollow dot, as before. A detail's one strip — the inspector, a sheet — still says it
  whole (#416). This revises #416's "the reason in its words" on every strip of the book.
- **An expired rule says "expired" once**: beside its reason's label `expired`, its note is `Fri 6
  Nov — the service deletes it on Sat 14 Nov` (the desk's fold and the phone's switched-off list);
  where no label stands beside it, the note still starts `expired`.

Kept, for the owner to decide: the desk's DTE column under a group heading that says the DTE (#420
K took it off the phone's cards only); a held rule's row named as its holding on the desk's table;
the palette's `Actions` / `Go to` tag on each result; `watches` / `compare` in a rule's figures
(part J).

Held by `SaidOnce.test.tsx`: over the whole page walk, desk and phone, in session, out of it, and out
of it with SPX the last close's level — each row and card, and each list of the book, read apart — no
text a viewer reads drawn twice in one place, nor six words in a row said in two texts, and no bar toward a threshold; and each removal
above by name, with the fact it
kept, each failing when its repeat is put back.


## Amended 2026-11-17: one date format — YYYYMMDD on the page and the bot

The owner, 2026-11-17: every date written for him is `YYYYMMDD`, on the dashboard and the Telegram
bot alike. It supersedes part F's two forms — `261231` where the page was dense and `Thu 31 Dec` in
prose — and the bot's `Fri 13 Nov` and ISO.

- **A date alone is `20261231`**: an expiry's heading, the same on both arrangements
  (`20261231 · 45 DTE` — the phone's said `Thu 31 Dec` and `45 DTE` apart), a contract's name
  (`20261218 6800P`, from moomoo's `SPXW 261218 6800.00P`), the meta line under a name
  (`20261231 · 45 DTE · opened 20261111`), an opened, closed or expired day, an expired rule's note
  (`20261106 — the service deletes it on 20261114`), a history's day and its readouts
  (`20261109 · 39 DTE`), the pace split's reasons, the palette, the saved picture and Copy as text.
- **A date beside a time keeps its weekday**: `Mon 20261116 20:15 ET`; the market-closed line's
  `as of the close, Fri 20261113 16:14 ET`; a fetch from another day, `Thu 20261112 23:14:05 SGT`;
  a valuation older than six days, `Fri 20261106 21:04 SGT`; the picture's "taken",
  `Mon 20261116 10:00 ET · Mon 20261116 23:00 SGT`. The zones are part F's. A weekday alone
  beside a time names no date and stays (`Fri 16:14 ET`), as do the time-only labels
  (`fetched at 11:07:04 SGT`).
- **A chart's axis would write `1116` (MMDD)** to stay narrow; no chart draws a date axis (each runs
  on DTE), so none does. A chart's readout is a date alone, `20261109 · 39 DTE`.
- **One writer per shape** (`frontend/src/shared/times.ts`): `writtenDate` and `weekdayDate`, which
  replace `dateWords`, `format.shortDate`, `session.marketDayWords`'s and `servedWhen`'s own day
  words, three `Intl` `3 Nov` formats (`burndown.ts`, `historyDays.ts`, `PaceExplained.tsx`),
  `shortContract`'s six digits and the picture's `Intl` stamp. In the service, the domain's
  `timefmt.displayDate` (and `displayTimeShort`, `Mon 20261109 22:59 +08` on `/health`),
  `contract.compactStrikeDate` (`shortSpxCode`: `20261218 C7300`) and `contract.datedName` (a
  vendor's name in an alarm and `/snapshot`, `SPXW 20261218 7300C`), cased and ported to the Python.
- **The bot** writes the same: `/monitors`, `/quotes`, `/greeks`, `/vol` and `/combo` name a
  contract `20261218 C7300`; `/holdings`' line `as of the close, Fri 20261113 16:14`; `/health`'s
  sweep `Mon 20261109 22:59 +08`; an alarm, reminder and clear `SPXW 20261218 7300C: …`; an expiry
  `expired (20261030)`; the manage-by notice `at the 20261113 close`. `/unwatch` and `/threshold`
  take a contract with either year, `20261218 C7300` or `261218 C7300`.
- **The service's own words with a date** are written so too: the vol split's reasons
  (`20261007 has no vol reading for every leg`), and a close's refusal (`closed on 20261011, before it
  was opened on 20261012`) — what part F showed as served.
- **Not dates on screen, and unchanged**: a name the owner chose (`1231_8050`, `1218-6800`), moomoo's
  codes (`US.SPXW261218P6800000`), every date the API serves (ISO), the stored data, the browser's
  own date inputs and the formats they and the bot's commands accept.
- **A contract is written whole in every bot table** (the owner, 2026-11-17): `fitCell` never cuts
  `20261218 C7300` (`isContract`, both backends), and no rule's own name is cut narrower than the
  widest contract beside it. `/monitors`' state is `on` where it was `armed`, under the heading `now`
  where it was `state` (the heading was the column's widest cell). Measured on the owner's book its
  widest line is 43, the heading's, and its rows 42; a rule with a wider threshold or figure
  (`|value| ≥ 4000.00`) runs the row past `TABLE_WIDTH` rather than cut the contract. Every other
  table fits: `/greeks` 41 with the bell, `/quotes` 35, `/vol` 31, `/combo` 25. `/unwatch` and
  `/threshold` take the contract as `/monitors` writes it (door scenarios).
- **Held by** `Dates.test.tsx` (each place above by name, the two arrangements' headings against each
  other) and `WordsPage.test.tsx`'s two new checks over the whole page walk, desk and phone, in
  session and out: no date in words (`31 Dec`, `Dec 31`) and no six-digit date — read over each text
  node apart as well as the whole, since `261218` and `7150P` in two cells run together into one
  number — each held to planted faults. The bot's tables by `isContract`'s tests, and a test that no
  `/monitors` on the owner's book or in a door scenario cuts a contract. The bot's by its tests and the door scenarios; the domain's
  by its golden cases.


## Amended 2026-11-17: a derived name's date is YYYYMMDD too

The owner, 2026-11-17, after the date format above: the name the add form SUGGESTS — blank name,
`derivedName` (`add.ts`) and `contractName` (`contract.ts`) — starts with the expiry as `YYYYMMDD`
(`20261218_P7150`, `20261218_P7150_P7100`, `20261218_+C7300_-2C7350_+C7400`), where it was the month
and day (`1218_…`). A name the owner typed is still his and untouched. Since the derived name is the
value rule's CODE, a watch rule saved under an OLD derived name is no longer the one a held spread of
that shape replaces (#293, #322); the live book held none when this changed (its three combos all
carry typed names, checked read-only on 2026-11-17). Held by the add, contract and record-as-held
suites, which state the new names.

The other item raised beside it — the rule editor's `expired` taken from the UTC date — was looked
at and left: the sweep judges expiry by the same UTC date (`sweeper.ts`, `utcDate`), so the page
agrees with the service to the minute, and that minute (19:00 New York on the expiry day) is after
the contract's last trade at the 16:00 close; the evening session trades the next expiry. A New
York date on the page alone would make the two disagree.

## Amended 2026-11-17: one book — holdings and watches together, by expiry

The owner, 2026-11-17, from the live page, decided after a grilling: the book read as two books,
the same expiry headed twice ("20261231 · 44 DTE" over 1231_8050 in Holdings and over 1231_8100 in
the Watchlist), and a held spread's own rule as a second row named the same as its holding. **This
supersedes "holdings first and then the watchlist" on the desk, the phone, the saved picture and
Copy as text, and the picture's Holdings and Watchlist sections (#394).** The two lists are still
not linked: a watch rule is no holding's, and `placeBook` decides what sits where exactly as before.

- **One book.** No Holdings or Watchlist section: each expiry's heading appears once
  (`20261231 · 44 DTE`), the earliest first. The rules on held contracts no drawn holding owns, and
  the quarantined, follow the expiries; the muted and expired fold, the phone's switched-off list and
  the closed trades' fold stay where they were, below the book. The session line ("overnight
  session — live quotes, thin", the market-closed line) and the `* SPX: …` note are said once,
  above it.
- **Under each expiry, in this order:** the held spreads (a condor held as two spreads still
  bracketed, calls first), then the watched spreads, then a quiet muted label `contracts` and the
  lone watched contracts — the label only where the expiry has one. Each part keeps the order its
  rows arrive in, as before.
- **A "held" tag after a holding's name**, small and muted; a watched row carries none. A screen
  reader hears it in the row's name (`1231_8050 held`, `details of 1231_8050 held` on the phone);
  the inspector's and the sheet's heading stay the holding's name alone.
- **A holding's own rule on its row.** `ownRule`: the rule the service links to this holding
  alone over all of it (`scope` "all", `positions` exactly this holding — what its `schedule` is
  built from), a price rule before any other, the one named as the holding only breaking a tie; a
  rule renamed is still its own. It is drawn in the holding's rule cell — its short form and
  arrowed distance, and, where the rule's column drops, the distance in the name cell (#423); the
  saved picture and Copy as text, with the rule's column hidden, put its sentence in the name cell
  (`1218_C7300 held — |value| ≥ 4.00 — now 4.40, past it by 0.40`). Its ringing or fault chip is
  drawn on the holding's row beside the Level's, and its row is gone. Any other rule about the holding is still a row under it; the inspector's and the
  sheet's Rules section list every rule, its own first. The phone's card already drew the rule's
  line without its name (2026-11-17); its own rule is now that card's first line.
- **The row's colour is the most serious** of the holding's Level and its own rule (the owner,
  2026-11-17): a fault (the name struck through) before ringing or at stop, before manage-by,
  before at target — on the desk's row (`rowState`); the phone's card, which draws every rule about
  the holding on it, takes the most serious of those too (a second rule ringing tints the card), where
  the desk gives each other rule a tinted row of its own.
- **A leg's rule sits under its spread**, as before; a contract rule on a held leg already sits
  under its holding, since the service marks it held and links it (`holdsAnyOf`,
  `adoptOrphanMonitors`), and on a roll day, unlinked but held, among the rules on held contracts.
  *(Amended later on 2026-11-17, by the owner's decision: a single-contract rule on a leg of a held
  SPREAD — a short leg's delta — is a row of its own in Contracts, at its expiry and before the
  watched contracts, not a rule under the holding nor under a watched spread naming the same leg
  (`heldLeg`, `placement.ts`). The service's link is untouched: only where the rule is drawn
  changes, and the holding's Δ still falls back to that rule's figure where the service sent none
  (`legRules`). On a holding of ONE contract, itself in Contracts, the rule stays under it.)*
  *(And again the same day, by the owner's decision: EVERY single-contract rule is a row of its own
  in Contracts — a leg of a WATCHED spread too — so a spread's card or row draws nothing under it
  (its `under` is always empty) and a leg rule in two watched spreads needs no "also in" note. The
  spread keeps its short strike's Δ on its strike strip. A sheet opened from a rule's own card,
  closed because the rule was muted or deleted there, hands the focus to the book's heading rather
  than the body.)*
- **Every rule is drawn once** (the owner, 2026-11-17; on main a leg rule in two watched spreads,
  and a combo linked to two drawn holdings — a condor rule over a condor held as two spreads — were
  drawn under both): under the first place by the book's order, and at the other a short muted
  note, `1218_IC also in 1218_C7300`, which is no row, takes no focus and carries no `data-ref`. So
  j and k, the palette and a banner each meet one row per rule. The inspector and the sheet still
  list it under both. The picture and the text write it once and no note, as they write no overlap
  note (#400). The overlap note (`shares C8100 with 1231_8050`, #346) stays under its
  watched spread, now in the same expiry as the holding it names.
- **The phone, the saved picture and Copy as text follow the same order.** The picture is one
  `Book` section with every ticked column (blank on a watched row), the name cell of a holding
  `1231_8050 held`, its own rule's sentence in its rule cell, and the label as a row of its own
  (`contracts`); then the muted and expired, as before.
- **Empty states, one line:** `nothing held or watched` for a book with neither; nothing for a
  book with only one of the two (the other is simply drawn, and the tags say which is which);
  `valuing…` while the holdings are not valued, and a failed valuation's words, as before.
- **The keys and the palette follow it.** j and k walk the rows in the one book's order
  (`tableRows`). The palette finds what the table draws, so a holding's own rule is found as the
  holding — by what it watches too (`price`, `spread`), and as a `rule` or `monitor` — and "Edit the selected rule" on a holding
  with an own rule opens that rule's editor in its inspector.
- **The fitting** counts the tag and the own rule's chip in the name column. Where even the name
  alone is wider than the table (a holding at stop with its rule ringing, beside the inspector at
  900px), its cell wraps the chips under the name rather than run past the edge.
- **Not changed:** the needs-you line, the inspector and sheet contents, column fitting (#423),
  the said-once guard, the date and time standards (#420, #424), and the bot.

Held by `NextOneBookModel.test.ts` (the model), `NextOneBook.test.tsx` (each decision on the desk,
the phone and the picture with its text, each pairing of a Level and an own rule's state, and 60
seeded books shaped as the service shapes them, each holding and rule once on every surface),
`NextDeskKeys.test.tsx` (the keys' order), and the browser's `NextOneBook*.test.tsx` (nothing
sideways at 900, 1024, 1280 and 1440px with the inspector shut and open, and under the iPhone 13
profile).
