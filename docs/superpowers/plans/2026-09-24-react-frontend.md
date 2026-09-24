# React frontend at /app

> Implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a React + TypeScript dashboard at `/app`, at full parity with `/ui`, built alongside
it so the owner can judge both on real positions and choose.

**Decided in the grilling session of 2026-09-24** (see ADR 0005): React specifically; assets
compiled locally and committed; `/app` alongside a still-working `/ui`; rebuild the current
screen rather than redesign it; full parity including mutations; the existing palette reused
with no CSS framework, so the comparison is about React and not about Tailwind.

## Global constraints

- uv only, Python ≥ 3.12. `make test` / `make lint` / `make format` before every commit.
- Assets are served by a **route**, never a `StaticFiles` mount: mounts only match the
  `root_path`-prefixed spelling, which `tailscale serve --set-path` never sends.
- `ROOT_PATH=/opt` in production. The browser sees `/opt/…`, the app sees `/…`. Every asset URL
  and every fetch from React must account for it.
- `.gitignore` has a blanket `*.html`, negated only for `templates/*.html`. A built `index.html`
  would be swallowed, so the shell is a Jinja template, not a Vite output.
- launchd runs the working tree. Whatever is committed is what serves.
- `API_TOKEN` is empty; tailscale is the only gate. No new auth.
- The alarm engine is not touched by any of this.

---

## Phase 0 — Restore the API seam (prerequisite, useful regardless)

Nothing else can start until a client can read what the screen shows. ADR 0002 promised this
and it lapsed; ADR 0005 depends on it.

- [x] 0.1 Enrich `build_entries` so every entry carries `dte`, `fill`, the Position link
      (ids, names, `scope`), `cost_to_close`, `entry` and `pnl`. Both `/quotes` and the
      dashboard already go through it, so the drift becomes structurally impossible rather than
      a discipline to remember.
- [x] 0.2 Move `_fill_pct` and the `days_to_expiry` call out of `routes/ui.py` into the domain
      modules. Proximity to a threshold is domain logic, not presentation.
- [x] 0.3 Add `scope` and the Position link to `_to_dict` in `routes/monitors.py`. Today
      `/monitors` cannot say which Position a Monitor watches.
- [x] 0.4 `routes/ui.py` keeps only formatting and column logic. **Acceptance: `_quote_rows`
      contains no arithmetic** — `_fmt_at` calls and the fill/bell column chain, nothing else.
- [x] 0.5 A parity test: every field the dashboard renders must be reachable over HTTP. This is
      the test whose absence let the seam rot.

## Phase 1 — Build plumbing

- [x] 1.1 `frontend/` with Vite + React + TypeScript. `make build-ui` emits to
      `src/optionality/service/static/app/` with `manifest: true`.
- [x] 1.2 A catch-all asset route `GET /static/app/{path:path}` returning `FileResponse`, with
      a guard against path traversal. Not a mount, for the reason above.
- [x] 1.3 `GET /app` renders a Jinja shell that reads Vite's `manifest.json` to find the hashed
      entry files and injects `root_path` for React to build its URLs from. This sidesteps both
      the `.gitignore` trap and the prefix problem.
- [x] 1.4 No client-side router. It is one page; a router would reintroduce the base-path
      problem for no benefit.
- [x] 1.5 Commit the built output. Add `make check-ui`, which rebuilds and fails if the result
      differs from what is committed — the bundle going stale against its source is the known
      risk of this choice, and the same failure that recurs with launchd restarts.

## Phase 2 — Display parity

- [x] 2.1 Fetch `/quotes`, `/positions/values` and `/monitors`; poll at
      `MONITOR_INTERVAL_SECONDS`-aware intervals, matching the cookie the refresh selector sets.
- [x] 2.2 Both tables with today's columns, `tabular-nums`, per-column precision, the fill bar,
      and the fill/bell fallback chain (watched column → alarm → contract). Reuse the existing
      CSS variables so the two dashboards are visually identical.
- [x] 2.3 Positions: entry, cost to close, P&L, exposure-signed greeks.
- [x] 2.4 Muted groups with the retention countdown; health strip; "fetched at … · sweep every
      Ns".
- [x] 2.5 Column pickers, persisting to the **same cookie names** (`ui_cols_single`,
      `ui_cols_combo`, `.`-separated) so both dashboards agree. Client-side only — it is a
      viewer preference and needs no round trip.

## Phase 3 — Mutation parity

The JSON API already covers most of this: `POST/PATCH/DELETE /monitors`, `POST/PATCH/DELETE
/positions`. React uses it exclusively; the `/ui/*` routes stay HTML-only for htmx.

- [x] 3.1 Threshold, mute/unmute, delete, rename.
- [x] 3.2 Create monitor and create combo.
- [x] 3.3 Position entry via `PATCH /positions/{id}`.
- [x] 3.4 **Missing endpoint:** the derive-a-wing-from-a-total flow exists only as
      `POST /ui/monitors/{id}/entry` returning HTML. Add a JSON equivalent.
- [x] 3.5 Optimistic updates where safe; never for anything that changes an alarm threshold,
      where the server's answer is the only truth.

## Phase 4 — Tests

- [x] 4.1 Vitest + Testing Library for components.
- [x] 4.2 **Fixtures must mirror the real watchlist** — a spanning monitor, a wing rule, a leg
      rule, a position with no entry. Every frontend bug shipped on 2026-09-24 passed its tests
      and failed on live data, twice because the fixture was simpler than reality.
- [x] 4.3 A rendering test for the fill/bell fallback chain under hidden columns.
- [x] 4.4 Keep the Python suite as the contract test for the API.

## Phase 5 — Cutover

- [x] 5.1 Run both for a week on real positions.
- [x] 5.2 A written verdict either way, appended to ADR 0005.
- [x] 5.3 If React wins: retire `/ui`, its templates and its HTML-returning routes. If it does
      not: delete `frontend/`, `/app` and the committed bundle, and say so in the ADR.

---

## Risks

- **A committed bundle drifting from its source.** Mitigated by `make check-ui`; it is the same
  class of failure as the stale launchd process, which recurred three times in one day.
- **Two frontends to maintain.** Deliberate and time-boxed to the comparison. If Phase 5 drags,
  that cost compounds.
- **Phase 0 is load-bearing.** If it is skipped or half-done, React reimplements the domain in
  TypeScript and the two drift — the exact outcome ADR 0002 was written to prevent.
