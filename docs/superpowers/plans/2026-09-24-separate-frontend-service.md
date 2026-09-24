# Separating the frontend onto Caddy

Two services behind one tailnet hostname. Caddy serves the built bundle, uvicorn keeps the
JSON API, and the browser sees one origin — so no CORS, no auth change, no new hostname.
Reasoning and the trade-off live in [ADR 0006](../../adr/0006-frontend-and-api-as-two-services.md).

## What was verified before planning

- Tailscale **cannot** serve a directory on macOS — "path serving is not supported due to
  sandbox restrictions". A second process is therefore unavoidable, not a preference.
- Tailscale **does** nest proxy paths: `/probe` and `/probe/api` both resolved, longest prefix
  winning. Config was snapshotted and confirmed byte-identical after the test.
- Tailscale **strips** the prefix before proxying, and **does not rewrite redirects**. The
  existing `/code` handler proves the second half: it 302s to `/?folder=…`, dropping `/code`
  and landing on the tailnet root. Caddy must therefore never issue a redirect, and relative
  asset paths are unsafe — a visitor at `/opt` with no trailing slash would resolve
  `./assets/main.js` against the root and get nothing.

That last finding is why the bundle gets an absolute base path rather than the relative one
ADR 0005 preferred. It is a knob, not a hardcoding: `UI_BASE` in the Makefile.

## Layout after the change

```
tailnet /opt      → 127.0.0.1:31416  Caddy      → frontend/dist
tailnet /opt/api  → 127.0.0.1:31415  uvicorn    → the JSON API
```

`/opt/app` and any other unknown path fall through Caddy's `try_files` to `index.html`, so
old bookmarks still land on the dashboard without the redirect the API used to serve.

## Steps

### 1. Contract version

`contract.json` at the repo root holds one integer. Python reads it at import; Vite bakes it
into the bundle at build. `/health` grows a `contract_version` field. The dashboard compares
the two on load and, when they disagree, says so in the status strip in plain words instead
of failing at whatever field went missing.

Bumped by hand, and only when the API changes in a way an older bundle cannot survive —
removing or renaming a field, changing a unit, changing a shape. Adding a field is not a bump.
Kept rare so the banner stays believable.

### 2. Frontend build moves out of the Python package

- `outDir` → `frontend/dist`; `index.html` is emitted again (no Jinja shell to replace it).
- `base` comes from `VITE_BASE`, set by `make build-ui` from `UI_BASE ?= /opt/`.
- The API base is derived from the same value — `import.meta.env.BASE_URL + "api"` — so one
  knob governs both and they cannot disagree.
- `window.OPTIONALITY_ROOT` and the `rootPath` prop go away.
- `.gitignore` needs two negations: `dist/` and `*.html` both swallow the output. The same
  trap already ate `templates/` once; the comment there explains why the negation exists.

The bundle stays **committed**. Node off the deploy path was worth having when one process
served both, and it is worth more now that a failed build would leave Caddy with nothing to
serve at all. `make check-ui` keeps catching drift.

### 3. Caddy

`deploy/Caddyfile`, committed, path-free — the document root arrives as an environment
variable from the launchd plist, the way `__REPO__` reaches the uvicorn one.

- binds `127.0.0.1:31416`, `auto_https off` (Tailscale terminates TLS), `admin off`
- `try_files {path} /index.html`
- hashed assets immutable for a year; `index.html` `no-store`, so a deploy is picked up on
  the next load rather than the next cache expiry

`deploy/optionality-ui.launchd.plist.template` mirrors the existing one: label
`com.optionality.ui`, `KeepAlive`, its own log. `make launchd-ui-install` /
`launchd-ui-restart` / `launchd-ui-uninstall` alongside the existing targets.

### 4. The API stops serving the frontend

Delete `routes/ui.py`, `templates/app.html`, `static/app/`, and the router registration.
`ROOT_PATH` becomes `/opt/api`. Tests that reach `/ui` go with it.

### 5. One deploy path

`make deploy`: pull, sync, back up the database, migrate, restart both agents. Drift then
needs deliberate effort rather than a forgotten step — which is the actual failure mode here,
three times over in one day.

### 6. Cutover

```
brew install caddy
make launchd-ui-install
tailscale serve --bg --set-path /opt/api http://127.0.0.1:31415   # API first
tailscale serve --bg --set-path /opt     http://127.0.0.1:31416   # then repoint the root
```

API first so there is no window where the dashboard is up and its API is not.

**Rollback** is one command — `tailscale serve --bg --set-path /opt http://127.0.0.1:31415` —
plus reverting the merge. Worth knowing before starting, since this touches live networking.

## Checklist

- [ ] contract.json + Python reader + `/health` field + skew banner + tests
- [ ] vite outDir/base, API base from `BASE_URL`, drop `rootPath`, gitignore negations
- [ ] Caddyfile + ui plist template + Makefile targets
- [ ] strip the frontend routes out of the API
- [ ] `make deploy`
- [ ] CLAUDE.md: two services, two restarts, when to bump the contract
- [ ] cutover
