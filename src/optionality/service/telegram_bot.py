import json
import logging
import threading
import urllib.parse
import urllib.request

from sqlalchemy import select

from optionality.apis.aux import build_spx_code
from optionality.core import fetch_snapshot
from optionality.service.models import Monitor
from optionality.service.settings import Settings

logger = logging.getLogger("optionality.telegram_bot")

HELP_TEXT = """Commands:
/monitors — list the watchlist with live state
/watch <YYYY-MM-DD> <CALL|PUT> <strike> <threshold> [field] — add a monitor
/unwatch <code or id prefix> — remove a monitor
/snapshot <YYYY-MM-DD> <CALL|PUT> <strike> — live quote
/health — service status
/help — this message"""

BOT_COMMANDS = [
    {"command": "monitors", "description": "List the watchlist with live state"},
    {"command": "watch", "description": "Add a monitor: DATE CALL|PUT strike threshold"},
    {"command": "unwatch", "description": "Remove a monitor by code or id prefix"},
    {"command": "snapshot", "description": "Live quote: DATE CALL|PUT strike"},
    {"command": "health", "description": "Queue and sweep status"},
    {"command": "help", "description": "Show usage"},
]


class TelegramBot(threading.Thread):
    """Long-polls getUpdates and answers commands — from the owner chat only.

    Runs as a daemon thread; only one consumer may poll getUpdates per bot
    token, so never run two service instances against the same bot.
    """

    def __init__(self, session_factory, settings: Settings, api=None, fetcher=None, sweeper=None, worker=None):
        super().__init__(name="optionality-telegram-bot", daemon=True)
        self.session_factory = session_factory
        self.settings = settings
        self.api = api or self._http_api
        self.fetcher = fetcher or fetch_snapshot
        self.sweeper = sweeper
        self.worker = worker
        self.offset = 0
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    def _http_api(self, method: str, params: dict):
        url = f"https://api.telegram.org/bot{self.settings.telegram_bot_token}/{method}"
        data = urllib.parse.urlencode(params).encode()
        with urllib.request.urlopen(url, data=data, timeout=35) as resp:
            payload = json.loads(resp.read().decode())
        if not payload.get("ok"):
            raise RuntimeError(f"telegram {method} failed: {payload}")
        return payload["result"]

    def _register_commands(self) -> None:
        # publishes the "/" autocomplete menu in the Telegram client
        self.api("setMyCommands", {"commands": json.dumps(BOT_COMMANDS)})

    def run(self) -> None:
        try:
            self._register_commands()
        except Exception:
            logger.exception("telegram setMyCommands failed")

        # drain the backlog so a service restart doesn't replay old commands
        try:
            last = self.api("getUpdates", {"offset": -1, "timeout": 0})
            if last:
                self.offset = last[-1]["update_id"] + 1
        except Exception:
            logger.exception("telegram backlog drain failed")

        logger.info("telegram bot polling started")
        while not self._stop.is_set():
            try:
                updates = self.api("getUpdates", {"offset": self.offset, "timeout": 25})
            except Exception:
                logger.exception("telegram getUpdates failed; retrying")
                self._stop.wait(5)
                continue
            for update in updates:
                self.offset = update["update_id"] + 1
                try:
                    self.handle_update(update)
                except Exception:
                    logger.exception("failed handling telegram update %s", update.get("update_id"))

    def handle_update(self, update: dict) -> None:
        message = update.get("message") or {}
        chat_id = str(message.get("chat", {}).get("id", ""))
        if chat_id != self.settings.telegram_chat_id:
            return  # only the owner chat may command the bot; ignore everyone else
        text = (message.get("text") or "").strip()
        if not text:
            return
        reply = self._dispatch(text)
        if reply:
            self.api("sendMessage", {"chat_id": chat_id, "text": reply})

    def _dispatch(self, text: str) -> str:
        parts = text.split()
        command = parts[0].split("@")[0].lstrip("/").lower() if parts[0].startswith("/") else ""
        args = parts[1:]

        if command == "monitors":
            return self._cmd_monitors()
        if command == "watch":
            return self._cmd_watch(args)
        if command == "unwatch":
            return self._cmd_unwatch(args)
        if command == "snapshot":
            return self._cmd_snapshot(args)
        if command == "health":
            return self._cmd_health()
        return HELP_TEXT

    def _cmd_monitors(self) -> str:
        with self.session_factory() as session:
            monitors = session.scalars(select(Monitor).order_by(Monitor.created_at)).all()
        if not monitors:
            return "Watchlist is empty. Add one with /watch."
        lines = []
        for m in monitors:
            state = "🔔 triggered" if m.triggered else "armed"
            if not m.enabled:
                state = "disabled"
            last = f"{m.last_value:.4f}" if m.last_value is not None else "—"
            lines.append(f"{m.id[:8]}  {m.code}\n    {m.field} last={last} thr={m.threshold} [{state}]")
        return "\n".join(lines)

    def _cmd_watch(self, args: list[str]) -> str:
        usage = "Usage: /watch <YYYY-MM-DD> <CALL|PUT> <strike> <threshold> [field]"
        if len(args) < 4:
            return usage
        strike_date, option_type = args[0], args[1].upper()
        if option_type not in ("CALL", "PUT"):
            return usage
        try:
            strike, threshold = float(args[2]), float(args[3])
            code = build_spx_code(strike_date, option_type, strike)
        except ValueError:
            return usage
        field = args[4] if len(args) > 4 else "option_delta"

        with self.session_factory() as session:
            if session.scalar(select(Monitor).where(Monitor.code == code, Monitor.field == field)):
                return f"Already watching {code} ({field})."
            session.add(
                Monitor(
                    code=code,
                    strike_date=strike_date,
                    option_type=option_type,
                    strike=strike,
                    field=field,
                    threshold=threshold,
                )
            )
            session.commit()
        return f"Watching {code}: alarm when abs({field}) ≥ {threshold}"

    def _cmd_unwatch(self, args: list[str]) -> str:
        if not args:
            return "Usage: /unwatch <code or id prefix>"
        token = args[0]
        with self.session_factory() as session:
            matches = session.scalars(
                select(Monitor).where((Monitor.code == token.upper()) | Monitor.id.startswith(token))
            ).all()
            if not matches:
                return f"No monitor matches '{token}'."
            if len(matches) > 1:
                return "Ambiguous — matches: " + ", ".join(m.id[:8] for m in matches)
            code = matches[0].code
            session.delete(matches[0])
            session.commit()
        return f"Removed monitor for {code}."

    def _cmd_snapshot(self, args: list[str]) -> str:
        usage = "Usage: /snapshot <YYYY-MM-DD> <CALL|PUT> <strike>"
        if len(args) < 3 or args[1].upper() not in ("CALL", "PUT"):
            return usage
        try:
            code = build_spx_code(args[0], args[1].upper(), float(args[2]))
        except ValueError:
            return usage
        try:
            records = self.fetcher([code], opend_host=self.settings.opend_host, opend_port=self.settings.opend_port)
        except Exception as err:
            return f"Snapshot failed: {err}"
        if not records:
            return f"No data for {code}."
        r = records[0]
        name = r.get("name") or code
        fields = ["option_delta", "option_implied_volatility", "bid_price", "ask_price", "last_price", "option_theta"]
        lines = [f"{f}: {r[f]}" for f in fields if r.get(f) is not None]
        return f"{name}\n" + "\n".join(lines)

    def _cmd_health(self) -> str:
        lines = []
        if self.worker is not None:
            lines.append(f"queue depth: {self.worker.queue_depth()}")
        if self.sweeper is not None:
            lines.append(f"last sweep: {self.sweeper.last_sweep_at or 'never'} (ok={self.sweeper.last_sweep_ok})")
            lines.append(f"consecutive sweep failures: {self.sweeper.consecutive_failures}")
        return "Service is up.\n" + "\n".join(lines) if lines else "Service is up."
