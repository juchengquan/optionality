# 5. A React frontend

Date: 2026-09-24

## Status

Accepted. Replaced the server-rendered htmx dashboard (the former ADR 0002, which had deferred a
rebuild). How it is served was changed by ADR 0006; how it gets its types, by ADR 0009.

## Decision

The dashboard is React with TypeScript, built by Vite. Not forced by a feature — the tests the htmx
decision had set for revisiting (charts, more than one viewer) had not arrived — but chosen by the owner, after
htmx, Alpine, a Python-native reactive UI, islands and Grafana were laid out, for a mainstream,
typed frontend. The evidence weighed both ways: five of eight defects in one day of htmx work were
hand-written HTML, CSS or attribute faults that a typed component layer removes; the other three,
the worst among them, were domain and fixture faults no framework touches.

It rests on the API being expressive enough that the client stays thin — scope, the Position link,
Cost to close, Entry, P&L, fill and DTE all come from the API, never assembled in the browser.
That seam had lapsed and was restored first; without it the client would be a second
implementation of the domain.

## Consequences

- **The built bundle is committed** (`frontend/dist`). It keeps node off the deploy path — a failed
  build must never become a failed deploy on the machine the alarms run on — at the cost of a
  bundle that can drift from its source, which `make check-ui` exists to catch.
- **No client-side router**, and the detail sheet's back-button entry is not one either (ADR 0008):
  no addresses, nothing shareable.
- **No new auth.** Same origin, inside the tailnet; see ADR 0006 on the API token.
