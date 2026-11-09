"""Settings, read from the environment. Port of backend/src/env.ts.

Behaviour knobs live in `.env`, which mirrors `.env.example`'s structure: active lines are overrides,
commented lines show defaults (CLAUDE.md). The variable names and the defaults below are therefore
part of the deployment, not implementation detail — a renamed variable silently reverts a knob the
owner has set, and both backends read the one `.env` (ADR 0021).

**Where the Python differs, and why.** `Settings` is a frozen dataclass and its fields are
`snake_case`; the VARIABLES are the TypeScript's, letter for letter. The compiler held `FROM_ENV` to
`Settings` (`satisfies Record<keyof Settings, string>`); here `tests/test_env.py` does. A number is
read with `optionality.js.number`, which is JavaScript's `Number` — so `0x10` is 16 and `1_000` is
not a number, where Python's `float` says the opposite of both — and "set to nothing" trims as
JavaScript's `trim` does, not as `str.strip`. A count is kept as an `int` and a fraction as a
`float`, which is the one distinction JavaScript's single number type cannot make.

**`.env` itself is read here too**, which the TypeScript never does: Node reads it for `main.ts`, from
the `--env-file=.env` in the launchd plist, before `main.ts` runs. Python has no such flag, so the
Python's plist passes the same flag to `-m optionality_backend` and `__main__` hands it to
`load_env_file` before anything else — the same file, read the same way. "The same way" is Node's
reader, quirks and all (`parse_env_file`), held to the real `node --env-file` by `tests/test_env.py`
rather than to a description of it: a library such as `python-dotenv` keeps a `#` inside a value that
Node cuts at, and expands `${VAR}` where Node does not, so one `.env` would mean two things.
"""

import dataclasses
import math
import os
from collections.abc import Mapping, MutableMapping
from dataclasses import dataclass

from optionality.js import js_string, number


@dataclass(frozen=True)
class Settings:
    db_path: str
    #: which Provider this deployment reads market data from; one per deployment, chosen before boot
    #: (ADR 0015). The vendor door knows the names and refuses the rest.
    provider: str
    opend_host: str
    #: Where IB Gateway's API socket is, for a Reference that names `ibkr` (ADR 0019).
    #:
    #: Read whether or not IBKR is the Provider: a Reference may be served by a vendor the rest of the
    #: service does not use, because nothing alarms on it. Blank host turns the source off.
    #:
    #: The PORT is not a set-once value — IB Gateway listens on 4001 for a live login and 4002 for
    #: paper, so switching account type moves the socket (measured 2026-11-08).
    ibkr_host: str
    ibkr_port: int
    #: IB Gateway allows ONE connection per client id, and a second user of the same number displaces
    #: the first in silence. The ids are the owning process's port so a refusal names the culprit:
    #: 31415 the service, 31417 `make serve`, 31419 a harness.
    ibkr_client_id: int
    #: OpenD's WEBSOCKET port, which is all the TypeScript's npm client speaks (ADR 0009, phase 6)
    moomoo_ws_port: int
    #: OpenD's websocket key, in plaintext; the client hashes it. Gitignored, like the bot token.
    moomoo_ws_key: str
    api_token: str
    monitor_interval_seconds: int
    #: min gap between a monitor's telegram messages (flap protection)
    alarm_cooldown_seconds: int
    #: reminder cadence while a breach persists; 0 disables reminders
    alarm_repeat_seconds: int
    #: consecutive sweep failures before the degraded telegram alert
    degraded_after_failures: int
    #: re-reminds while the sweep is still failing, so one missed notice is not the end of it. 0 turns
    #: the reminder off, as it does for `alarm_repeat_seconds` (domain/degraded.ts).
    degraded_repeat_seconds: int
    #: How far back to look for a provider that keeps dropping and recovering, and how many failed
    #: sweeps inside that window before the owner hears about it. 0 failures turns it off.
    #:
    #: Separate from `degraded_after_failures` because they measure different things: that one is the
    #: LENGTH of a failure, this one is how OFTEN. A provider failing a third of the time for an hour
    #: never trips a consecutive count — measured on 2026-11-08, when exactly that went unnoticed by
    #: the service (domain/flapping.ts).
    flapping_window_seconds: int
    flapping_after_failures: int
    #: The least time between two flapping notices, measured from the last one, so one missed message
    #: is not the end of it. 0 says it ONCE until the service restarts: the stamp lives in memory and
    #: nothing clears it, because a success is what a flapping provider looks like and no sweep can
    #: tell the end of a bout from a gap inside one. So a later bout waits out the same interval, and
    #: with 0 is never announced at all (domain/flapping.ts, engine/health.ts).
    flapping_repeat_seconds: int
    #: consecutive sweeps a monitor's figure may fail to arrive before it is quarantined; 0 never
    #: quarantines and only warns, which is what the engine did before (#167)
    quarantine_after_silent_sweeps: int
    #: muted-expired monitors are auto-deleted this many days after expiry
    expired_retention_days: int
    #: exit schedule (ADR 0011): the fraction of Entry taken as profit
    exit_take_fraction: float
    #: exit schedule: the Cost to close, as a multiple of Entry, that ends the trade
    exit_stop_multiple: float
    #: exit schedule: be out of a Position at or inside this DTE whatever the P&L
    exit_manage_by_dte: int
    telegram_bot_token: str
    telegram_chat_id: str
    #: URL prefix when served behind a path-stripping reverse proxy, e.g. "/opt/api"
    root_path: str
    #: timezone for displayed timestamps, e.g. "Asia/Singapore"; empty = host timezone
    display_tz: str


