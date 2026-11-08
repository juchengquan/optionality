/** Changing or removing a rule, by whatever the owner typed to name it.
 *
 *  All three go through `matches`, which returns EVERY match rather than the first: "Ambiguous" is
 *  an answer the owner can act on, and silently picking one is how the wrong alarm gets deleted.
 */
import { type Command, requireNumber } from "./context.ts";
import { expandSpxShort } from "../../domain/contract.ts";
import { atomic } from "../../db/open.ts";
import {
  clearMonitorLinks, deleteMonitorRow, findComboByName, findMonitorByCodeField,
  findMonitorsByIdentifier, updateMonitorFields,
} from "../../db/queries/index.ts";
import type { MonitorRow } from "../../db/rows.ts";
import type { DatabaseSync } from "node:sqlite";
import { ruleText, thresholdError } from "../format.ts";

/** Every monitor the words might mean: the exact code, the joined-and-upcased form, an id prefix,
 *  or a short contract like `260918 C8100`. */
function matches(db: DatabaseSync, args: string[]): MonitorRow[] {
  const token = args[0] ?? "";
  const joined = args.join("").toUpperCase();
  return findMonitorsByIdentifier(db, token, joined, expandSpxShort(joined));
}

export const threshold: Command = (ctx, args) => {
  const usage = "Usage: /threshold <name, code, id prefix, or contract> <value>";
  if (args.length < 2) return usage;
  let value: number;
  try {
    value = requireNumber(args.at(-1)!);
  } catch {
    return usage;
  }
  const identifier = args.slice(0, -1);
  const found = matches(ctx.db, identifier);
  if (found.length === 0) return `No monitor matches '${identifier.join(" ")}'.`;
  if (found.length > 1) return "Ambiguous — matches: " + found.map((m) => m.code).join(", ");
  const monitor = found[0]!;
  const bad = thresholdError(monitor.compare, value);
  if (bad) return bad;
  updateMonitorFields(ctx.db, monitor.id, { threshold: value });
  return ruleText(monitor.code, monitor.field, value, monitor.direction, monitor.compare);
};

export const rename: Command = (ctx, args) => {
  if (args.length !== 2) return "Usage: /rename <old combo name> <new name>";
  const [old, next] = args as [string, string];
  const found = findComboByName(ctx.db, old);
  if (!found) return `No combo named '${old}'.`;
  if (findMonitorByCodeField(ctx.db, next, found.field, found.id)) {
    return `'${next}' is already taken.`;
  }
  updateMonitorFields(ctx.db, found.id, { code: next });
  return `Renamed ${old} → ${next} (alarm state and history kept).`;
};

export const unwatch: Command = async (ctx, args) => {
  if (args.length === 0) {
    return "Usage: /unwatch <name, code, id prefix, or contract like 260918 C8100>";
  }
  const found = matches(ctx.db, args);
  if (found.length === 0) return `No monitor matches '${args.join(" ")}'.`;
  if (found.length > 1) {
    return "Ambiguous — matches: " + found.map((m) => m.id.slice(0, 8)).join(", ");
  }
  const monitor = found[0]!;
  // the links go first: deleting a linked monitor is refused by the foreign key, and every monitor
  // in the live database is linked (#70). The Position stays — it is a holding.
  await atomic(ctx.db, () => {
    clearMonitorLinks(ctx.db, monitor.id);
    deleteMonitorRow(ctx.db, monitor.id);
  });
  return `Removed monitor for ${monitor.code}.`;
};
