/** The MCP door's tools (ADR 0026): what each one reads, how its arguments are checked, the short
 *  shared cache in front of the live ones, and the one way an answer is written.
 *
 *  **A tool is a GET of the API's own, and nothing else.** Each names one path the HTTP door
 *  already serves, and its answer's `data` is that GET's body, its figures rounded by key (#454:
 *  `byKey`, by the table in `server.json`, the one change it makes). The tool cannot compute anything of
 *  its own, so it cannot disagree with the route — or with the dashboard, which reads the same
 *  route — and it cannot write: the only thing this module is handed is `read`, which `app.ts`
 *  builds to issue a GET and nothing else. No service, no query and no engine is imported here; a
 *  test (`server.test.ts`) holds this directory's imports to that.
 *
 *  **The table is shared ground**, `schema/mcp/server.json`, read by both backends (ADR 0021): the
 *  names, the descriptions an agent reads, the input schemas and which tools are live are written
 *  once, so the two cannot describe the same tool in two ways. What is CODE is here: the argument
 *  check, how a history tool's name becomes an id (`LOOKUPS`), the path a call becomes, the cache,
 *  the rounding and the text. Which key is rounded to how many places is the table's (each tool's
 *  `round`, and `rounding.by_field`), so the two backends round exactly the same figures.
 *
 *  **The cache** is the owner's decision 7 on #447: the live reads — `/quotes`, `/positions/values`,
 *  `/references` — ask the Provider, whose snapshot limit (60 per 30 seconds) is shared with the
 *  sweep and the page, so an agent in a loop could otherwise starve the alarms. Every caller within
 *  `LIVE_FOR_MS` of a read gets that read, with the time it was made; a read still in flight is
 *  joined rather than repeated. Keyed by the path alone — those three take no arguments — so no
 *  argument can bust it. The page and the sweep never pass through here.
 *
 *  **`price_spreads` is live and NOT cached here** (ADR 0027, `"cached_by": "route"`): its route,
 *  `GET /spreads/quote`, shares its batch for 5 seconds and caps its calls whoever asks, so a second
 *  window in front of it would only serve a batch up to ten seconds old. Its arguments are the one
 *  structured input a tool takes: `QUERIES` writes them as the route's query, checking only what it
 *  must to write it, and every other refusal is the route's 422 in the route's words.
 */
import { readFileSync } from "node:fs";

import { ruleShort } from "optionality/domain/alarm";
import { expandSpxShort } from "optionality/domain/contract";
import { displayTime } from "optionality/domain/timefmt";

import type { Read } from "../../ports.ts";


/** How long a live read is shared, in milliseconds (#447, decision 7: "~5s"). */
export const LIVE_FOR_MS = 5000;

/** One tool as `schema/mcp/server.json` states it. */
export interface Tool {
  name: string;
  title: string;
  description: string;
  /** a WRITE tool's method (ADR 0028); absent, the tool is a GET */
  method?: "POST" | "PATCH";
  /** the API path it GETs (or writes), with `{id}` where its one argument goes */
  path: string;
  /** what a client may tell its user before calling it (ADR 0028), listed as they are */
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  /** whether it asks the Provider, and so is shared for `LIVE_FOR_MS` — unless `cached_by` says
   *  its route shares it already */
  live: boolean;
  /** "route" where the route shares its own answers (ADR 0027), so this door does not */
  cached_by?: "route";
  /** how its answer's figures are rounded, by key (#454): see `byKey` */
  round: Rounding;
  inputSchema: {
    type: "object";
    /** a string argument has a `pattern`; a structured one is written by its tool's `QUERIES` entry */
    properties: Record<string, { type: string; pattern?: string; description?: string }>;
    required?: string[];
    additionalProperties: false;
  };
}

/** How one tool's figures are rounded (#454), by the KEY each figure is under: `keys` names a key
 *  and its places, for a number under it or each number in a list under it; `maps` names a key whose
 *  value is a map — a leg's reading by contract code — and the places of its every value; `by_field`
 *  names the keys a rule's figure is under, rounded by the places of the rule's own `field`. */
