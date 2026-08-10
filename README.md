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
   Edit the `hondings.yaml` or `strategy.yaml` file in `examples` to set up your API keys, preferred data, and alert thresholds.

4. **Run the Application**:
   ```bash
   python main.py -t holdings -f ./_examples/holdings.yaml  # To get information for current holdings 
   ```
   or 
   ```bash
   python main.py -t strategy -f ./_examples/strategy.yaml # To get new information for new strategies
   ```
   The results will be saved locally or sent via email address if set in the config file.


## Hosted service

Run optionality as an always-on service: scheduled scans email HTML reports; ad-hoc runs are triggered over the API (expose it inside your tailnet only, e.g. with `tailscale serve`).

### Setup

1. `cp .env.example .env` and fill in the values.
2. Start OpenD:
   - **macOS / bare-metal host:** run OpenD on the host, keep `OPEND_HOST=host.docker.internal`.
   - **Linux host, Docker:** extract the OpenD Ubuntu build into `./opend`, set `OPEND_HOST=opend`, add `--profile opend-docker` to compose commands. First login may prompt for a verification code: `docker attach optionality-opend`.
3. `docker compose up -d --build`
4. Health check: `curl http://localhost:8000/health` — `"opend": true` means the gateway is reachable.

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
# live snapshot of one SPX weekly contract (single OpenD call)
curl "localhost:8000/spx/snapshot?strike_date=2026-12-18&option_type=CALL&strike=6500" -H "$AUTH"
```

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