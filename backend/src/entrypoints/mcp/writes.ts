/** The MCP door's writes (ADR 0028, #456): `add_rule` and `edit_rule`, behind `MCP_WRITES`, capped by
 *  `MCP_WRITES_PER_10_MIN`, each one said to the owner's phone and in the log.
 *
 *  **What this module can write is two routes, and nothing else.** It is handed a `Write` of the app's
 *  own (`app.ts`) and wraps it at once in `allowedWrite`, which lets through only the method and path
 *  pairs `schema/mcp/server.json` lists for a write tool — `POST /monitors` and `PATCH /monitors/{id}`,
 *  the id one of the service's own — and refuses any other before the app is asked. No service, query
 *  or engine is imported here, as none is in `tools.ts` (`server.test.ts` holds both): a rule is
 *  written by the very routes the dashboard writes it through, their probe, their checks and their
 *  words, and this door adds only what an agent must not be able to do that the page may.
 *
 *  **What the door refuses itself**, before any route is asked and without counting against the cap:
 *  every write while the switch is off; arguments that are not the tool's shape; a `qty` other than 1
 *  (a rule on a structure with quantities is made on the page); a combo with no name, or a name on
 *  one contract; an edit of nothing; and unmuting a rule the service switched off — only a rule muted
 *  by hand (`manual`) may be unmuted here. Everything else is the route's to refuse, and is said in its
 *  words, and counted: a refused probe still asked the Provider.
 *
 *  **The notice** is the domain's `agentNotice`, from the rule before (the `GET /monitors` row the
 *  lookup read) and after (the route's answer), sent through the `Notify` `main.ts` hands the door —
 *  the service's `delivery`, which logs a Telegram that is not configured or refuses; the write stands
 *  either way. The log line is this module's, one per write attempted.
 */
import { type AgentRule, agentNotice } from "optionality/domain/alarm";
import { displayTime } from "optionality/domain/timefmt";

import type { Notify, Read, Write } from "../../ports.ts";
import {
  DESCRIBED, EXPIRY_PATTERN, LOOKUPS, type Row, type Tool, type ToolResult, argumentFault, canonical,
  detailOf, failed, isObject, isRow, keysFault, resolveRow, rounded, written,
} from "./tools.ts";

/** The writes `server.json` lists, one per write tool: the whole of what this door may write. */
export const WRITES: { tool: string; method: string; path: string }[] = DESCRIBED.tools
  .filter((t) => t.method !== undefined)
  .map((t) => ({ tool: t.name, method: t.method!, path: t.path }));

/** What `{id}` in a write's path may be: one of the service's own ids, as a history tool's is. */
const AN_ID = "[A-Za-z0-9_-]{1,64}";