export interface Rounding {
  keys?: Record<string, number>;
  maps?: Record<string, number>;
  by_field?: string[];
}

export interface Described {
  server: {
    name: string; title: string; version: string; instructions: string; protocol_versions: string[];
    /** what the instructions add, by whether an agent's writes are on (ADR 0028); `{cap}` is the cap */
    writes_on: string; writes_off: string;
  };
  /** the places of a rule's figure, by the field it watches (#454): every watchable field, null where
   *  it is a count, a strike or a size and never rounded */
  rounding: { by_field: Record<string, number | null> };
  tools: Tool[];
}

/** `schema/mcp/server.json`, resolved from this module as `db/open.ts` resolves `schema/`. */
export const DESCRIBED: Described = JSON.parse(
  readFileSync(new URL("../../../../schema/mcp/server.json", import.meta.url), "utf8"),
) as Described;

/** What a `tools/call` answers (MCP's CallToolResult): the text, and `isError` only on a failure. */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: true;
}

/** JSON with every object's keys sorted and nothing between the tokens.
 *
 *  Sorted because the two backends build their bodies in their own key order, and the scenarios
 *  compare an answer's TEXT exactly (ADR 0021) — the Python writes the same bytes with the same
 *  rule (`tools.py`). Written by hand rather than with a replacer, because a JavaScript object
 *  orders integer-like keys numerically whatever order they are put in. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`).join(",")}}`;
}

/** A figure to `places` decimals, half away from zero on the value the double holds — exactly
 *  `toFixed`'s rule, which the Python reproduces as `optionality.js.to_fixed` — and a zero rounded
 *  from a negative made 0, so neither backend can write -0. Held to `testdata/mcp/rounding.json`. */
export function roundTo(value: number, places: number): number {
  return Number(value.toFixed(places)) + 0;
}

const own = <T>(table: Record<string, T> | undefined, key: string): T | undefined =>
  table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;

/** `data` with every number replaced by `figure(number, places)`, where `places` is what `rounding`
 *  says for the key it is under, or null where the table names none (#454).
 *
 *  A number takes its places from the key directly above it: `keys`, or — for one of `by_field`'s
 *  keys — from the object's own `field`, through `DESCRIBED.rounding.by_field`; a list of numbers
 *  under a key takes that key's (`breakevens`); a map under one of `maps`' keys takes its places for
 *  every value. An object starts afresh, in a list or not, so nothing is inherited past one level.
 *  One walk for the answer and for the test that holds the table to every scenario. */
export function byKey(data: unknown, rounding: Rounding, figure: (value: number, places: number | null) => number): unknown {
  const each = (value: unknown, places: number | null): unknown => {
    if (typeof value === "number") return figure(value, places);
    if (Array.isArray(value)) return value.map((v) => typeof v === "number" ? figure(v, places) : walk(v));
    return walk(value);
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "number") return figure(value, null);
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    const field = typeof object.field === "string" ? own(DESCRIBED.rounding.by_field, object.field) : undefined;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(object)) {
      const places = own(rounding.keys, key) ?? (rounding.by_field?.includes(key) ? field : undefined);
      const mapped = own(rounding.maps, key);
      if (places !== undefined) out[key] = each(v, places);
      else if (mapped !== undefined && v !== null && typeof v === "object" && !Array.isArray(v)) {
        out[key] = Object.fromEntries(Object.entries(v).map(([code, x]) => [code, each(x, mapped)]));
      } else out[key] = each(v, null);
    }
    return out;
  };
  return walk(data);
}

/** `data` with its figures rounded as `rounding` says, and every other value as it was. */
export const rounded = (data: unknown, rounding: Rounding): unknown =>
  byKey(data, rounding, (value, places) => places === null ? value : roundTo(value, places));

