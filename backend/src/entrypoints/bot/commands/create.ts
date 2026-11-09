/** The two commands that add a rule, which is where the typing happens.
 *
 *  Both hand off to `create-monitor.ts` the moment the words have been read: the five steps of
 *  creating a rule — reject an unusable threshold, reject a non-additive combo field, build the
 *  code, refuse a duplicate, prove the contract exists — are shared with `POST /monitors`, and the
 *  two had drifted when each had its own copy. What is left here is parsing words typed into a
 *  phone, and the bot's own wording for a refusal.
 */
import { type BotContext, type Command, creating, requireNumber } from "./context.ts";
import { buildSpxCode, normalizeStrikeDate } from "optionality/domain/contract";
import { type CreateFault, createComboMonitor, createSingleMonitor, isFault } from "../../../create-monitor.ts";
import { ruleText, thresholdError } from "../format.ts";

const LEG_TOKEN = /^([+-])([CP])(\d+(?:\.\d+)?)$/;

/** The trailing `[field] [above|below] [signed]` words, in any order. */
function modifiers(extras: string[], defaultField: string) {
  let field = defaultField;
  let direction = "above";
  let compare = "abs";
  for (const extra of extras) {
    const low = extra.toLowerCase();
    if (low === "above" || low === "below") direction = low;
    else if (low === "signed") compare = "signed";
    else field = extra;
  }
  return { field, direction, compare };
}

/** A refusal, in the bot's own words. The route answers the same faults with statuses, and the
 *  wording here is deliberately longer: it is read without the form that produced it. */
function say(fault: CreateFault): string {
  if (fault.kind === "duplicate") return `Already watching ${fault.code} (${fault.field}).`;
  if (fault.kind === "threshold") return thresholdError(fault.compare, fault.threshold)!;
  return fault.message;
}

export const watch: Command = async (ctx: BotContext, args) => {
  const usage = "Usage: /watch <YYYY-MM-DD> <CALL|PUT> <strike> <threshold> [field] [above|below]";
  if (args.length < 4) return usage;
  const optionType = args[1]!.toUpperCase();
  if (optionType !== "CALL" && optionType !== "PUT") return usage;
  let strikeDate: string;
  let strike: number;
  let threshold: number;
  let code: string;
  try {
    strikeDate = normalizeStrikeDate(args[0]!);
    strike = requireNumber(args[2]!);
    threshold = requireNumber(args[3]!);
    code = buildSpxCode(strikeDate, optionType, strike);
  } catch {
    return usage;
  }
  const { field, direction, compare } = modifiers(args.slice(4, 7), "option_delta");

  const made = await createSingleMonitor(creating(ctx), {
    strike_date: strikeDate, option_type: optionType, strike, field, threshold,
    direction, compare,
  });
  if (isFault(made)) return say(made);
  return ruleText(`Watching ${code}`, field, threshold, direction, compare);
};

export const watchcombo: Command = async (ctx: BotContext, args) => {
  const usage = "Usage: /watchcombo <name> <date> <±C|Pstrike ...> <threshold> [field] [above|below]  (−short +long)";
  if (args.length < 5) return usage;
  const name = args[0]!;
  let strikeDate: string;
  try {
    strikeDate = normalizeStrikeDate(args[1]!);
  } catch {
    return usage;
  }
  const legs: { sign: 1 | -1; option_type: "CALL" | "PUT"; strike: number }[] = [];
  let i = 2;
  while (i < args.length) {
    const m = LEG_TOKEN.exec(args[i]!.toUpperCase());
    if (!m) break;
    legs.push({
      sign: m[1] === "+" ? 1 : -1,
      option_type: m[2] === "C" ? "CALL" : "PUT",
      strike: Number(m[3]),
    });
    i += 1;
  }
  if (legs.length < 2 || i >= args.length) return usage;
  let threshold: number;
  try {
    threshold = requireNumber(args[i]!);
  } catch {
    return usage;
  }
  const { field, direction, compare } = modifiers(args.slice(i + 1, i + 4), "mid_price");

  const made = await createComboMonitor(creating(ctx), {
    name, strike_date: strikeDate, legs, field, threshold, direction, compare,
  });
  if (isFault(made)) return say(made);
  return ruleText(
    `Watching combo ${name} (${legs.length} legs)`, field, threshold, direction, compare,
  );
};
