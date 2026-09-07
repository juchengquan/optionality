# Dashboard Improvements Plan

**Goal:** Take `/ui` from a working-but-plain table to a dashboard that tells the truth about what it
shows — while keeping it a dense, server-rendered, JavaScript-free table.

**Scope decision:** `/ui` is a **desktop management console**. The Telegram bot already owns the phone
glance (`/quotes`, `/greeks`, `/vol`, pushed alarms), so the dashboard optimises for the two things
Telegram cannot do: every greek visible at once, and real CRUD. Mobile is explicitly not a goal.

**Origin:** grilling session 2026-09-06, from "the frontend is quite a basic one, what can we improve?".
The session turned up four outright defects alongside the cosmetic work; they are called out below because
they change what the screen *means*, not just how it looks.

## Defects found (wrong today, not merely plain)

1. **The highlight does not follow the monitored field.** `ui_table.html` hardcodes `class="hl"` onto delta
   and mid. `_FIELD_COLUMN` exists to map field→column but is only consulted for combos. Monitor
   `option_theta` and the dashboard highlights two columns unrelated to the alarm.
2. **The unknown-contract error is swallowed.** `watchlist_quotes` sets `entry["error"] = "unknown contract"`
   (monitor.py:136) for the deterministic moomoo-named-culprit case. `_quote_rows` never reads it, so a
   contract on its way to quarantine renders as a row of `—`, indistinguishable from OpenD being slow.
3. **Combos display strictly less than singles.** A single row shows moomoo's `name` from the snapshot. A
   combo has no snapshot, so the cell falls back to `q["code"]` — the name you typed. No expiry, no strikes,
   no legs, despite `legs` already riding in the payload (monitor.py:132).
4. **The value and the bell come from different fetches.** Greek columns come from the dashboard's own
   `watchlist_quotes` call; `triggered` comes from `Monitor.triggered`, written by the sweeper on its own
   independent cycle. A row can show `delta 0.598` with the bell lit because the sweep saw `0.601` three
   seconds earlier. The alarm engine is correct; the screen misrepresents it.

Two more design faults, less severe:

5. **Combos sort between calls and puts.** `_create_combo` stores `option_type="CMB"`, and
   `WATCHLIST_ORDER` leads with `option_type`, so `CALL < CMB < PUT` places them by accident.
6. **The muted table conflates three states.** Manual mute, expiry-mute and unknown-contract quarantine all
   set `enabled = False` and land in one undifferentiated list. monitor.py:174 says quarantines are "kept
   for inspection"; the dashboard offers nothing to inspect with.

## Global constraints

- TDD: the failing test comes first, every task. `make test` / `make lint` / `make format` before each commit.
- Branch → PR → owner merges. `make launchd-restart` after each merge (the agent runs this working tree).
- htmx stays the only JavaScript. No CSS framework: assets are vendored and served through routes, because
  Starlette `Mount`s do not resolve behind the path-stripping proxy.
- `data/optionality.db` is live state with no backup. The one migration here (PR 4) must be squashed before
  its branch merges.

## Sequencing

Four PRs. **PR 2 lands before PR 3** so `ui.py`'s six endpoints are rewritten once: both change what
`_live_context` returns.

---

## PR 1 — Render layer and ordering

No schema, no invariant change. Everything here is visible immediately.

- [x] 1.1 `WATCHLIST_ORDER` → `(Monitor.strike_date, Monitor.legs.is_(None), Monitor.option_type,
      Monitor.strike)`. `legs.is_(None)` is False for combos, so ascending puts them first within each
      expiry. Changed globally, not dashboard-locally: the bot's `/list`, `GET /monitors`, the dashboard and
      the muted query all import this constant, and cross-referencing the screen against a Telegram reply is
      exactly when a divergent order bites. Test churn lands across `test_ui.py`, `test_telegram_bot.py`,
      `test_monitors_api.py`.
- [x] 1.2 `_quote_rows` stops discarding data: emit `legs`, `strike_date`, the swallowed `error`, and the
      `_FIELD_COLUMN` lookup for the monitored field so the template can highlight the right column.
- [x] 1.3 `ui_table.html`: `hl` driven by `row.field_column`; two-line contract cell for combos
      (`2026-12-18 · +C6500 -C6600 -P6000 +P5900` in dim small type under the name); an `unknown contract`
      badge on rows carrying the error.
- [x] 1.4 `ui.html` CSS: `prefers-color-scheme` dark palette — not decoration when `DISPLAY_TZ=Asia/Singapore`
      makes the US session 21:30–04:00 local and today's page is `#222` on white. Needs no toggle, no cookie
      and no JS. Plus `font-variant-numeric: tabular-nums` on numeric cells, because `%.4g` yields `0.5981`
      beside `0.06` beside `1.234` and ragged digits defeat column scanning.

## PR 2 — One source of truth for the dashboard

**Edits a ratified invariant.** CLAUDE.md currently reads "The whole watchlist is ONE `get_market_snapshot`
call per sweep/page"; the `/page` half goes away. The CLAUDE.md edit ships in this PR.

- [x] 2.1 `MonitorSweeper` caches its last records plus `fetched_at`. The sweep already fetches every enabled
      monitor's codes with combo legs joined and deduped — precisely the set the dashboard needs.
- [x] 2.2 `_live_context` renders from that cache instead of issuing its own call. The bell and the number
      beside it then come from one instant, and "fetched at" becomes literally true.
- [x] 2.3 Clamp the refresh selector to `monitor_interval_seconds`. With a 15s sweep the 5s and 10s options
      cannot deliver what they promise, and silently lying about freshness is the fault this PR exists to fix.
- [x] 2.4 Update the invariant in CLAUDE.md.

Consequence accepted: the dashboard shows data up to one sweep interval old, and stops calling OpenD at all.

## PR 3 — htmx mutations

- [x] 3.1 The six mutation endpoints return the `ui_table.html` fragment instead of 303. `_redirect` and the
      `?error=` query param retire.
- [x] 3.2 A `position: sticky` error region, swapped out-of-band. The add-combo form sits at the bottom of the
      page; a banner rendered at the top is a banner you never see.
- [x] 3.3 Forms get `hx-post`; add-forms reset on success only. Scroll position survives, so muting a row at
      the bottom of a long watchlist no longer flings you to the top.

## PR 4 — `disabled_reason`

- [x] 4.1 `Monitor.disabled_reason`: nullable `"manual" | "expired" | "unknown-contract"`. Alembic batch-mode
      revision; existing rows backfill NULL and render as "unknown". Squash before merge.
- [x] 4.2 Set it at all three disable sites: `_quarantine_unknown`, the expiry-mute path, and the UI/API toggle.
- [x] 4.3 Muted table groups by reason and shows expired rows their remaining days before
      `EXPIRED_RETENTION_DAYS` deletes them — the only auto-delete in the system, currently with no on-screen
      warning. Quarantine reason genuinely cannot be inferred from the DB; a quarantined row is identical to a
      hand-muted one, which is why this needs a column rather than a heuristic.

---

## Deliberately out of scope

- **Runs and reports get no UI.** `Report.html` stays curl-only. Out of scope under "management console".
- **No charts.** `Monitor.last_value` is a scalar overwritten every sweep; there is no history table. Any
  chart is a schema project with a retention policy, not a frontend task.
- **Auth unchanged.** `API_TOKEN` is empty, so the bearer middleware is a no-op and tailscale is the only
  gate — a browser could not send that header anyway. Deliberate, per the deployment model.
- **Mobile.** Ceded to the bot.