export const failed = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Why these arguments are not this tool's, in words an agent can correct itself from, or null. */
export function argumentFault(tool: Tool, args: unknown): string | null {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const given = args as Record<string, unknown>;
  const { properties, required = [] } = tool.inputSchema;
  const named = Object.keys(properties);
  const extra = Object.keys(given).filter((k) => !named.includes(k)).sort();
  if (extra.length > 0) {
    const takes = named.length === 0 ? "takes no arguments" : `takes only ${named.map((n) => `"${n}"`).join(", ")}`;
    return `unexpected argument "${extra[0]}": ${tool.name} ${takes}`;
  }
  for (const name of required) {
    if (!(name in given)) return `missing argument "${name}"`;
  }
  for (const name of named) {
    if (!(name in given)) continue;
    const value = given[name];
    const { type, pattern } = properties[name]!;
    // a structured argument is its tool's to check, as it writes the query (`QUERIES`)
    if (type !== "string" || pattern === undefined) continue;
    if (typeof value !== "string" || !new RegExp(pattern).test(value)) {
      return `argument "${name}" must be a string matching ${pattern}`;
    }
  }
  return null;
}

/** A value an agent sent, at `at` in its arguments, as the words for a refusal name it. */
type Checked<T> = T | { fault: string };
const isFault = <T>(value: Checked<T>): value is { fault: string } =>
  value !== null && typeof value === "object" && "fault" in value;

export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Why an object is not one with exactly these keys, these `required`, or null. */
export function keysFault(value: Record<string, unknown>, at: string, noun: string, keys: string[], required: string[]): string | null {
  for (const key of required) if (!(key in value)) return `${at} is missing "${key}"`;
  const extra = Object.keys(value).filter((k) => !keys.includes(k)).sort();
  if (extra.length > 0) {
    return `${at} has an unexpected "${extra[0]}": a ${noun} takes only ${keys.map((k) => `"${k}"`).join(", ")}`;
  }
  return null;
}

/** A number as JavaScript writes it, which the route's grammar reads (`js_string` in the Python). */
export const written = (n: number) => String(n);

/** The pattern an expiry must match before it is written into a query: `server.json`'s, read there. */
export const EXPIRY_PATTERN = "^[0-9]{4}-?[0-9]{2}-?[0-9]{2}$";

/** One structure as the route's `spread` reads it, `<expiry>:<legs>[@<entry>]`, or why it cannot be
 *  written. Only the shape and the types: what the route would refuse — a quantity of 11, seven legs,
 *  an expired day — it refuses, in its words. A null `qty` or `entry` is one not given. */
function structureText(value: unknown, at: string): Checked<string> {
  if (!isObject(value)) return { fault: `${at} must be an object` };
  const keys = keysFault(value, at, "structure", ["expiry", "legs", "entry"], ["expiry", "legs"]);
  if (keys !== null) return { fault: keys };
  const { expiry, legs, entry } = value;
  if (typeof expiry !== "string" || !new RegExp(EXPIRY_PATTERN).test(expiry)) {
    return { fault: `${at}.expiry must be a string matching ${EXPIRY_PATTERN}` };
  }
  if (!Array.isArray(legs)) return { fault: `${at}.legs must be a list of legs` };
  const written_legs: string[] = [];
  for (const [i, leg] of legs.entries()) {
    const where = `${at}.legs[${i}]`;
    if (!isObject(leg)) return { fault: `${where} must be an object` };
    const fault = keysFault(leg, where, "leg", ["side", "option_type", "strike", "qty"], ["side", "option_type", "strike"]);
    if (fault !== null) return { fault };
    const { side, option_type: type, strike, qty } = leg;
    if (side !== "short" && side !== "long") return { fault: `${where}.side must be "short" or "long"` };
    if (type !== "CALL" && type !== "PUT") return { fault: `${where}.option_type must be "CALL" or "PUT"` };
    if (typeof strike !== "number" || !Number.isFinite(strike)) return { fault: `${where}.strike must be a number` };
    if (qty !== undefined && qty !== null && (typeof qty !== "number" || !Number.isFinite(qty))) {
      return { fault: `${where}.qty must be a number` };
    }
    const times = qty === undefined || qty === null ? "" : `x${written(qty)}`;
    written_legs.push(`${side === "short" ? "-" : "+"}${type[0]}${written(strike)}${times}`);
  }
  if (entry !== undefined && entry !== null && (typeof entry !== "number" || !Number.isFinite(entry))) {
    return { fault: `${at}.entry must be a number` };
  }
  return `${expiry}:${written_legs.join(",")}${entry === undefined || entry === null ? "" : `@${written(entry)}`}`;
}

