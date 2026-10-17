# Optionality

Watching SPX options positions during the US session and raising alarms when they move against you.
One trader, one account, one always-on machine.

A TypeScript service (JSON API, alarm engine, Telegram bot) and a React dashboard, run as two macOS
launchd agents behind one tailnet hostname. A Python package for notebook work is being ported from
the TypeScript (ADR 0014).

## Prerequisites

- [Moomoo OpenD](https://www.moomoo.com/download/OpenAPI) running on the same machine, with its
  websocket port enabled.
- Access to [Moomoo Options Real-Time Quotes](https://qtcard.moomoo.com/intro/api-usoption-realtime?type=16&is_support_buy=1&lang=en-us).
- Node 25 (it runs the TypeScript directly), [Caddy](https://caddyserver.com) for the dashboard,
  [uv](https://docs.astral.sh/uv/) for the Python tooling, and Tailscale for access.

## Running it

```bash
cp .env.example .env          # fill in the Telegram pair and the OpenD websocket key
npm install
make launchd-api-install      # the API on 127.0.0.1:31415
make launchd-ui-install       # Caddy serving frontend/dist
make deploy                   # after every merge: pull, back up the DB, restart both
```

Expose both through one tailnet hostname, the dashboard at `/opt` and the API at `/opt/api`:

```bash
tailscale serve --bg --set-path /opt     http://127.0.0.1:31416
tailscale serve --bg --set-path /opt/api http://127.0.0.1:31415
```

and set `ROOT_PATH=/opt/api` in `.env` so the API's own docs, at `/opt/api/docs`, point at the right
prefix. Enable automatic login so the agents, and OpenD, come back after an unattended reboot.

`make serve` runs a second copy locally on port 31417, against a snapshot of the live database and with
Telegram blanked, so it can never become a second writer or a second bot.

## Monitors

A background sweep checks the whole watchlist every `MONITOR_INTERVAL_SECONDS` with **one** batched
quote call, combo legs included and deduplicated, so the moomoo rate limit is never a concern. Each
monitor compares a field against a threshold: `compare: abs` (the default) uses the absolute value,
`compare: signed` the raw value, where negative thresholds are legal. `above` / `below` picks the
crossing side.

The 🔔 flips truthfully at the exact threshold. Message spam is prevented by time, not by value bands:
`ALARM_COOLDOWN_SECONDS` is the minimum gap between a monitor's messages while its state is changing,
and `ALARM_REPEAT_SECONDS` re-reminds while a breach persists (0 turns reminders off).

Creation is gated by a live check that the contract exists, on every path (API, dashboard, bot). A
contract that turns out unknown at runtime is quarantined (muted, with a Telegram notice, never
deleted). Expired monitors are muted with a notice and deleted `EXPIRED_RETENTION_DAYS` later. If
`DEGRADED_AFTER_FAILURES` sweeps fail in a row, one "monitoring degraded" message goes out, and another
when it recovers.

**Combos** watch a signed sum over several legs of one expiry. Each leg is long or short: **minus is
short** (a leg you sold), plus is long. If any leg is unpriced in a sweep the combo is skipped, never
summed partially, and IV is never summed at all.

**Holdings** record what you actually hold: legs with their Side, contracts and entry. From them the
dashboard and `/holdings` show Cost to close, P&L and the exit schedule (ADR 0011).

## Telegram

Create a bot with [@BotFather](https://t.me/BotFather) and put its token in `.env` as
`TELEGRAM_BOT_TOKEN`. Send it any message, then read `"chat":{"id": ...}` from
`https://api.telegram.org/bot<TOKEN>/getUpdates` for `TELEGRAM_CHAT_ID`, before the service starts
polling. The bot answers only that chat. `/help` lists the commands: `/holdings`, `/monitors`,
`/quotes`, `/greeks`, `/vol`, `/watch`, `/watchcombo`, `/combo`, `/threshold`, `/rename`, `/unwatch`,
`/snapshot` and `/health`.

Telegram allows one long-poll consumer per token. Only the launchd agent starts the bot
(`OPTIONALITY_BOT=1`), so a local run cannot take half your commands.

## Runbook

- **Alarms went quiet:** `curl :31415/health`. `"opend": false` means OpenD is down or logged out;
  restart or re-login it. This is the most common failure.
- **After a merge:** `make deploy`. launchd does not watch the repo, so a merge alone changes nothing
  that runs.
- **Developing:** see `CLAUDE.md` for the commands, the invariants and the schema-change procedure.

## License

MIT. See `LICENSE`.

## Acknowledgments

- [Moomoo OpenAPI](https://openapi.moomoo.com/moomoo-api-doc/intro/intro.html)
