import html
import json
import logging
import re
import threading
import urllib.parse
import urllib.request

from sqlalchemy import or_, select

from optionality.apis.aux import build_spx_code, normalize_strike_date
from optionality.core import fetch_snapshot
from optionality.service.models import Monitor
from optionality.service.monitor import WATCHLIST_ORDER, monitor_leg_codes, watchlist_quotes
from optionality.service.settings import Settings
from optionality.service.timefmt import display_time_short

logger = logging.getLogger("optionality.telegram_bot")

HELP_TEXT = """Commands:
/monitors — list the watchlist with live state
/quotes — live prices (mid, bid/ask) for every watched code
/greeks — live delta/gamma/theta for every watched code
/vol — live IV/vega for every watched code
/watch <date> <CALL|PUT> <strike> <threshold> [field] [above|below] — add a monitor
/watchcombo <name> <date> <±C|Pstrike ...> <threshold> [field] [above|below] — watch a combo (e.g. a condor)
/unwatch <name, code, id prefix, or contract like 260918 C8100> — remove a monitor
/combo <name> — per-leg breakdown of a combo
/threshold <name or contract> <value> — change a monitor's threshold
/snapshot <date> <CALL|PUT> <strike> — live quote
(dates: YYYY-MM-DD or YYYYMMDD)
/health — service status
/help — this message"""


_FIELD_FORMATS = {"option_delta": ".3f", "option_implied_volatility": ".3f"}


def _fmt_value(key: str, value) -> str:
    fmt = _FIELD_FORMATS.get(key)
    if fmt and isinstance(value, int | float):
        return f"{value:{fmt}}"
    return str(value)


_SPXW_CODE = re.compile(r"US\.SPXW(\d{6})([CP])(\d+?)000$")

_FIELD_SHORT = {"option_delta": "delta", "mid_price": "mid", "option_implied_volatility": "IV"}


def _short_code(code: str) -> str:
    m = _SPXW_CODE.match(code)
    if not m:
        return code
    return f"{m.group(1)} {m.group(2)}{m.group(3)}"