DEFAULTS = Settings(
    # The service's own database. NOT `data/optionality.db`, which was the old Python's and was frozen
    # at the cutover minute as the rollback (CLAUDE.md) — and `main` opens and MIGRATES whatever this
    # names. The launchd plist has always set OPTIONALITY_DB_PATH, so the live service was right and
    # every other way of starting the TypeScript was quietly pointed at the rollback.
    db_path="data/optionality-ts.db",
    provider="moomoo",
    opend_host="127.0.0.1",
    ibkr_host="",
    ibkr_port=4001,
    ibkr_client_id=31415,
    moomoo_ws_port=33333,
    moomoo_ws_key="",
    api_token="",
    monitor_interval_seconds=60,
    alarm_cooldown_seconds=120,
    alarm_repeat_seconds=1800,
    degraded_after_failures=5,
    degraded_repeat_seconds=1800,
    flapping_window_seconds=900,
    flapping_after_failures=5,
    # the same as the other two reminders, because it is the same idea about the same channel — and
    # declared here, once: the policy reader supplied it itself while no variable reached it
    flapping_repeat_seconds=1800,
    # ten sweeps, so a gap of a few seconds is never a quarantine while a figure that is simply not
    # served stops being waited for within minutes at any sweep interval
    quarantine_after_silent_sweeps=10,
    expired_retention_days=7,
    exit_take_fraction=0.5,
    exit_stop_multiple=2.0,
    exit_manage_by_dte=21,
    telegram_bot_token="",
    telegram_chat_id="",
    root_path="",
    display_tz="",
)

#: Each setting and the variable it is read from. Listed once so that nothing can be read from a
#: name the other backend does not use.
FROM_ENV = {
    "db_path": "OPTIONALITY_DB_PATH",
    "provider": "OPTIONALITY_PROVIDER",
    "opend_host": "OPEND_HOST",
    "ibkr_host": "IBKR_HOST",
    "ibkr_port": "IBKR_PORT",
    "ibkr_client_id": "IBKR_CLIENT_ID",
    "moomoo_ws_port": "MOOMOO_WS_PORT",
    "moomoo_ws_key": "MOOMOO_WS_KEY",
    "api_token": "API_TOKEN",
    "monitor_interval_seconds": "MONITOR_INTERVAL_SECONDS",
    "alarm_cooldown_seconds": "ALARM_COOLDOWN_SECONDS",
    "alarm_repeat_seconds": "ALARM_REPEAT_SECONDS",
    "degraded_after_failures": "DEGRADED_AFTER_FAILURES",
    "degraded_repeat_seconds": "DEGRADED_REPEAT_SECONDS",
    "flapping_window_seconds": "FLAPPING_WINDOW_SECONDS",
    "flapping_after_failures": "FLAPPING_AFTER_FAILURES",
    "flapping_repeat_seconds": "FLAPPING_REPEAT_SECONDS",
    "quarantine_after_silent_sweeps": "QUARANTINE_AFTER_SILENT_SWEEPS",
    "expired_retention_days": "EXPIRED_RETENTION_DAYS",
    "exit_take_fraction": "EXIT_TAKE_FRACTION",
    "exit_stop_multiple": "EXIT_STOP_MULTIPLE",
    "exit_manage_by_dte": "EXIT_MANAGE_BY_DTE",
    "telegram_bot_token": "TELEGRAM_BOT_TOKEN",
    "telegram_chat_id": "TELEGRAM_CHAT_ID",
    "root_path": "ROOT_PATH",
    "display_tz": "DISPLAY_TZ",
}

