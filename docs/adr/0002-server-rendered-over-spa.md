---
status: superseded by ADR-0005
---

# Server-rendered HTML over a SPA framework

The dashboard renders Jinja templates with htmx and no JavaScript of our own. A rebuild in
JS/TS was weighed and deferred: against four Positions and eight Monitors, for one trader on a
tailnet, a SPA buys responsiveness this data does not need. It would cost a node toolchain in a
uv-only repo, a build step in a deployment that currently has none (launchd runs uvicorn straight
from the working tree), a second test stack beside a suite that runs in seconds, and browser auth
where there is none today. "The dashboard looks plain" is a design problem and is being answered
with design.

## What would change this

Time-series and interactive charts, or multiple concurrent viewers. Those are the features a
framework can actually spend its budget on. Until then the JSON API is kept expressive enough —
Positions, Cost to close and P&L exposed there, not assembled only inside templates — so that a
future rebuild is a frontend project rather than a backend redesign too.
