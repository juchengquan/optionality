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
Settings is a bottom sheet over the book like Add's (last section). Decided by the owner on 2026-11-09 and 2026-11-10, in the design session that
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
  - tabular numerals, with fixed decimals per field (gamma loses its six places);
  - dark first;
  - on the phone, 44px targets and 16px inputs, so iOS does not zoom.
- **Payoff at expiry only.** There is no T+0 curve, "today" line or probability until a pricing
  model exists, and that model is its own ADR: the backend map measured moomoo's IVs mispricing
  the far wings by 9–23% under a naive model. Never draw what the system does not know.
- **The burndown** draws the daily samples against the planned decay of ADR 0011. A point that is
  not a close (`observed_at`, ADR 0011's amendment) is marked as such. *(Since #395 the IV chart
  and "SPX against the strikes" beneath it share its crosshair: a day pointed at in any of the
  three is crossed in all three, each with its own readout.)*

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

- **One plain table, from either arrangement.** The phone saves the desk's table, not cards. The
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
  threshold, its legs' IV, and SPX against its strikes — the holding's three panels on #399's one
  crosshair. The value is drawn as the price rule compares it (its size under `abs`, the figure
  under `signed`); with no price rule, a spread watched only on its delta, its size and no threshold.
  In points per contract: a watched row has no count and no money.
- **One chart, more lines as more is known.** Recorded as held, the same contracts' watch days are
  drawn in the holding's burndown, IV and SPX panels BEFORE its own, faint, with a rule where it was
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
  add form as "I hold it": on the desk the panel above the table, the Entry focused; on the phone the
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
