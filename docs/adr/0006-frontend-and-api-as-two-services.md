---
status: supersedes part of ADR-0005
---

# The frontend and the API are two services

ADR 0005 put React in the same process as the API, served by a route. That was the right
shape for growing it alongside htmx. The owner now wants them genuinely separate, which is a
legitimate architectural preference and not one the current arrangement can satisfy by
degrees — the frontend either ships with the API or it does not.

Caddy serves the built bundle on a local port; uvicorn keeps the JSON API on its own. Both
sit behind the same tailnet hostname on different paths, so the browser sees **one origin**
and no CORS or auth change is needed. Tailscale was verified to nest proxy paths before this
was chosen. Its ability to serve a directory outright was tried first and refused — path
serving is unsupported on the sandboxed macOS build — which is why a second process exists
at all.

## What this costs, and what answers it

**Version skew.** One artifact could not disagree with itself. Two can: a bundle expecting
`cost_to_close` on `/quotes` against an API that no longer sends it. This is not theoretical
— stale-process mismatches bit this project three times in a single day with only one process
to keep in step, and separation makes the failure structural rather than accidental.

Answered in two layers:

- A **contract version**, one integer in one file, read by both. The bundle bakes the version
  it was built against; the API reports its own on `/health`. When they differ the dashboard
  says so, in words, instead of failing at whatever field happens to be missing. It is bumped
  by hand and only for breaking changes, so it stays quiet enough to be believed.
- A **single deploy path**, `make deploy`, which pulls, builds and restarts both. Drift then
  requires going out of your way rather than merely forgetting.

Neither prevents skew. Together they make it loud and make the ordinary path safe, which is
the most an arrangement like this can honestly offer.

## Consequences

- Caddy must not do HTTPS. Tailscale terminates TLS at the edge; Caddy binds to 127.0.0.1 and
  speaks plain HTTP, exactly as uvicorn does.
- Assets use relative paths, so the bundle is not coupled to the deploy prefix. That is
  possible only because there is no client-side router — the same reason given in ADR 0005.
- The API loses its `/ui`, `/app` and asset routes, and the shell template with them.
- Two launchd agents, two restarts, two ways to be stale.
