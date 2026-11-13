"""Reading the watchlist: the stored rules, the three live tables, and one combo's legs. Port of
backend/src/entrypoints/bot/commands/watchlist.ts.

The three live tables — /quotes, /greeks, /vol — differ only in their columns and fail the same way,
which is why they are one function and three column mappers. They are three commands rather than one
wide one because a Telegram table is ~40 monospace characters and four columns at most: a new
question gets a new command, never a fifth column (CLAUDE.md).

**Where the Python differs, and why.**

- **Every figure is JavaScript's.** A quote field is `Number(v)` (`optionality.js.number`), because
  moomoo can send a string; `toFixed` is `format.fixed`; and the codes a combo asks for are sorted as
  `sort()` sorts them, which for the ASCII every built contract code is, is Python's `sorted`.
- **The exit policy is read here** from Settings, as the routes read theirs: the library's
  `ExitPolicy` takes its three knobs directly, where the TypeScript's `exitPolicy` reads Settings.
- A failed fetch is caught as `except Exception`, never wider, so a cancelled task stays cancelled.
"""

from collections.abc import Callable

from optionality.contract import short_spx_code
from optionality.exit import ExitPolicy
from optionality.js import number
from optionality.monitor import monitor_leg_codes
from optionality.quote import Quote, round4

from ....db.queries import find_combo_by_name, list_monitors
from ....db.values import from_sqlite_bool
from ....env import Settings
from ....hydrate import to_monitor
from ....monitors import watchlist_quotes
from ..format import FIELD_SHORT, fixed, fmt_value, has_format, js_text, py_number, table
from .context import EMPTY_WATCHLIST, BotContext, failed


def _exit_policy(settings: Settings) -> ExitPolicy:
    """The library's `exitPolicy`, which reads Settings: the three knobs, from `.env`."""
    return ExitPolicy(
        take_fraction=settings.exit_take_fraction,
        stop_multiple=settings.exit_stop_multiple,
        manage_by_dte=settings.exit_manage_by_dte,
    )


def _cell(value: object, render: Callable[[float], str]) -> str:
    """A figure that may not have arrived, rendered the way its own field wants."""
    return "—" if value is None else render(number(value))


def monitors(ctx: BotContext, args: list[str]) -> str:
    rows = list_monitors(ctx.db)
    if not rows:
        return EMPTY_WATCHLIST
    lines: list[list[str]] = []
    for m in rows:
        state = "🔔" if from_sqlite_bool(m["triggered"]) else "armed"
        if not from_sqlite_bool(m["enabled"]):
            state = "off"
        # three places for a field with a format of its own, four for everything else — a mid of
        # 26.4000 reads as spurious precision, and a delta of 0.0456 loses the figure that matters
        last_value = m["last_value"]
        if last_value is None:
            last = "—"
        elif has_format(m["field"]):
            last = fmt_value(m["field"], last_value)
        else:
            last = fixed(last_value, 4)
        thr = f"{'≤' if m['direction'] == 'below' else '≥'}{py_number(m['threshold'])}"
        lines.append([short_spx_code(m["code"]), FIELD_SHORT.get(m["field"], m["field"]), last, thr, state])
    return table(["contract", "field", "last", "thr", "state"], lines)


async def _quote_table(ctx: BotContext, label: str, headers: list[str], cells: Callable[[Quote], list[str]]) -> str:
    """One live table: one bounded call, and the columns this command asked for."""
    try:
        quotes = await watchlist_quotes(
            ctx.db, ctx.settings.display_tz, ctx.fetch_quotes, now=ctx.now(), policy=_exit_policy(ctx.settings)
        )
    except Exception as err:  # noqa: BLE001 — a Provider that is down is a sentence in the chat, never a silence
        return failed(label, err)
    if not quotes:
        return EMPTY_WATCHLIST
    return table(
        headers,
        [[short_spx_code(q["code"]) + (" 🔔" if q["triggered"] else ""), *cells(q["quote"] or {})] for q in quotes],
    )


def _quotes_cells(snap: Quote) -> list[str]:
    bid = snap.get("bid_price")
    ask = snap.get("ask_price")
    bid_ask = f"{py_number(number(bid))}/{py_number(number(ask))}" if bid is not None and ask is not None else "—"
    return [_cell(snap.get("mid_price"), py_number), bid_ask]


async def quotes(ctx: BotContext, args: list[str]) -> str:
    return await _quote_table(ctx, "Quotes", ["contract", "mid", "bid/ask"], _quotes_cells)


async def greeks(ctx: BotContext, args: list[str]) -> str:
    return await _quote_table(
        ctx,
        "Greeks",
        ["contract", "delta", "gamma", "theta"],
        lambda snap: [
            _cell(snap.get("option_delta"), lambda n: fmt_value("option_delta", n)),
            # SPX gammas are ~1e-4, so five decimals; three would render every gamma as 0.000
            _cell(snap.get("option_gamma"), lambda n: fixed(n, 5)),
            _cell(snap.get("option_theta"), lambda n: fixed(n, 2)),
        ],
    )


async def vol(ctx: BotContext, args: list[str]) -> str:
    return await _quote_table(
        ctx,
        "Vol",
        ["contract", "IV", "vega"],
        lambda snap: [
            _cell(snap.get("option_implied_volatility"), lambda n: fmt_value("option_implied_volatility", n)),
            _cell(snap.get("option_vega"), lambda n: fixed(n, 2)),
        ],
    )


async def combo(ctx: BotContext, args: list[str]) -> str:
    """One combo, leg by leg, with the signed total it is watched on.

    NO partial sums: any missing leg makes the total "incomplete" rather than a number computed from
    part of a structure (CLAUDE.md).
    """
    if not args:
        return "Usage: /combo <name>"
    found = find_combo_by_name(ctx.db, args[0])
    if not found:
        return f"No combo named '{args[0]}'."
    monitor = to_monitor(found)
    codes = monitor_leg_codes(monitor)
    try:
        records = (await ctx.fetch_quotes(sorted(set(codes)))).records
    except Exception as err:  # noqa: BLE001 — as the live tables say it
        return failed("Combo", err)
    by_code = {js_text(r.get("code")): r for r in records}

    rows: list[list[str]] = []
    total = 0.0
    complete = True
    for index, leg in enumerate(monitor.legs or ()):
        code = codes[index]
        record = by_code.get(code)
        value = None if record is None else record.get(monitor.field)
        # a quantity beside its sign, `-2`, as the dashboard writes one (#351); one says nothing more
        sign = ("+" if leg.sign > 0 else "-") + ("" if leg.qty == 1 else str(leg.qty))
        if value is None:
            rows.append([sign, short_spx_code(code), "—"])
            complete = False
        else:
            total += leg.sign * leg.qty * number(value)
            rows.append([sign, short_spx_code(code), fmt_value(monitor.field, number(value))])
    # 4dp on the total, as the old Python rounded it: a signed sum of three-decimal mids otherwise shows
    # float noise in a figure read as a price
    total_cell = fmt_value(monitor.field, round4(total)) if complete else "incomplete"
    rows.append(["", "total", total_cell])
    return table(["", "leg", FIELD_SHORT.get(monitor.field, monitor.field)], rows)
