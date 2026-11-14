"""One contract, the holdings, the service itself, and the help text. Port of
backend/src/entrypoints/bot/commands/service.ts.

`/holdings` is here rather than beside the watchlist because a holding is not a rule: its figures come
from `holdings.py` — the same function `/positions/values` asks — so Telegram and the dashboard cannot
disagree about a cost, a P&L or a Level.

**Where the Python differs, and why.**

- **Every figure is written as JavaScript writes it.** A cost is `toFixed(2)` (`format.fixed`), and a
  P&L is `String(Math.round(pnl))` — `optionality.js.math_round` and `js_string` — because Python's
  `round` takes 12.5 to 12 and its `str` writes "13.0".
- **A record is read as JavaScript reads it**: `r.name || code` is `truthy`, and the name is written
  with `String` (`format.js_text`), since a record is whatever the Provider sent. A field is shown when
  it is neither absent nor null, which for a dict is `get(f) is not None`.
- **`/health`'s sweep time is the library's `display_time_short`**, which names a zone with tzdata's
  abbreviation where the TypeScript's has ICU's. The two agree on UTC, America/New_York and every zone
  whose abbreviation is an offset — Asia/Singapore among them — and part where only tzdata has a name
  (Asia/Kolkata's IST); `timefmt.py` says where that is measured.
- **Valuing raises on a stored holding it cannot hydrate** (`holdings.py`, issue #266), where the
  TypeScript values it, so such a row is "Holdings failed: …" here and a table row there. Every failure
  is caught as `except Exception`, never wider, so a cancelled task stays cancelled.
- `help` shadows the builtin inside this module and the table's: it is the TypeScript's name, and the
  name the owner types.
"""

from optionality.contract import build_spx_code
from optionality.expiry import in_session
from optionality.js import js_string, math_round, truthy
from optionality.timefmt import display_time_short

from ....holdings import holding_values
from ..format import HELP_TEXT, closed_line, fixed, fmt_value, js_text, standing_note, table
from .context import BotContext, failed, require_number


async def holdings(ctx: BotContext, args: list[str]) -> str:
    """Where each Position stands: what it costs to buy back, what that is worth, and the one thing
    worth saying about it. Four columns, inside forty characters, as every table reply here is — and
    outside New York's session, valued from each holding's latest close, one line under the table
    saying which (#380)."""
    try:
        valued = await holding_values(ctx.db, ctx.fetch_quotes, ctx.now(), ctx.settings, ctx.settings.display_tz)
    except Exception as err:  # noqa: BLE001 — a Provider that is down is a sentence in the chat, never a silence
        return failed("Holdings", err)
    if not valued.values:
        return "No holdings recorded. Record one on the dashboard, beside the rule that watches it."
    reply = table(
        ["holding", "cost", "P&L", "note"],
        [
            [
                v.row["name"],
                "—" if v.cost is None else fixed(v.cost, 2),
                "—" if v.pnl is None else js_string(math_round(v.pnl)),
                standing_note(v),
            ]
            for v in valued.values
        ],
    )
    # outside the session the figures are a close's, and the table keeps its four columns: the one line
    # under it says which close (#380)
    return reply if in_session(ctx.now()) else f"{reply}\n{closed_line(valued.values)}"


async def snapshot(ctx: BotContext, args: list[str]) -> str:
    """One contract's live figures, for a strike nothing watches. The reason `/spx/quote` could be
    dropped (#199): this answers the same question in-process."""
    usage = "Usage: /snapshot <YYYY-MM-DD> <CALL|PUT> <strike>"
    if len(args) < 3:
        return usage
    option_type = args[1].upper()
    if option_type not in ("CALL", "PUT"):
        return usage
    try:
        code = build_spx_code(args[0], option_type, require_number(args[2]))
    except Exception:  # noqa: BLE001 — the TypeScript's bare `catch`: a word it cannot read is a usage error
        return usage
    try:
        records = (await ctx.fetch_quotes([code])).records
    except Exception as err:  # noqa: BLE001 — as the tables say it
        return failed("Snapshot", err)
    if not records:
        return f"No data for {code}."
    r = records[0]
    name = js_text(r.get("name")) if truthy(r.get("name")) else code
    fields = [
        "option_delta",
        "option_implied_volatility",
        "mid_price",
        "bid_price",
        "ask_price",
        "last_price",
        "option_theta",
    ]
    lines = [f"{f}: {fmt_value(f, r[f])}" for f in fields if r.get(f) is not None]
    return f"{name}\n" + "\n".join(lines)


def health(ctx: BotContext, args: list[str]) -> str:
    lines: list[str] = []
    if ctx.sweeper is not None:
        label = ctx.sweeper.alarm_state().label
        swept_at = display_time_short(ctx.sweeper.last_sweep_at(), ctx.settings.display_tz)
        lines.append(f"alarms: {label}{f' — last sweep {swept_at}' if swept_at else ''}")
    return "Service is up.\n" + "\n".join(lines) if lines else "Service is up."


def help(ctx: BotContext, args: list[str]) -> str:
    """Registered rather than left to a fallback, so the table and the "/" menu can be compared
    exactly: `help` was announced in BOT_COMMANDS and answered only by falling through the switch,
    which is the one shape that comparison could not see."""
    return HELP_TEXT
