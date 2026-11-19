/** The MCP door's writes (ADR 0028, #456; ADR 0029, #458): `add_rule` and `edit_rule`, behind
 *  `MCP_WRITES`, and `record_holding` and `correct_close`, behind `MCP_WRITES_POSITIONS` beside it — all
 *  four capped together by `MCP_WRITES_PER_10_MIN`, each one said to the owner's phone and in the log.
 *
 *  **What this module can write is four routes, and nothing else.** It is handed a `Write` of the app's
 *  own (`app.ts`) and wraps it at once in `allowedWrite`, which lets through only the method and path
 *  pairs `schema/mcp/server.json` lists for a write tool — `POST /monitors`, `PATCH /monitors/{id}`,
 *  `POST /positions` and `PATCH /positions/{id}`, an id one of the service's own — and refuses any other
 *  (a close, a delete) before the app is asked. No service, query
 *  or engine is imported here, as none is in `tools.ts` (`server.test.ts` holds both): a rule is
 *  written by the very routes the dashboard writes it through, their probe, their checks and their
 *  words, and this door adds only what an agent must not be able to do that the page may.
 *
 *  **What the door refuses itself**, before any route is asked and without counting against the cap:
 *  every write while the switch is off; arguments that are not the tool's shape; a `qty` other than 1
 *  (a rule on a structure with quantities is made on the page); a combo with no name, or a name on
 *  one contract; an edit of nothing; and unmuting a rule the service switched off — only a rule muted
 *  by hand (`manual`) may be unmuted here. Of the book's: a holding with no entry, contracts or open day,
 *  or one opened after today's New York market day or more than `OPENED_WITHIN_DAYS` before it; and a
 *  correction of anything but a close's exit and day, or of nothing. Everything else is the route's to refuse, and is said in its
 *  words, and counted: a refused probe still asked the Provider.
 *
 *  **The notice** is the domain's `agentNotice`, from the rule before (the `GET /monitors` row the
 *  lookup read) and after (the route's answer), sent through the `Notify` `main.ts` hands the door —
 *  the service's `delivery`, which logs a Telegram that is not configured or refuses; the write stands
 *  either way. The log line is this module's, one per write attempted.
 */
import { type AgentHolding, type AgentRule, agentHoldingNotice, agentNotice } from "optionality/domain/alarm";
import { normalizeStrikeDate } from "optionality/domain/contract";
import { marketDate } from "optionality/domain/expiry";
import { displayTime } from "optionality/domain/timefmt";

import type { Notify, Read, Write } from "../../ports.ts";
import {
  DESCRIBED, EXPIRY_PATTERN, LOOKUPS, type Tool, type ToolResult, argumentFault, canonical,
  detailOf, failed, isObject, isRow, keysFault, resolveRow, rounded, written,
} from "./tools.ts";

/** The writes `server.json` lists, one per write tool: the whole of what this door may write. */
export const WRITES: { tool: string; method: string; path: string; tier: "rules" | "positions" }[] = DESCRIBED.tools
  .filter((t) => t.method !== undefined)
  .map((t) => ({ tool: t.name, method: t.method!, path: t.path, tier: t.tier! }));

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
  const pairs = WRITES.map((w) => `${w.method} ${w.path}`);
  const listed = `${pairs.slice(0, -1).join(", ")} and ${pairs[pairs.length - 1]}`;
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

/** What a write to the book answers while it is off (ADR 0029): its switch named, and the one it needs. */
export const BOOK_OFF = "writes to the book are off on this service: record_holding and correct_close need "
  + "MCP_WRITES_POSITIONS=1, beside MCP_WRITES=1, in its .env, which only its owner sets";

/** How far back `record_holding`'s `opened_at` may be, in calendar days before today's New York market
 *  day (#458, the owner's decision): further back is recorded on the page. Stated in its description. */
export const OPENED_WITHIN_DAYS = 5;

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

/** A day as the route reads one, dashed, or null where it is no day. */
function dayOf(text: string): string | null {
  try {
    return normalizeStrikeDate(text);
  } catch {
    return null;
  }
}

