# 6. The frontend and the API are two services

Date: 2026-09-24

## Status

Accepted. Replaced ADR 0005's arrangement of React served by a route in the API process. Its
answer to version skew (a contract version and a banner) was retired by ADR 0009, phase 8.

## Decision

Two launchd agents behind one tailnet hostname: Caddy serves the built bundle at `/opt` from a
local port, and the API serves JSON at `/opt/api`. One hostname means **one origin**, so no CORS
and no auth change. The separation was the owner's architectural preference, and the old
arrangement could not satisfy it by degrees — the frontend either ships with the API or it does
not. A second process exists only because tailscale cannot serve a directory itself on the
sandboxed macOS build; that was tried first.

## Consequences

- **Caddy does not do HTTPS.** Tailscale terminates TLS at the edge; Caddy binds to 127.0.0.1 and
  speaks plain HTTP, as the API does.
- **The bundle is built for its prefix** (`UI_BASE`, baked at build time), because `tailscale
  serve` strips the path and the page cannot discover it. A visible coupling, accepted.
- **Two agents, two ways to be stale.** `make deploy` restarts both, and is the only way to land a
  merge. Shape drift between them is a compile error since the frontend takes its types from the
  API (`hc<AppType>`, ADR 0009); what remains is a bundle from one commit served beside an API
  from another, which is what restarting both addresses.

## The API token is deliberately unset, and that is parked

`API_TOKEN` is empty, so the bearer check is skipped and every route is reachable from the tailnet;
the tailnet is the one defence, which is the posture this decision chose. Examined on 2026-10-15
and **parked, knowingly** — recorded so it is a decision rather than an oversight, and so nobody
re-discovers it as news.

Tolerable because the tailnet is a private network of the owner's own devices, the service holds no
credentials beyond `.env`, and there is no public ingress. The cost: the destructive routes —
`DELETE /positions/:id`, which also drops that holding's samples, and `DELETE /monitors/:id` — are
reachable without a secret. Setting it is a one-line `.env` change; the dashboard needs nothing,
being same-origin, which is why parking costs nothing to reverse.
