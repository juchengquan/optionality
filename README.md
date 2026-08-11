# Optionality

A lightweight tool designed to help amateur part-time traders (like me) to get timely information for low-frequency options trading.

## Overview

Optionality is a small, simple yet effective tool aimed at providing a report to enhance your decision-making process in options trading. Whether you're a beginner or an experienced trader, this tool is designed to help you stay informed and make smarter trading decisions.


## [IMPORTANT] Prerequisite
- You need to install [Moomoo OpenD](https://www.moomoo.com/download/OpenAPI) on your local machine. For the usage please refer to its manual.
- You need to have the access to [Moomoo Options Real-Time Quotes](https://qtcard.moomoo.com/intro/api-usoption-realtime?type=16&is_support_buy=1&lang=en-us).

## Usage
1. **Clone the Repository**:
   ```bash
   git clone https://github.com/juchengquan/optionality.git
   ```

2. **Install Dependencies** (requires [uv](https://docs.astral.sh/uv/)):
   ```bash
   uv sync
   ```

3. **Configure Settings**:
   Edit a YAML config (see `examples/strategy.yaml`) to set your instruments, holdings, and alert thresholds.
   Gmail credentials come from the `GMAIL_USER` / `GMAIL_APP_PASSWORD` environment variables, never from YAML.

4. **Run the CLI** (no service needed — same core pipeline):
   ```bash
   uv run python main.py -t holdings -f examples/holdings.yaml   # report on current holdings
   uv run python main.py -t strategy -f examples/strategy.yaml   # scan for new strategy candidates
   ```
   The results are saved locally or emailed, per the config's notification block.


## Hosted service

Run optionality as an always-on service: scheduled scans email HTML reports; ad-hoc runs are triggered over the API (expose it inside your tailnet only, e.g. with `tailscale serve`).

To serve under a path prefix — `tailscale serve --bg --set-path /api http://127.0.0.1:8000` — set `ROOT_PATH=/api`
in `.env` so FastAPI generates prefixed URLs (otherwise `/docs` loads but can't fetch `openapi.json`). With
`ROOT_PATH` set, open Swagger through the proxy URL (`https://<machine>.<tailnet>.ts.net/api/docs`), not localhost.

### Setup

1. `cp .env.example .env` and fill in the values.
2. Start OpenD:
   - **macOS / bare-metal host:** run OpenD on the host, keep `OPEND_HOST=host.docker.internal`.
   - **Linux host, Docker:** extract the OpenD Ubuntu build into `./opend`, set `OPEND_HOST=opend`, add `--profile opend-docker` to compose commands. First login may prompt for a verification code: `docker attach optionality-opend`.
3. `docker compose up -d --build`
4. Health check: `curl http://localhost:8000/health` — `"opend": true` means the gateway is reachable.

### Running natively on macOS (launchd)

On a Mac host (where OpenD runs anyway) you can skip Docker and install the service as a launchd agent —
it starts at login and restarts on crash:

```bash
make launchd-install     # render deploy/optionality.launchd.plist.template and start the agent
make launchd-restart     # restart, e.g. after git pull
make launchd-uninstall   # stop and remove
make logs                # tail ~/Library/Logs/optionality.log
```

Enable automatic login (System Settings → Users & Groups) so the agent — and OpenD — come back after an
unattended reboot.

### Everyday use

```bash
AUTH="Authorization: Bearer $API_TOKEN"
# store a config (body = the YAML document as JSON)
curl -X POST localhost:8000/configs -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name": "spx-holdings", "task_type": "holdings", "body": {...}}'
# schedule it for 09:35 ET every weekday
curl -X POST localhost:8000/schedules -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"cron_expr": "35 9 * * mon-fri", "task_type": "holdings", "config_name": "spx-holdings"}'
# ad-hoc run + report
curl -X POST localhost:8000/runs -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"task": "holdings", "config": "spx-holdings"}'
curl localhost:8000/runs/<run_id>/report.html -H "$AUTH"
# per-contract rows from a stored report (optionally ?code=US.SPXW...)
curl localhost:8000/runs/<run_id>/details -H "$AUTH"
# live quote of one SPX weekly contract (single OpenD call)
curl "localhost:8000/spx/quote?strike_date=2026-12-18&option_type=CALL&strike=6500" -H "$AUTH"
# live quotes for every watched code
curl localhost:8000/quotes -H "$AUTH"
# browser dashboard with add/edit/mute/delete forms
open https://<machine>.<tailnet>.ts.net/api/ui
# watch a contract: Telegram alarm when abs(option_delta) crosses 0.6
curl -X POST localhost:8000/monitors -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"strike_date": "2026-12-18", "option_type": "CALL", "strike": 6500, "threshold": 0.6}'
curl localhost:8000/monitors -H "$AUTH"   # live watchlist dashboard (last_value, triggered)
```

### Delta monitors

A background sweep polls the whole watchlist every `MONITOR_INTERVAL_SECONDS` (default 60s, 24×7) with **one**
`get_market_snapshot` call — combo legs join the same batch, deduplicated — so the moomoo rate limit is never a
concern. Each monitor compares its field against a threshold: `compare: abs` (default) uses `abs(value)`,
`compare: signed` uses the raw value (negative thresholds legal — e.g. a bear call spread's mid ≤ -4.05).
Direction `above`/`below` picks the crossing side; `below` on `mid_price` makes a profit-target alert.

The 🔔/triggered state flips truthfully at the exact threshold. Message spam is prevented by time, not value
bands: `ALARM_COOLDOWN_SECONDS` is the minimum gap between a monitor's messages while its state is *changing*
(flap protection), and `ALARM_REPEAT_SECONDS` re-sends "still … (reminder)" while a breach *persists* (0
disables reminders). Creation is gated by a live contract-existence probe on every path (API, UI, bot) —
unknown contracts are rejected up front, and any that appear at runtime are quarantined (muted + Telegram
notice, never deleted) without disturbing the rest of the watchlist. Expired monitors are muted with a notice,
then auto-deleted `EXPIRED_RETENTION_DAYS` (default 7) later. Thresholds are editable in place via
`PATCH /monitors/{id}`, the dashboard, or the bot's `/threshold`. Run failures also alert via Telegram (after
the automatic retry), with gmail as an optional additional channel per config.

**Combo monitors** watch a signed sum over multiple legs (single expiry): value = Σ sign×field per leg, with the
same compare/direction semantics. Sign conventions: for a close-cost profit target put `+` on legs you
sold and `-` on legs you bought (default field `mid_price`); for a net-delta tilt watch use position signs
(`-` shorts, `+` longs) with field `option_delta` and direction `above`. If any leg is missing from a sweep the
combo is skipped — no partial sums. All legs join the same single snapshot call per sweep. Monitors on expired contracts are auto-disabled. If 5 consecutive sweeps fail
(e.g. OpenD logged out), you get one "monitoring degraded" Telegram alert and a recovery note when it heals;
sweep state is visible under `monitor` in `/health`.

**Telegram setup:** create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`, or `/mybots` → API Token
for an existing one) and put the token in `.env` as `TELEGRAM_BOT_TOKEN`. Then send your bot any message and run
`curl "https://api.telegram.org/bot<TOKEN>/getUpdates"` — the `"chat":{"id": ...}` number is `TELEGRAM_CHAT_ID`.

**Two-way bot:** when both Telegram vars are set, the service also long-polls the bot for commands (owner chat
only — messages from any other chat are ignored). Available commands:

```
/monitors                                      watchlist with sweep state (last, thr, armed/🔔)
/quotes                                        live prices: mid, bid/ask
/greeks                                        live delta, gamma, theta
/vol                                           live IV, vega
/watch 2026-12-18 CALL 6500 0.6 [field] [above|below] [signed]   add a monitor (dates: YYYY-MM-DD or YYYYMMDD)
/watchcombo sep-condor 20260918 +C8100 -C8150 10 below [signed]  watch a combo: signed sum over legs
/combo sep-condor                                       per-leg breakdown with the signed total
/threshold sep-condor 25                       change a threshold (by name, contract, or id prefix)
/unwatch 261218 C6500                          remove (by name, contract, code, or id prefix)
/snapshot 2026-12-18 CALL 6500                 live quote for any contract
/health                                        queue + sweep status
```

Only one service instance may poll a given bot token at a time (Telegram getUpdates is single-consumer) — don't
run the local server and the Docker deployment simultaneously with the same bot.

### Runbook

- **Scheduled reports stopped and healthchecks.io alerted:** check `docker compose ps`, then `curl :8000/health`. If `"opend": false`, OpenD is down or logged out — restart/re-login it (this is the most common failure).
- **Failure email arrived:** the run failed twice (one automatic retry). The email includes the error; `GET /runs?status=failed` has details.
- **Debugging the pipeline without the service:** `uv run python main.py -t holdings -f examples/strategy.yaml` uses the same core code against a local OpenD.
- **Schema changes:** `uv run alembic revision --autogenerate -m "..."` then `uv run alembic upgrade head` (fresh databases are created automatically at startup).

## License

Distributed under the GNU Affero General Public License. See `LICENSE` for more information.

## Acknowledgments
- [yfinance](https://github.com/ranaroussi/yfinance)
- [Moomoo OpenAPI](https://openapi.moomoo.com/moomoo-api-doc/intro/intro.html)