/** Whole days from `from` to `to`, both YYYY-MM-DD: calendar days, whatever the zone. */
const daysBetween = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

/** `POST /positions`' body for `record_holding`'s arguments, or why there is none (#458, ADR 0029): a
 *  structure as `price_spreads` takes one, and what a holding is recorded with. Only the shape, the types
 *  and the `opened_at` window, against `today` — New York's market day by the injected clock; the rest
 *  is the route's. */
function holdingBody(args: Record<string, unknown>, today: string): Checked<Record<string, unknown>> {
  const { name, expiry, legs, entry, contracts, opened_at: opened, strategy } = args;
  if (typeof name !== "string") return { fault: '"name" must be a string' };
  if (typeof expiry !== "string" || !new RegExp(EXPIRY_PATTERN).test(expiry)) {
    return { fault: `"expiry" must be a string matching ${EXPIRY_PATTERN}` };
  }
  if (!Array.isArray(legs)) return { fault: '"legs" must be a list of legs' };
  if (legs.length === 0) return { fault: '"legs" must hold one leg or more' };
  const out: Record<string, unknown>[] = [];
  for (const [i, leg] of legs.entries()) {
    const where = `legs[${i}]`;
    if (!isObject(leg)) return { fault: `${where} must be an object` };
    const fault = keysFault(leg, where, "leg", ["side", "option_type", "strike", "qty"], ["side", "option_type", "strike"]);
    if (fault !== null) return { fault };
    const { side, option_type: type, strike, qty } = leg;
    if (side !== "short" && side !== "long") return { fault: `${where}.side must be "short" or "long"` };
    if (type !== "CALL" && type !== "PUT") return { fault: `${where}.option_type must be "CALL" or "PUT"` };
    if (typeof strike !== "number" || !Number.isFinite(strike)) return { fault: `${where}.strike must be a number` };
    if (given(qty) && (typeof qty !== "number" || !Number.isFinite(qty))) return { fault: `${where}.qty must be a number` };
    // the quantity as given — the route holds it to 1–10 — and none where none was given
    out.push({ side, option_type: type, strike, ...(given(qty) ? { qty } : {}) });
  }
  // required, and a null is not one: the route would read it as "unknown", which an agent may not leave
  if (typeof entry !== "number" || !Number.isFinite(entry)) return { fault: '"entry" must be a number' };
  if (typeof contracts !== "number" || !Number.isFinite(contracts)) return { fault: '"contracts" must be a number' };
  if (given(strategy) && typeof strategy !== "string") return { fault: '"strategy" must be a string' };
  if (typeof opened !== "string") return { fault: `"opened_at" must be a string matching ${EXPIRY_PATTERN}` };
  const day = dayOf(opened);
  if (day === null) return { fault: `opened_at ${opened} is not a day: use YYYY-MM-DD or YYYYMMDD` };
  const back = daysBetween(day, today);
  if (back < 0) {
    return { fault: `opened_at ${day} is after today's New York market day, ${today}: a holding is recorded here once it is opened` };
  }
  if (back > OPENED_WITHIN_DAYS) {
    return { fault: `opened_at ${day} is more than ${OPENED_WITHIN_DAYS} days before today's New York market day, ${today}: `
      + "a holding opened earlier is recorded on the page" };
  }
  return {
    name, strike_date: expiry, legs: out, entry, contracts, opened_at: opened, ...(given(strategy) ? { strategy } : {}),
  };
}

/** What `correct_close` may change (ADR 0029): a closed holding's exit and close day, and nothing else. */
const CORRECTABLE = ["exit", "closed_on"] as const;

/** `PATCH /positions/{id}`'s body for `correct_close`'s arguments, or why there is none: built from
 *  `CORRECTABLE` alone, so no other field of a holding can reach the route whatever was sent. */