/** The query a tool's structured arguments become, by tool: its path is the table's, and this is
 *  what follows the `?`. Only `price_spreads` has one (ADR 0027). */
const QUERIES: Record<string, (given: Record<string, unknown>) => Checked<string>> = {
  price_spreads: (given) => {
    const { structures } = given;
    if (!Array.isArray(structures)) return { fault: '"structures" must be a list of structures' };
    const parts: string[] = [];
    for (const [i, structure] of structures.entries()) {
      const text = structureText(structure, `structures[${i}]`);
      if (isFault(text)) return text;
      parts.push(`spread=${encodeURIComponent(text)}`);
    }
    return parts.join("&");
  },
};

/** The `detail` of a refusal, as the dashboard reads it, or the body itself where it has none. */
export function detailOf(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object" && typeof (parsed as { detail?: unknown }).detail === "string") {
      return (parsed as { detail: string }).detail;
    }
  } catch {
    /* not JSON: the body is the words */
  }
  return body;
}

/** What a resolved id must be before a path is built from it: the service's own ids are all this. */
const AN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A row of a list GET, as far as resolving a name needs it. */
export type Row = Record<string, unknown> & { id: string };

/** How a history tool's `id` — an id OR a name (#447's follow-up, decided 2026-11-18) — becomes the
 *  one id its path is built from: the list GET that holds every candidate, the rows `given` names,
 *  in order of precedence, and the words for each.
 *
 *  Resolved through a GET the API already serves, never a query of its own, so the door still reads
 *  through `read` alone; and the INPUT never reaches a path — only an id read back from that list,
 *  held to `AN_ID` — so a name like `../quotes` is looked up and not found, never followed. */
interface Lookup {
  list: string;
  /** what one is called in the words, "rule" or "holding" */
  noun: string;
  /** the rows `given` names: by exact id first, and only where none has it, by name */
  named(rows: Row[], given: string): Row[];
  /** one candidate, as an agent picks between several */
  label(row: Row): string;
  /** what was tried, for the words when nothing matched */
  tried(given: string): string;
  /** the tool that lists every candidate's id */
  lister: string;
}

const byId = (rows: Row[], given: string) => rows.filter((r) => r.id === given);

export const LOOKUPS: Record<string, Lookup> = {
  holding_history: {
    list: "/positions",
    noun: "holding",
    // names are unique (`ix_positions_name`), and /positions lists the closed ones too
    named: (rows, given) => {
      const exact = byId(rows, given);
      return exact.length > 0 ? exact : rows.filter((r) => r.name === given);
    },
    label: (r) => `${r.id} — ${String(r.name)}`,
    tried: () => "as a holding's id and as its name",
    lister: "positions",
  },
  monitor_history: {
    list: "/monitors",
    noun: "rule",
    // a rule's code as stored — a combo's name, a contract's `US.SPXW…` — or a contract the way the
    // page and the bot write it, read by the bot's own `/unwatch` parser
    named: (rows, given) => {
      const exact = byId(rows, given);
      if (exact.length > 0) return exact;
      const contract = expandSpxShort(given);
      return rows.filter((r) => r.code === given || (contract !== null && r.code === contract));
    },
    label: (r) => `${r.id} — ${ruleShort({
      field: String(r.field), combo: Array.isArray(r.legs) && r.legs.length > 0, compare: String(r.compare),
      direction: String(r.direction), threshold: Number(r.threshold),
    })}`,
    tried: (given) => {
      const contract = expandSpxShort(given);
      return `as a rule's id, as its code or combo name${contract === null ? "" : `, and as the contract ${contract}`}`;
    },
    lister: "watchlist",
  },
};

/** The one row `given` names, read through `read` from `lookup.list` — its id held to `AN_ID`, so it
 *  can be put in a path — or the tool error saying why there is not one. A history tool takes its id;
 *  `edit_rule` (ADR 0028) takes the row too, for the rule before the write and why it is off. */
