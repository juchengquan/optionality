# Architecture decisions

One file per decision: what was decided, why, and what it binds. They are kept after they are
implemented — that is when they start to matter, by stopping a decision being undone by someone
who does not know the reason — and condensed once the work is done, so what remains is what is
still in force. Git holds the full history of each.

| # | Decision | Status |
|---|---|---|
| [1](0001-positions-own-legs.md) | Positions own legs; Monitors only warn | amended by 3, 13 |
| [3](0003-monitors-may-watch-part-of-a-position.md) | Monitors may watch part of a Position | premise corrected by 4 |
| [4](0004-a-monitor-may-span-positions.md) | A Monitor may span several Positions | in force |
| [5](0005-react-frontend-at-app.md) | A React frontend | in force; serving changed by 6 |
| [6](0006-frontend-and-api-as-two-services.md) | The frontend and the API are two services | in force |
| [7](0007-shadcn-on-base-ui-for-the-controls.md) | shadcn/ui on Base UI for the controls | in force |
| [8](0008-one-adaptive-layout-measured-not-guessed.md) | One adaptive layout, measured rather than guessed | in force, amended after use |
| [9](0009-the-backend-moves-to-typescript.md) | The backend moves to TypeScript | complete; its phases are cited in code |
| [10](0010-the-dashboard-polls-live-quotes.md) | The dashboard polls live quotes | in force |
| [11](0011-exit-schedules-from-a-decay-shape.md) | Exit schedules come from a decay shape | in force |
| [12](0012-what-needs-you-is-polled-the-rest-is-asked-for.md) | What needs you is polled; the rest is asked for | in force |
| [13](0013-side-is-long-or-short.md) | A Leg's Side is long or short | in force |
| [14](0014-the-python-returns-as-a-library.md) | The Python returns as a library, checked against the TypeScript | in force |

2 (server-rendered HTML over a SPA) was deleted once 5 replaced it entirely; nothing of it remained
in force. A new decision takes the next number, and numbers are never reused.
