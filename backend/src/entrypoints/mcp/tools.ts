/** The MCP door's tools (ADR 0026): what each one reads, how its arguments are checked, the short
 *  shared cache in front of the live ones, and the one way an answer is written.
 *
 *  **A tool is a GET of the API's own, and nothing else.** Each names one path the HTTP door
 *  already serves, and its answer's `data` is that GET's body. The tool cannot compute anything of
 *  its own, so it cannot disagree with the route — or with the dashboard, which reads the same
 *  route — and it cannot write: the only thing this module is handed is `read`, which `app.ts`
 *  builds to issue a GET and nothing else. No service, no query and no engine is imported here; a
 *  test (`server.test.ts`) holds this directory's imports to that.
 *
 *  **The table is shared ground**, `schema/mcp/server.json`, read by both backends (ADR 0021): the
 *  names, the descriptions an agent reads, the input schemas and which tools are live are written
 *  once, so the two cannot describe the same tool in two ways. What is CODE is here: the argument
 *  check, the path a call becomes, the cache and the text.
 *
 *  **The cache** is the owner's decision 7 on #447: the live reads — `/quotes`, `/positions/values`,
 *  `/references` — ask the Provider, whose snapshot limit (60 per 30 seconds) is shared with the
 *  sweep and the page, so an agent in a loop could otherwise starve the alarms. Every caller within
 *  `LIVE_FOR_MS` of a read gets that read, with the time it was made; a read still in flight is
 *  joined rather than repeated. Keyed by the path alone — the live tools take no arguments — so no
 *  argument can bust it. The page and the sweep never pass through here.
 */
import { readFileSync } from "node:fs";

import { displayTime } from "optionality/domain/timefmt";

import type { Read } from "../../ports.ts";


/** How long a live read is shared, in milliseconds (#447, decision 7: "~5s"). */
export const LIVE_FOR_MS = 5000;

/** One tool as `schema/mcp/server.json` states it. */
export interface Tool {
  name: string;
  title: string;
  description: string;
  /** the API path it GETs, with `{id}` where its one argument goes */
  path: string;
  /** whether it asks the Provider, and so is shared for `LIVE_FOR_MS` */
  live: boolean;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: "string"; pattern: string; description: string }>;
    required?: string[];
    additionalProperties: false;
  };
}

export interface Described {
  server: { name: string; title: string; version: string; instructions: string; protocol_versions: string[] };
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

const failed = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

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
    const { pattern } = properties[name]!;
    if (typeof value !== "string" || !new RegExp(pattern).test(value)) {
      return `argument "${name}" must be a string matching ${pattern}`;
    }
  }
  return null;
}

/** The `detail` of a refusal, as the dashboard reads it, or the body itself where it has none. */
function detailOf(body: string): string {
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
    tools: DESCRIBED.tools,
    has: (name: string) => DESCRIBED.tools.some((t) => t.name === name),
    async call(name: string, args: unknown, authorization: string | null): Promise<ToolResult> {
      const tool = DESCRIBED.tools.find((t) => t.name === name)!;
      const fault = argumentFault(tool, args);
      if (fault !== null) return failed(fault);
      const given = (args ?? {}) as Record<string, string>;
      const path = tool.path.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(given[key]!));
      const reading = tool.live ? live(path, authorization) : fresh(path, authorization);
      const { status, body } = await reading.answer;
      if (status !== 200) return failed(`GET ${path} answered ${status}: ${detailOf(body)}`);
      const answer = { source: `GET ${path}`, read_at: displayTime(reading.at, displayTz), data: JSON.parse(body) };
      return { content: [{ type: "text", text: canonical(answer) }] };
    },
  };
}