const PAIRS = WRITES.map(({ method, path }) => ({
  method,
  path: new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{\w+\}/g, AN_ID)}$`),
}));

/** `write`, letting through only the pairs `WRITES` lists — the method exactly, the path whole with
 *  `{id}` one of the service's ids — and refusing any other before the app is asked anything. The
 *  only write the rest of this door is given. */
export function allowedWrite(write: Write): Write {
  const listed = WRITES.map((w) => `${w.method} ${w.path}`).join(" and ");
  return async (method, path, body, authorization) => {
    if (!PAIRS.some((p) => p.method === method && p.path.test(path))) {
      throw new Error(`the MCP door may not ${method} ${path}: it writes only ${listed}`);
    }
    return write(method, path, body, authorization);
  };
}

/** The window `MCP_WRITES_PER_10_MIN` counts writes over. */
export const CAP_WINDOW_MS = 600_000;

export const WRITES_OFF =
  "writes are off on this service: add_rule and edit_rule need MCP_WRITES=1 in its .env, which only its owner sets";

/** A value an agent sent, checked: what it becomes, or the words for why it cannot. */
type Checked<T> = T | { fault: string };
const isFault = <T>(value: Checked<T>): value is { fault: string } =>
  value !== null && typeof value === "object" && "fault" in value;

/** Absent and null are both "not given", as `price_spreads`' optional arguments are. */
const given = (value: unknown) => value !== undefined && value !== null;

/** `POST /monitors`' body for `add_rule`'s arguments, or why there is none: a structure as
 *  `price_spreads` takes one, its one leg the single-contract body and its several a combo's, each side
 *  its sign. Only the shape and the types, and what the door refuses itself; the rest is the route's. */
function ruleBody(args: Record<string, unknown>): Checked<Record<string, unknown>> {
  const { expiry, legs, field, threshold, direction, compare, name } = args;
  if (typeof expiry !== "string" || !new RegExp(EXPIRY_PATTERN).test(expiry)) {
    return { fault: `"expiry" must be a string matching ${EXPIRY_PATTERN}` };
  }
  if (!Array.isArray(legs)) return { fault: '"legs" must be a list of legs' };
  if (legs.length === 0) return { fault: '"legs" must hold one leg or more' };
  const out: { sign: number; option_type: string; strike: number }[] = [];
  for (const [i, leg] of legs.entries()) {
    const where = `legs[${i}]`;
    if (!isObject(leg)) return { fault: `${where} must be an object` };
    const fault = keysFault(leg, where, "leg", ["side", "option_type", "strike", "qty"], ["side", "option_type", "strike"]);
    if (fault !== null) return { fault };
    const { side, option_type: type, strike, qty } = leg;
    if (side !== "short" && side !== "long") return { fault: `${where}.side must be "short" or "long"` };
    if (type !== "CALL" && type !== "PUT") return { fault: `${where}.option_type must be "CALL" or "PUT"` };
    if (typeof strike !== "number" || !Number.isFinite(strike)) return { fault: `${where}.strike must be a number` };
    if (given(qty)) {
      if (typeof qty !== "number" || !Number.isFinite(qty)) return { fault: `${where}.qty must be a number` };
      if (qty !== 1) {
        return { fault: `${where}.qty is ${written(qty)}: a rule here watches one of each contract — a rule on a structure with quantities is made on the page` };
      }
    }
    out.push({ sign: side === "short" ? -1 : 1, option_type: type, strike });
  }
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) return { fault: '"threshold" must be a number' };
  for (const [key, value] of Object.entries({ field, direction, compare, name })) {
    if (given(value) && typeof value !== "string") return { fault: `"${key}" must be a string` };
  }
  if (out.length === 1 && given(name)) return { fault: 'a rule on one contract takes no "name": its code is the contract\'s' };
  if (out.length > 1 && !given(name)) {
    return { fault: `a rule on ${out.length} legs is a combo, and a combo needs a "name": it becomes the rule's code ("1218-6750")` };
  }
  // only what was given, so the route's own defaults apply to the rest
  const optional = Object.fromEntries(Object.entries({ field, direction, compare }).filter(([, v]) => given(v)));
  if (out.length === 1) {
    const [leg] = out;
    return { strike_date: expiry, option_type: leg!.option_type, strike: leg!.strike, threshold, ...optional };
  }
  return { name, strike_date: expiry, legs: out, threshold, ...optional };
}

/** What `edit_rule` may change, in the order `server.json` lists them. `field` is not one. */
const EDITABLE = ["threshold", "direction", "compare", "name", "enabled"] as const;

/** `PATCH /monitors/{id}`'s body for `edit_rule`'s arguments, or why there is none. */
function editBody(args: Record<string, unknown>): Checked<Record<string, unknown>> {
  const change: Record<string, unknown> = {};
  for (const key of EDITABLE) {
    const value = args[key];
    if (!given(value)) continue;
    if (key === "threshold" && (typeof value !== "number" || !Number.isFinite(value))) return { fault: '"threshold" must be a number' };
    if (key === "enabled" && typeof value !== "boolean") return { fault: '"enabled" must be true or false' };
    if (key !== "threshold" && key !== "enabled" && typeof value !== "string") return { fault: `"${key}" must be a string` };
    change[key] = value;
  }
  if (Object.keys(change).length === 0) {
    return { fault: "edit_rule needs at least one change: threshold, direction, compare, name or enabled" };
  }
  return change;
}

/** A rule as the route serves it, as `agentNotice` reads it. */
const agentRule = (row: Record<string, unknown>): AgentRule => ({
  code: String(row.code), field: String(row.field), combo: Array.isArray(row.legs) && row.legs.length > 0,
  compare: String(row.compare), direction: String(row.direction), threshold: Number(row.threshold),
  enabled: row.enabled === true,
});

/** What the log says of a notice, by how it went. */
const NOTICE = { sent: "notice sent", unconfigured: "no notice: Telegram is not configured", failed: "its notice not sent" };

export interface WriterOptions {
  read: Read;
  /** the app's own write, which this module wraps in `allowedWrite` before anything can reach it */
  write: Write;
  notify: Notify;
  now(): Date;
  displayTz: string;
  /** `MCP_WRITES` */
  on: boolean;
  /** `MCP_WRITES_PER_10_MIN` */
  per10Min: number;
}