#: The knobs that are genuinely fractional. Everything else is a count, where a fraction is a typo —
#: `exit_manage_by_dte` is deliberately not here, because a DTE is a whole day.
FRACTIONAL = frozenset({"exit_take_fraction", "exit_stop_multiple"})

#: Knobs that must be at least 1, because 0 is not "off" for them but broken.
#:
#: `DEGRADED_AFTER_FAILURES=0` made `consecutive_failures >= threshold` true on a HEALTHY sweep, so
#: the service sent "✅ monitoring recovered" every minute for ever while the degraded alert it was
#: meant to arm never fired at all. `MONITOR_INTERVAL_SECONDS=0` gives an interval of 0 and a stall
#: threshold of 0, so `/health` reads permanently stalled and every tick records a failure.
#:
#: 0 IS off for the three left out — `ALARM_REPEAT_SECONDS`, `QUARANTINE_AFTER_SILENT_SWEEPS`,
#: `EXPIRED_RETENTION_DAYS` — which is exactly why 0 is a plausible thing to type here, and why this
#: list has to be explicit rather than "no zeroes anywhere" (review 2026-11-01).
AT_LEAST_ONE = ("monitor_interval_seconds", "degraded_after_failures")

# JavaScript's `trim`: WhiteSpace (tab, VT, FF, space, NBSP, the BOM and every Zs) and LineTerminator
# (LF, CR, U+2028, U+2029). Not `str.strip()`, which keeps the BOM and also eats \x1c-\x1f.
_JS_WHITESPACE = "\t\n\v\f\r \xa0                　﻿"


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _check_settings(settings: Settings) -> Settings:
    """Every count is non-negative; some must be positive. Fatal, as a mistyped setting already is in
    this module — the service should stop rather than run on a number that cannot mean anything.

    Both doors onto Settings go through this. For a long time only `settingsFor` did — the one the
    TESTS use — so the suite proved a guard the live process did not have. A check that only the
    tests reach is worse than no check, because it reads as one.
    """
    for field in dataclasses.fields(settings):
        value = getattr(settings, field.name)
        if not _is_number(value) or math.isnan(value):
            continue
        variable = FROM_ENV.get(field.name, field.name)
        if value < 0:
            raise ValueError(f"{variable} cannot be negative: {js_string(value)}")
        if field.name in AT_LEAST_ONE and value < 1:
            raise ValueError(f"{variable} must be at least 1: {js_string(value)}")
    return settings


