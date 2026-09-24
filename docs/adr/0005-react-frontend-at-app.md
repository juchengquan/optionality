---
status: supersedes ADR-0002
---

# A React frontend, now the dashboard at /ui

ADR 0002 deferred a JS/TS rebuild and named what would justify revisiting it: charts, or more
than one viewer. Neither has arrived. The decision is taken anyway, on the owner's call, after
the alternatives were laid out — stay with htmx, Alpine, a Python-native reactive UI, islands,
a spike, or Grafana for the viewing half. The preference is for a mainstream, typed frontend,
and that is a legitimate thing to want from a tool you look at every trading session.

Two pieces of evidence were weighed. In favour: of roughly eight defects shipped in a single
day of frontend work, five were hand-written HTML, CSS or htmx-attribute faults — a class a
typed component layer largely removes. Against: the other three, including the worst of them,
were domain-logic and test-fixture faults that no framework touches, and the deployment has no
build step, which is the property that keeps it simple.

## What this decision rests on

**The API restoration comes first, and is not optional.** ADR 0002 promised the JSON API would
stay expressive enough that a rebuild was a frontend project rather than a backend redesign.
That promise lapsed: `scope`, the Position link, `cost_to_close`, `entry`, `pnl`, `fill` and
`dte` appear zero times across `/quotes` and `/monitors`. A React client today could not
discover which Position a Monitor watches. Restoring that seam is what makes this a thin client
rather than a second implementation of the domain.

## Consequences

- Built assets are committed. Unfashionable, but it preserves the property that what is in the
  working tree is what runs, and keeps node off the critical path — a failed build must never
  become a failed deploy on the machine the alarms run on. The risk it accepts is a bundle that
  drifts from its source, which is the same stale-code failure that recurs with launchd.
- `/ui` and `/app` both run until the owner chooses. Two frontends are maintained meanwhile,
  deliberately, so the comparison happens on real positions rather than on argument.
- Assets are served by a route, never a `StaticFiles` mount, and the shell is rendered by Jinja
  from Vite's manifest — mounts do not resolve behind the path-stripping proxy, and a built
  `index.html` would be swallowed by `.gitignore`'s blanket `*.html`.
- No new auth. `API_TOKEN` is empty and tailscale remains the only gate, exactly as for `/ui`.

## Outcome

React reached parity across display, mutations and tests, and was preferred on use. It now
serves `/ui` — the URL the dashboard has always had, since bookmarks, the tailscale path and
muscle memory all point there. `/app`, where it grew up alongside htmx, redirects there so a
bookmark from that period still lands, leaving one canonical URL.

The htmx implementation is deleted: six templates, the vendored htmx, sixteen HTML-returning
routes and 1152 lines of tests. `routes/ui.py` went from 697 lines to 70, and now does nothing
but hand over a bundle. It is all in the history if the reasoning ever needs revisiting.

Three refusal branches of `apply_total_entry` had been covered only through the HTML routes,
and were re-covered against the JSON API rather than allowed to lapse — deleting a frontend
should not quietly delete tests of the domain beneath it.

The cost this decision accepted is now real and permanent: the deployment has a build step,
and `make check-ui` is what stands between a committed bundle and its source drifting apart.