/** The write tools, bound to the app they write to: `call` answers one `tools/call` of either. */
export function writer(options: WriterOptions) {
  const { read, notify, now, displayTz, on, per10Min } = options;
  const write = allowedWrite(options.write);
  /** When each write that reached the route was made, oldest first: the cap's memory. */
  const made: number[] = [];

  const log = (tool: string, args: unknown, outcome: string, refused: boolean) =>
    (refused ? console.warn : console.info)(`mcp ${tool} ${canonical(args ?? {})}: ${outcome}`);

  /** The write itself, once the door has nothing to refuse: counted, made, said and answered. */
  const send = async (
    tool: Tool, args: unknown, path: string, body: Record<string, unknown>, before: Row | null,
    authorization: string | null,
  ): Promise<ToolResult> => {
    const at = now();
    const t = at.getTime();
    while (made.length > 0 && t - made[0]! >= CAP_WINDOW_MS) made.shift();
    if (made.length >= per10Min) {
      const wait = Math.max(1, Math.ceil((Math.min(...made) + CAP_WINDOW_MS - t) / 1000));
      const text = `agent writes are capped at ${per10Min} in ten minutes: the next is allowed in ${wait}s`;
      log(tool.name, args, `refused by the door: ${text}`, true);
      return failed(text);
    }
    made.push(t);
    const source = `${tool.method} ${path}`;
    const answer = await write(tool.method!, path, body, authorization);
    if (answer.status < 200 || answer.status >= 300) {
      const text = `${source} answered ${answer.status}: ${detailOf(answer.body)}`;
      log(tool.name, args, text, true);
      return failed(text);
    }
    const data = JSON.parse(answer.body) as Record<string, unknown>;
    const went = await notify(agentNotice(before === null ? null : agentRule(before), agentRule(data)));
    log(tool.name, args, `${source} answered ${answer.status}: rule ${String(data.id)}, ${NOTICE[went]}`, false);
    // the route's body with its figures rounded by key (#454), as every tool's answer is
    const text = canonical({ source, read_at: displayTime(at, displayTz), data: rounded(data, tool.round) });
    return { content: [{ type: "text", text }] };
  };

  return {
    has: (name: string) => WRITES.some((w) => w.tool === name),
    async call(name: string, args: unknown, authorization: string | null): Promise<ToolResult> {
      const tool = DESCRIBED.tools.find((t) => t.name === name)!;
      const refuse = (text: string) => {
        log(name, args, `refused by the door: ${text}`, true);
        return failed(text);
      };
      // the switch first: off, nothing is read, checked, written or counted
      if (!on) return refuse(WRITES_OFF);
      const fault = argumentFault(tool, args);
      if (fault !== null) return refuse(fault);
      const asked = (args ?? {}) as Record<string, unknown>;
      if (name === "add_rule") {
        const body = ruleBody(asked);
        if (isFault(body)) return refuse(body.fault);
        return send(tool, args, tool.path, body, null, authorization);
      }
      const change = editBody(asked);
      if (isFault(change)) return refuse(change.fault);
      // found exactly as monitor_history finds it, through the same GET
      const row = await resolveRow(read, LOOKUPS.monitor_history!, (asked.id as string).trim(), authorization);
      if (!isRow(row)) return refuse(row.content[0]!.text);
      // a rule the SERVICE switched off is the owner's to look at: unmuting it is refused, and so is
      // muting it again, which the route records as "manual" — after which it could be unmuted here
      // (review of #457). An edit that leaves `enabled` alone keeps the reason: the route rewrites it
      // only when `enabled` is given.
      const offByService = row.enabled !== true && row.disabled_reason !== "manual";
      if (change.enabled === true && offByService) {
        return refuse(`the rule "${row.id}" is off as "${String(row.disabled_reason)}", not muted by hand: `
          + 'edit_rule unmutes only a rule muted by hand (disabled_reason "manual")');
      }
      if (change.enabled === false && offByService) {
        return refuse(`the rule "${row.id}" is already off as "${String(row.disabled_reason)}", not muted by hand: `
          + 'edit_rule does not mute it again, which would make it a rule muted by hand (disabled_reason "manual")');
      }
      // only the RESOLVED id is put in the path, as a history tool's is
      return send(tool, args, tool.path.replace("{id}", encodeURIComponent(row.id)), change, row, authorization);
    },
  };
}