def settings_from_env(env: Mapping[str, str] | None = None) -> Settings:
    """Settings from `env`, the process environment when None. Raises `ValueError` on a knob the
    service must not start on, naming its variable."""
    if env is None:
        env = os.environ
    out: dict[str, object] = {}
    for key, variable in FROM_ENV.items():
        raw = env.get(variable)
        if raw is None:
            continue
        if _is_number(getattr(DEFAULTS, key)):
            # an EMPTY value is not zero. `Number("")` is 0 and 0 is an integer, so
            # `MONITOR_INTERVAL_SECONDS=` used to mean a zero interval rather than an error — every
            # numeric knob had that hole, and a knob set to nothing is a mistake, never an intent.
            if raw.strip(_JS_WHITESPACE) == "":
                raise ValueError(f"{variable} is set to nothing")
            n = number(raw)
            if not math.isfinite(n):
                raise ValueError(f"{variable} is not a number: {raw}")
            # int() in the old Python, which raised rather than silently using the default — a
            # mistyped MONITOR_INTERVAL_SECONDS should stop the service, not quietly sweep every 60
            # seconds. The exit FRACTIONS are the exception and are genuinely fractional; a count is not.
            if key in FRACTIONAL:
                out[key] = n
            elif not n.is_integer():
                raise ValueError(f"{variable} is not an integer: {raw}")
            else:
                out[key] = int(n)
        else:
            out[key] = raw
    # the same guard `settings_for` applies, on the door the SERVICE comes through
    return _check_settings(dataclasses.replace(DEFAULTS, **out))


def settings_for(**over: object) -> Settings:
    """Settings for a test, defaults everywhere the test does not care."""
    # checked here too: `settings_for` is how every test builds Settings, so a knob the service would
    # refuse must not be constructible in a test either
    return _check_settings(dataclasses.replace(DEFAULTS, **over))


#: what Node's env-file reader trims: spaces, tabs and newlines, and nothing else
_ENV_FILE_SPACE = " \t\n"


def _trim(text: str) -> str:
    return text.strip(_ENV_FILE_SPACE)


def parse_env_file(text: str) -> dict[str, str]:
    """The variables an env file sets, read as `node --env-file` reads them: a port, branch for branch,
    of `Dotenv::ParseContent` in Node 25's `src/node_dotenv.cc`, quirks included — a value is cut at
    its first `#` unless quoted, `\\n` becomes a newline only inside double quotes, a quote may span
    lines, and `KEY= ` followed by a line takes that line as its value. The last of a repeated key
    wins."""
    store: dict[str, str] = {}
    content = _trim(text.replace("\r", ""))
    while content:
        # an empty line, or a comment
        if content[0] in "\n#":
            newline = content.find("\n")
            content = content[newline + 1 :] if newline >= 0 else ""
            continue
        # a line with no `=` before its end is skipped
        at = next((i for i, c in enumerate(content) if c in "=\n"), -1)
        if at < 0 or content[at] == "\n":
            if at >= 0:
                content = _trim(content[at + 1 :])
                continue
            break
        key = _trim(content[:at])
        content = content[at + 1 :]
        if not content or content[0] == "\n":
            store[key] = ""
            continue
        content = _trim(content)
        if not key:
            continue
        if key.startswith("export "):
            key = _trim(key[7:])
        if not content:
            store[key] = ""
            break
        if content[0] == '"':
            closing = content.find('"', 1)
            if closing >= 0:
                store[key] = content[1:closing].replace("\\n", "\n")
                newline = content.find("\n", closing + 1)
                content = content[newline + 1 :] if newline >= 0 else ""
                continue
        if content[0] in "'\"`":
            closing = content.find(content[0], 1)
            if closing < 0:
                # never closed: the rest of the line, quote and all
                newline = content.find("\n")
                if newline < 0:
                    store[key] = content
                    break
                store[key] = content[:newline]
                content = content[newline + 1 :]
            else:
                store[key] = content[1:closing]
                newline = content.find("\n", closing + 1)
                content = content[newline + 1 :] if newline >= 0 else ""
                continue
        else:
            newline = content.find("\n")
            value = content[:newline] if newline >= 0 else content
            comment = value.find("#")
            store[key] = _trim(value[:comment] if comment >= 0 else value)
            content = content[newline + 1 :] if newline >= 0 else ""
        content = _trim(content)
    return store


def load_env_file(path: str | os.PathLike[str], environ: MutableMapping[str, str] | None = None) -> None:
    """`node --env-file=<path>`: set every variable the file names that `environ` — the process
    environment when None — does not already have, so the environment wins, even with an empty value.
    A missing file raises, as Node refuses to start without one."""
    if environ is None:
        environ = os.environ
    with open(path, encoding="utf-8") as file:
        text = file.read()
    for key, value in parse_env_file(text).items():
        if key not in environ:
            environ[key] = value
