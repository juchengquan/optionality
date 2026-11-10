"""Changing or removing a rule, by whatever the owner typed to name it. Port of
backend/src/entrypoints/bot/commands/edit.ts.

All three go through `_matches`, which returns EVERY match rather than the first: "Ambiguous" is an
answer the owner can act on, and silently picking one is how the wrong alarm gets deleted.

**Where the Python differs, and why.** Only in spelling: a number typed into the phone is
JavaScript's `Number` (`context.require_number`), and a word that is not one is caught as `except
Exception`, the TypeScript's bare `catch`.
"""

import sqlite3

from optionality.contract import expand_spx_short

from ....db.open import atomic
from ....db.queries import (
    clear_monitor_links,
    delete_monitor_row,
    find_combo_by_name,
    find_monitor_by_code_field,
    find_monitors_by_identifier,
    update_monitor_fields,
)
from ....db.rows import MonitorRow
from ..format import rule_text, threshold_error
from .context import BotContext, require_number


def _matches(db: sqlite3.Connection, args: list[str]) -> list[MonitorRow]:
    """Every monitor the words might mean: the exact code, the joined-and-upcased form, an id prefix,
    or a short contract like `260918 C8100`."""
    token = args[0] if args else ""
    joined = "".join(args).upper()
    return find_monitors_by_identifier(db, token, joined, expand_spx_short(joined))


def threshold(ctx: BotContext, args: list[str]) -> str:
    usage = "Usage: /threshold <name, code, id prefix, or contract> <value>"
    if len(args) < 2:
        return usage
    try:
        value = require_number(args[-1])
    except Exception:  # noqa: BLE001 — the TypeScript's bare `catch`: a value it cannot read is a usage error
        return usage
    identifier = args[:-1]
    found = _matches(ctx.db, identifier)
    if not found:
        return f"No monitor matches '{' '.join(identifier)}'."
    if len(found) > 1:
        return "Ambiguous — matches: " + ", ".join(m["code"] for m in found)
    monitor = found[0]
    bad = threshold_error(monitor["compare"], value)
    if bad:
        return bad
    update_monitor_fields(ctx.db, monitor["id"], {"threshold": value})
    return rule_text(monitor["code"], monitor["field"], value, monitor["direction"], monitor["compare"])


def rename(ctx: BotContext, args: list[str]) -> str:
    if len(args) != 2:
        return "Usage: /rename <old combo name> <new name>"
    old, new = args
    found = find_combo_by_name(ctx.db, old)
    if not found:
        return f"No combo named '{old}'."
    if find_monitor_by_code_field(ctx.db, new, found["field"], found["id"]):
        return f"'{new}' is already taken."
    update_monitor_fields(ctx.db, found["id"], {"code": new})
    return f"Renamed {old} → {new} (alarm state and history kept)."


async def unwatch(ctx: BotContext, args: list[str]) -> str:
    if not args:
        return "Usage: /unwatch <name, code, id prefix, or contract like 260918 C8100>"
    found = _matches(ctx.db, args)
    if not found:
        return f"No monitor matches '{' '.join(args)}'."
    if len(found) > 1:
        return "Ambiguous — matches: " + ", ".join(m["id"][:8] for m in found)
    monitor = found[0]

    def remove() -> None:
        clear_monitor_links(ctx.db, monitor["id"])
        delete_monitor_row(ctx.db, monitor["id"])

    # the links go first: deleting a linked monitor is refused by the foreign key, and every monitor in
    # the live database is linked (#70). The Position stays — it is a holding.
    await atomic(ctx.db, remove)
    return f"Removed monitor for {monitor['code']}."
