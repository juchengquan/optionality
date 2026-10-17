# 12. What needs you is polled; the rest is asked for

Date: 2026-10-17

## Status

Accepted. Ratified by the owner on 2026-10-17, in the design session that produced the top line
("both", then "more like a mix of a and b — we can put it into settings side panel").

## Context

The dashboard answers two questions that want opposite treatments. *Does anything need me right
now?* wants one line at the top, read in two seconds without scrolling or tapping. *Where does this
holding actually stand?* wants history, pace, attribution — depth, on demand.

Before this, the page answered neither directly. A fired alarm showed as a 🔔 in one of six rows
across two tables; a Target reached showed as nothing at all, because `PaceLine` printed
`target 0.50` beside a cost of `1.50` and left the comparison to the eye. The service had every
fact needed and no surface said them together.

The obvious design — one complete status panel, always visible — runs into ADR 0010. The dashboard
polls `/quotes` live, one batch per poll per open tab, and that is what makes polling faster cost
something. A complete answer also needs `/positions/values`, which is a second live OpenD batch: a
rule carries a schedule only where it covers one whole holding (ADR 0011), so a leg rule has none,
and a Position no rule watches has no row in `/quotes` at all. Showing everything on the page would
double the per-poll OpenD load for figures that are, most of the time, unchanged and uninteresting.

## Decision

**The urgent surface uses only what is already polled. The complete surface fetches on demand.**

- The page's top line is built from the watchlist poll and `/health`, which the dashboard already
  fetches. It costs nothing extra.
- It **appears only when something needs you**, and says nothing otherwise. Its silence is
  therefore not a verdict — which is what makes the incompleteness honest rather than a lie.
- The **Service panel** fetches `/positions/values` when it is opened, and only then. Opening a
  panel is a deliberate act, so a second live batch is affordable there and nowhere else. It is the
  only surface that may say "nothing needs you" and mean it.
- Both read **one** function, `needs()`, which takes the holdings the panel has and the page does
  not. One definition, two levels of completeness.

Whether a Level has been reached is decided in the service (`exitLevels` → `reached`,
`manage_by_due`), never by a comparison on screen. The dashboard renders the answer.

## Consequences

The page can be silent while something it cannot see needs attention: a holding watched only by a
leg rule, or watched by nothing. That is accepted, and it is why the top line never claims "all
clear" — a claim the page cannot support. The panel carries that claim because it has the data.

A reader who finds the top line deliberately incomplete and wonders why will find this. The
alternative — polling `/positions/values` every 15 seconds so the page could be complete — was
rejected for the reason ADR 0010 gives, and if that reasoning ever changes this decision should be
revisited rather than quietly worked around.

Telegram is unaffected: alarms still push, and `/holdings` answers on demand, through the same
service-side figures.