def _table(headers: list[str], rows: list[list[str]]) -> str:
    # Telegram has no table markup; a <pre> block with space-aligned columns is the idiom
    escaped = [[html.escape(str(cell)) for cell in row] for row in [headers, *rows]]
    widths = [max(len(row[i]) for row in escaped) for i in range(len(headers))]
    lines = ["  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip() for row in escaped]
    return "<pre>" + "\n".join(lines) + "</pre>"


BOT_COMMANDS = [
    {"command": "monitors", "description": "List the watchlist with live state"},
    {"command": "quotes", "description": "Live prices (mid, bid/ask) for every watched code"},
    {"command": "greeks", "description": "Live delta/gamma/theta for every watched code"},
    {"command": "vol", "description": "Live IV/vega for every watched code"},
    {"command": "watch", "description": "Add a monitor: DATE CALL|PUT strike threshold"},
    {"command": "watchcombo", "description": "Watch a combo: NAME DATE ±Cstrike ±Pstrike ... threshold"},
    {"command": "unwatch", "description": "Remove a monitor by name, code, or id prefix"},
    {"command": "combo", "description": "Per-leg breakdown of a combo"},
    {"command": "threshold", "description": "Change a monitor's threshold: NAME|contract value"},
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
            params = {"chat_id": chat_id, "text": reply}
            if reply.startswith("<pre>"):
                params["parse_mode"] = "HTML"
            self.api("sendMessage", params)

    def _dispatch(self, text: str) -> str:
        parts = text.split()
        command = parts[0].split("@")[0].lstrip("/").lower() if parts[0].startswith("/") else ""
        args = parts[1:]

        if command == "monitors":
            return self._cmd_monitors()
        if command == "quotes":
            return self._cmd_quotes()
        if command == "greeks":
            return self._cmd_greeks()
        if command == "vol":
            return self._cmd_vol()
        if command == "watch":
            return self._cmd_watch(args)
        if command == "watchcombo":
            return self._cmd_watchcombo(args)
        if command == "combo":
            return self._cmd_combo(args)
        if command == "unwatch":
            return self._cmd_unwatch(args)
        if command == "threshold":
            return self._cmd_threshold(args)
        if command == "snapshot":
            return self._cmd_snapshot(args)
        if command == "health":
            return self._cmd_health()
        return HELP_TEXT

    def _cmd_monitors(self) -> str:
        with self.session_factory() as session:
            monitors = session.scalars(select(Monitor).order_by(*WATCHLIST_ORDER)).all()
        if not monitors:
            return "Watchlist is empty. Add one with /watch."
        rows = []
        for m in monitors:
            state = "🔔" if m.triggered else "armed"
            if not m.enabled:
                state = "off"
            if m.last_value is None:
                last = "—"
            elif m.field in _FIELD_FORMATS:
                last = _fmt_value(m.field, m.last_value)
            else:
                last = f"{m.last_value:.4f}"
            thr = f"{'≤' if m.direction == 'below' else '≥'}{m.threshold}"
            rows.append([_short_code(m.code), _FIELD_SHORT.get(m.field, m.field), last, thr, state])
        return _table(["contract", "field", "last", "thr", "state"], rows)

    def _cmd_quotes(self) -> str:
        try:
            quotes = watchlist_quotes(self.session_factory, self.settings, self.fetcher)
        except Exception as err:
            return f"Quotes failed: {err}"
        if not quotes:
            return "Watchlist is empty. Add one with /watch."
        rows = []
        for q in quotes:
            snap = q["snapshot"] or {}
            mid = str(snap["mid_price"]) if snap.get("mid_price") is not None else "—"
            if snap.get("bid_price") is not None and snap.get("ask_price") is not None:
                bid_ask = f"{snap['bid_price']}/{snap['ask_price']}"
            else:
                bid_ask = "—"
            contract = _short_code(q["code"]) + (" 🔔" if q["triggered"] else "")
            rows.append([contract, mid, bid_ask])
        return _table(["contract", "mid", "bid/ask"], rows)

    def _cmd_greeks(self) -> str:
        try:
            quotes = watchlist_quotes(self.session_factory, self.settings, self.fetcher)
        except Exception as err:
            return f"Greeks failed: {err}"
        if not quotes:
            return "Watchlist is empty. Add one with /watch."
        rows = []
        for q in quotes:
            snap = q["snapshot"] or {}
            delta = _fmt_value("option_delta", snap["option_delta"]) if snap.get("option_delta") is not None else "—"
            # SPX gammas are ~1e-4, so five decimals; .3f would render every gamma as 0.000
            gamma = f"{snap['option_gamma']:.5f}" if snap.get("option_gamma") is not None else "—"
            theta = f"{snap['option_theta']:.2f}" if snap.get("option_theta") is not None else "—"
            contract = _short_code(q["code"]) + (" 🔔" if q["triggered"] else "")
            rows.append([contract, delta, gamma, theta])
        return _table(["contract", "delta", "gamma", "theta"], rows)

    def _cmd_vol(self) -> str:
        try:
            quotes = watchlist_quotes(self.session_factory, self.settings, self.fetcher)
        except Exception as err:
            return f"Vol failed: {err}"
        if not quotes:
            return "Watchlist is empty. Add one with /watch."
        rows = []
        for q in quotes:
            snap = q["snapshot"] or {}
            iv = (
                _fmt_value("option_implied_volatility", snap["option_implied_volatility"])
                if snap.get("option_implied_volatility") is not None
                else "—"
            )
            vega = f"{snap['option_vega']:.2f}" if snap.get("option_vega") is not None else "—"
            contract = _short_code(q["code"]) + (" 🔔" if q["triggered"] else "")
            rows.append([contract, iv, vega])
        return _table(["contract", "IV", "vega"], rows)

    def _cmd_watch(self, args: list[str]) -> str:
        usage = "Usage: /watch <YYYY-MM-DD> <CALL|PUT> <strike> <threshold> [field] [above|below]"
        if len(args) < 4:
            return usage
        option_type = args[1].upper()
        if option_type not in ("CALL", "PUT"):
            return usage
        try:
            strike_date = normalize_strike_date(args[0])
            strike, threshold = float(args[2]), float(args[3])
            code = build_spx_code(strike_date, option_type, strike)
        except ValueError:
            return usage
        if threshold <= 0:
            return "Threshold must be positive — values are compared as absolutes (abs(value) vs threshold)."
        field, direction = "option_delta", "above"
        for extra in args[4:6]:
            if extra.lower() in ("above", "below"):
                direction = extra.lower()
            else:
                field = extra

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
                    direction=direction,
                )
            )
            session.commit()
        sign = "≤" if direction == "below" else "≥"
        return f"Watching {code}: alarm when abs({field}) {sign} {threshold}"

    _LEG_TOKEN = re.compile(r"^([+-])([CP])(\d+(?:\.\d+)?)$")

    def _cmd_watchcombo(self, args: list[str]) -> str:
        usage = "Usage: /watchcombo <name> <date> <±C|Pstrike ...> <threshold> [field] [above|below]"
        if len(args) < 5:
            return usage
        name = args[0]
        try:
            strike_date = normalize_strike_date(args[1])
        except ValueError:
            return usage

        legs, i = [], 2
        while i < len(args) and (m := self._LEG_TOKEN.match(args[i].upper())):
            legs.append(
                {
                    "sign": 1 if m.group(1) == "+" else -1,
                    "option_type": "CALL" if m.group(2) == "C" else "PUT",
                    "strike": float(m.group(3)),
                }
            )
            i += 1
        if len(legs) < 2 or i >= len(args):
            return usage
        try:
            threshold = float(args[i])
        except ValueError:
            return usage
        if threshold <= 0:
            return "Threshold must be positive — values are compared as absolutes (abs(value) vs threshold)."
        field, direction = "mid_price", "above"
        for extra in args[i + 1 : i + 3]:
            if extra.lower() in ("above", "below"):
                direction = extra.lower()
            else:
                field = extra

        with self.session_factory() as session:
            if session.scalar(select(Monitor).where(Monitor.code == name, Monitor.field == field)):
                return f"Already watching {name} ({field})."
            session.add(
                Monitor(
                    code=name,
                    strike_date=strike_date,
                    option_type="CMB",
                    strike=0.0,
                    field=field,
                    threshold=threshold,
                    direction=direction,
                    legs=legs,
                )
            )
            session.commit()
        sign = "≤" if direction == "below" else "≥"
        return f"Watching combo {name} ({len(legs)} legs): alarm when abs({field}) {sign} {threshold}"

    def _cmd_combo(self, args: list[str]) -> str:
        if not args:
            return "Usage: /combo <name>"
        with self.session_factory() as session:
            monitor = session.scalar(select(Monitor).where(Monitor.code == args[0], Monitor.legs.is_not(None)))
        if monitor is None:
            return f"No combo named '{args[0]}'."
        codes = monitor_leg_codes(monitor)
        try:
            records = self.fetcher(
                sorted(set(codes)), opend_host=self.settings.opend_host, opend_port=self.settings.opend_port
            )
        except Exception as err:
            return f"Combo failed: {err}"
        by_code = {r.get("code"): r for r in records}

        rows, total, complete = [], 0.0, True
        for leg, code in zip(monitor.legs, codes, strict=True):
            record = by_code.get(code)
            value = record.get(monitor.field) if record else None
            sign_str = "+" if leg["sign"] > 0 else "-"
            if value is None:
                rows.append([sign_str, _short_code(code), "—"])
                complete = False
            else:
                total += leg["sign"] * value
                rows.append([sign_str, _short_code(code), _fmt_value(monitor.field, value)])
        total_cell = _fmt_value(monitor.field, round(total, 4)) if complete else "incomplete"
        rows.append(["", "total", total_cell])
        return _table(["", "leg", _FIELD_SHORT.get(monitor.field, monitor.field)], rows)

    @staticmethod
    def _identifier_conditions(args: list[str]):
        token = args[0]
        joined = "".join(args).upper()
        conditions = [Monitor.code == joined, Monitor.code == token, Monitor.id.startswith(token)]
        short = re.fullmatch(r"(\d{6})([CP])(\d+)", joined)
        if short:
            conditions.append(Monitor.code == f"US.SPXW{short.group(1)}{short.group(2)}{short.group(3)}000")
        return conditions

    def _cmd_threshold(self, args: list[str]) -> str:
        if len(args) < 2:
            return "Usage: /threshold <name, code, id prefix, or contract> <value>"
        try:
            value = float(args[-1])
        except ValueError:
            return "Usage: /threshold <name, code, id prefix, or contract> <value>"
        if value <= 0:
            return "Threshold must be positive — values are compared as absolutes (abs(value) vs threshold)."
        with self.session_factory() as session:
            matches = session.scalars(select(Monitor).where(or_(*self._identifier_conditions(args[:-1])))).all()
            if not matches:
                return f"No monitor matches '{' '.join(args[:-1])}'."
            if len(matches) > 1:
                return "Ambiguous — matches: " + ", ".join(m.code for m in matches)
            monitor = matches[0]
            monitor.threshold = value
            code, direction, field = monitor.code, monitor.direction, monitor.field
            session.commit()
        sign = "≤" if direction == "below" else "≥"
        return f"{code}: alarm when abs({field}) {sign} {value}"

    def _cmd_unwatch(self, args: list[str]) -> str:
        if not args:
            return "Usage: /unwatch <name, code, id prefix, or contract like 260918 C8100>"
        with self.session_factory() as session:
            matches = session.scalars(select(Monitor).where(or_(*self._identifier_conditions(args)))).all()
            if not matches:
                return f"No monitor matches '{' '.join(args)}'."
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
        fields = [
            "option_delta",
            "option_implied_volatility",
            "mid_price",
            "bid_price",
            "ask_price",
            "last_price",
            "option_theta",
        ]
        lines = [f"{f}: {_fmt_value(f, r[f])}" for f in fields if r.get(f) is not None]
        return f"{name}\n" + "\n".join(lines)

    def _cmd_health(self) -> str:
        lines = []
        if self.worker is not None:
            lines.append(f"queue depth: {self.worker.queue_depth()}")
        if self.sweeper is not None:
            sweep_at = display_time_short(self.sweeper.last_sweep_at, self.settings.display_tz) or "never"
            lines.append(f"last sweep: {sweep_at} (ok={self.sweeper.last_sweep_ok})")
            lines.append(f"consecutive sweep failures: {self.sweeper.consecutive_failures}")
        return "Service is up.\n" + "\n".join(lines) if lines else "Service is up."
