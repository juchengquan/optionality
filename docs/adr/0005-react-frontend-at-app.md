---
status: supersedes ADR-0002
---

# A React frontend, built alongside at /app

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