function closeBody(args: Record<string, unknown>): Checked<Record<string, unknown>> {
  const change: Record<string, unknown> = {};
  for (const key of CORRECTABLE) {
    const value = args[key];
    if (!given(value)) continue;
    if (key === "exit" && (typeof value !== "number" || !Number.isFinite(value))) return { fault: '"exit" must be a number' };
    if (key === "closed_on") {
      if (typeof value !== "string") return { fault: `"closed_on" must be a string matching ${EXPIRY_PATTERN}` };
      if (dayOf(value) === null) return { fault: `closed_on ${value} is not a day: use YYYY-MM-DD or YYYYMMDD` };
    }
    change[key] = value;
  }
  if (Object.keys(change).length === 0) return { fault: "correct_close needs at least one change: exit or closed_on" };
  return change;
}

/** A holding as the route serves it, as `agentHoldingNotice` reads it. */
const agentHolding = (row: Record<string, unknown>): AgentHolding => ({
  name: String(row.name), strike_date: String(row.strike_date),
  legs: (Array.isArray(row.legs) ? row.legs : []) as AgentHolding["legs"],
  entry: typeof row.entry === "number" ? row.entry : null, contracts: Number(row.contracts),
  opened_at: typeof row.opened_at === "string" ? row.opened_at : null,
  exit: typeof row.exit === "number" ? row.exit : null,
  closed_on: typeof row.closed_on === "string" ? row.closed_on : null,
});