export async function resolveRow(
  read: Read, lookup: Lookup, given: string, authorization: string | null,
): Promise<Row | ToolResult> {
  const { status, body } = await read(lookup.list, authorization);
  if (status !== 200) return failed(`GET ${lookup.list} answered ${status}: ${detailOf(body)}`);
  const named = lookup.named(JSON.parse(body) as Row[], given);
  if (named.length === 0) {
    return failed(`no ${lookup.noun} is "${given}": tried it ${lookup.tried(given)}. ${lookup.lister} lists every ${lookup.noun}'s id`);
  }
  if (named.length > 1) {
    return failed([`"${given}" names ${named.length} ${lookup.noun}s; call again with one of their ids:`,
      ...named.map(lookup.label)].join("\n"));
  }
  const row = named[0]!;
  // the service's ids are all this; anything else is not put in a path whatever it is
  if (typeof row.id !== "string" || !AN_ID.test(row.id)) return failed(`the ${lookup.noun} "${given}" has an id no path can carry`);
  return row;
}

/** Whether `resolveRow` answered a row rather than a refusal. */
export const isRow = (found: Row | ToolResult): found is Row => !("content" in found);

interface Reading {
  at: Date;
  answer: Promise<{ status: number; body: string }>;
}

/** The tools, bound to the API they read: `call` answers one `tools/call`. */
export function toolbox(options: { read: Read; now(): Date; displayTz: string }) {
  const { read, now, displayTz } = options;
  /** The live reads, by path: one per path, shared until it is `LIVE_FOR_MS` old. */
  const shared = new Map<string, Reading>();

  const fresh = (path: string, authorization: string | null): Reading =>
    ({ at: now(), answer: read(path, authorization) });

  const live = (path: string, authorization: string | null): Reading => {
    const at = now();
    const held = shared.get(path);
    // a clock that went BACK is no reason to trust an old answer: read again
    if (held && at.getTime() >= held.at.getTime() && at.getTime() - held.at.getTime() < LIVE_FOR_MS) return held;
    const reading = fresh(path, authorization);
    shared.set(path, reading);
    // a read that THREW is not an answer to share; one that answered a refusal is, so a Provider
    // that is down is asked once per window rather than once per call
    reading.answer.catch(() => { if (shared.get(path) === reading) shared.delete(path); });
    return reading;
  };

  return {
    /** the READ tools: a write tool is `writes.ts`' */
    has: (name: string) => DESCRIBED.tools.some((t) => t.name === name && t.method === undefined),
    async call(name: string, args: unknown, authorization: string | null): Promise<ToolResult> {
      const tool = DESCRIBED.tools.find((t) => t.name === name)!;
      const fault = argumentFault(tool, args);
      if (fault !== null) return failed(fault);
      const given = (args ?? {}) as Record<string, string>;
      const resolved: Record<string, string> = {};
      const lookup = LOOKUPS[tool.name];
      if (lookup !== undefined) {
        const found = await resolveRow(read, lookup, given.id!.trim(), authorization);
        if (!isRow(found)) return found;
        resolved.id = found.id;
      }
      // only a RESOLVED id is ever put in a path, never what the caller typed
      let path = tool.path.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(resolved[key]!));
      const query = QUERIES[tool.name];
      if (query !== undefined) {
        const written = query(given as Record<string, unknown>);
        if (isFault(written)) return failed(written.fault);
        path = `${path}?${written}`;
      }
      // a tool whose route shares its own answers is read afresh here: one window, not two
      const reading = tool.live && tool.cached_by !== "route" ? live(path, authorization) : fresh(path, authorization);
      const { status, body } = await reading.answer;
      if (status !== 200) return failed(`GET ${path} answered ${status}: ${detailOf(body)}`);
      // the GET's body with its figures rounded by key (#454); a refusal above is its words, unrounded
      const data = rounded(JSON.parse(body), tool.round);
      const answer = { source: `GET ${path}`, read_at: displayTime(reading.at, displayTz), data };
      return { content: [{ type: "text", text: canonical(answer) }] };
    },
  };
}