/** A rule as the route serves it, as `agentNotice` reads it. */
const agentRule = (row: Record<string, unknown>): AgentRule => ({
  code: String(row.code), field: String(row.field), combo: Array.isArray(row.legs) && row.legs.length > 0,
  compare: String(row.compare), direction: String(row.direction), threshold: Number(row.threshold),
  enabled: row.enabled === true,
  // the holdings the route linked it to, by name: what a rule added on one is said with (review of #457)
  holdings: Array.isArray(row.positions) ? (row.positions as { name?: unknown }[]).map((p) => String(p?.name)) : [],
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
  /** `MCP_WRITES_POSITIONS`, in force: already false unless `on` is true too (ADR 0029) */
  positions: boolean;
  /** `MCP_WRITES_PER_10_MIN` */
  per10Min: number;
}

/** The write tools, bound to the app they write to: `call` answers one `tools/call` of either. */
export function writer(options: WriterOptions) {
  const { read, notify, now, displayTz, on, positions, per10Min } = options;
  const write = allowedWrite(options.write);
  /** When each write that reached the route was made, oldest first: the cap's memory. */
  const made: number[] = [];

  const log = (tool: string, args: unknown, outcome: string, refused: boolean) =>
    (refused ? console.warn : console.info)(`mcp ${tool} ${canonical(args ?? {})}: ${outcome}`);

  /** The write itself, once the door has nothing to refuse: counted, made, said and answered. `tell` is
   *  the notice for the route's answer, and anything the log should add to it. */
  const send = async (
    tool: Tool, args: unknown, path: string, body: Record<string, unknown>, authorization: string | null,
    tell: (data: Record<string, unknown>) => Promise<{ notice: string; also?: string }>,
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
    const { notice, also } = await tell(data);
    const went = await notify(notice);
    const noun = tool.tier === "positions" ? "holding" : "rule";
    log(tool.name, args, `${source} answered ${answer.status}: ${noun} ${String(data.id)}, ${NOTICE[went]}${also ?? ""}`, false);
    // the route's body with its figures rounded by key (#454), as every tool's answer is
    const text = canonical({ source, read_at: displayTime(at, displayTz), data: rounded(data, tool.round) });
    return { content: [{ type: "text", text }] };
  };

  /** The rules the route linked to a holding it has just recorded, read back from `GET /monitors` (a
   *  read, never counted): what the record's notice names as taken over. A read that fails names none,
   *  and the log says so; the write stands. */
  const takenBy = async (id: string, authorization: string | null): Promise<{ taken: AgentRule[]; also?: string }> => {
    const { status, body } = await read("/monitors", authorization);
    if (status !== 200) return { taken: [], also: `; its rules not named: GET /monitors answered ${status}` };
    const rows = JSON.parse(body) as Record<string, unknown>[];
    const linked = rows.filter((r) => Array.isArray(r.positions)
      && (r.positions as { id?: unknown }[]).some((p) => p?.id === id));
    return { taken: linked.map(agentRule) };
  };

  return {
    has: (name: string) => WRITES.some((w) => w.tool === name),
    async call(name: string, args: unknown, authorization: string | null): Promise<ToolResult> {
      const tool = DESCRIBED.tools.find((t) => t.name === name)!;
      const refuse = (text: string) => {
        log(name, args, `refused by the door: ${text}`, true);
        return failed(text);
      };
      // the switch first, the tool's own tier's (ADR 0029): off, nothing is read, checked, written or counted
      if (tool.tier === "positions" ? !positions : !on) return refuse(tool.tier === "positions" ? BOOK_OFF : WRITES_OFF);
      const fault = argumentFault(tool, args);
      if (fault !== null) return refuse(fault);
      const asked = (args ?? {}) as Record<string, unknown>;
      if (name === "add_rule") {
        const body = ruleBody(asked);
        if (isFault(body)) return refuse(body.fault);
        return send(tool, args, tool.path, body, authorization, async (data) => ({ notice: agentNotice(null, agentRule(data)) }));
      }
      if (name === "record_holding") {
        // today in New York's reckoning, from the injected clock: never the machine's zone, nor UTC's day
        const body = holdingBody(asked, marketDate(now()));
        if (isFault(body)) return refuse(body.fault);
        return send(tool, args, tool.path, body, authorization, async (data) => {
          const { taken, also } = await takenBy(String(data.id), authorization);
          return { notice: agentHoldingNotice(null, agentHolding(data), taken), also };
        });
      }
      if (name === "correct_close") {
        const change = closeBody(asked);
        if (isFault(change)) return refuse(change.fault);
        // found exactly as holding_history finds it, through the same GET
        const row = await resolveRow(read, LOOKUPS.holding_history!, (asked.id as string).trim(), authorization);
        if (!isRow(row)) return refuse(row.content[0]!.text);
        // a correction must correct something: each value given already what the holding says is none
        const same = CORRECTABLE.filter((key) => key in change && (key === "exit"
          ? change.exit === row.exit
          : typeof row.closed_on === "string" && dayOf(change.closed_on as string) === dayOf(row.closed_on)));
        if (same.length === Object.keys(change).length) {
          const says = same.map((key) => `${key} ${key === "exit" ? written(row.exit as number) : dayOf(row.closed_on as string)}`);
          return refuse(`the close of ${String(row.name)} already says ${says.join(" and ")}: correct_close needs a change`);
        }
        // only the RESOLVED id is put in the path; the route refuses an exit or a close day on a holding
        // still open, so this can never close one
        return send(tool, args, tool.path.replace("{id}", encodeURIComponent(row.id)), change, authorization,
          async (data) => ({ notice: agentHoldingNotice(agentHolding(row), agentHolding(data)) }));
      }
      const change = editBody(asked);
      if (isFault(change)) return refuse(change.fault);
      // found exactly as monitor_history finds it, through the same GET
      const row = await resolveRow(read, LOOKUPS.monitor_history!, (asked.id as string).trim(), authorization);
      if (!isRow(row)) return refuse(row.content[0]!.text);
      // only a WATCH rule (the owner's decision on #456): a rule linked to a holding — `positions` or
      // `scope`, as GET /monitors serves it — is the page's to change
      const holdings = Array.isArray(row.positions)
        ? (row.positions as { name?: unknown }[]).map((p) => String(p?.name)) : [];
      if (holdings.length > 0 || (row.scope !== null && row.scope !== undefined)) {
        const which = holdings.length === 0 ? "a holding" : `the holding${holdings.length > 1 ? "s" : ""} ${holdings.join(", ")}`;
        return refuse(`the rule "${row.id}" watches ${which}: a holding's rules are changed on the page, `
          + "and edit_rule changes only a watch rule");
      }
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
      return send(tool, args, tool.path.replace("{id}", encodeURIComponent(row.id)), change, authorization,
        async (data) => ({ notice: agentNotice(agentRule(row), agentRule(data)) }));
    },
  };
}
