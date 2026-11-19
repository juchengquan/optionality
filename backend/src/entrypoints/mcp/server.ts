/** The MCP door's protocol (ADR 0026): MCP's Streamable HTTP transport, stateless, on the API's own
 *  port — one JSON-RPC message per POST, answered with one JSON body.
 *
 *  **Written by hand rather than with the official SDK**, and the reason is the second backend.
 *  ADR 0021 holds the two to the same answers at the door, and the door scenarios compare them
 *  exactly: two SDKs, one per language, word their own refusals, validate in their own order and
 *  carry their own defaults, and every difference would be a scenario that fails for a reason
 *  neither backend chose. The subset a read-only server needs is small — `initialize`, `ping`,
 *  `tools/list`, `tools/call` and the notifications — and written twice from one description it
 *  answers the same in both. It also keeps a dependency, in each language, out of the service.
 *
 *  **Stateless.** No session id is issued and none is read, and there is no event stream: `GET`
 *  answers 405, which the transport defines as "this server offers no stream". Every tool is a read
 *  whose answer stands alone, so there is nothing to keep between two requests — the shared cache
 *  in `tools.ts` is the service's, not a session's.
 *
 *  **What reaches it** has already passed the HTTP door's token check: `app.ts` mounts it behind
 *  the same guard as every route, so the token that reads `/quotes` is the token that reads this.
 *  A request carrying an `Origin` is refused: only a browser sends one, no page of this service
 *  speaks MCP, and refusing it is what the transport asks of a server to stop DNS rebinding.
 */
import type { Notify, Read, Write } from "../../ports.ts";
import { DESCRIBED, type ToolResult, toolbox } from "./tools.ts";
import { writer } from "./writes.ts";

export interface McpOptions {
  /** a GET of the API's own (`app.ts`); the only way this door reads anything */
  read: Read;
  /** a write of the API's own (`app.ts`), which the door holds to the two `server.json` lists
   *  (`allowedWrite`, ADR 0028) — and makes none of while `writes` is off */
  write: Write;
  /** telling the owner of each write an agent made (ADR 0028): the service's `delivery` */
  notify: Notify;
  /** `MCP_WRITES`: whether `add_rule` and `edit_rule` are listed and answered */
  writes: boolean;
  /** `MCP_WRITES_POSITIONS` as `.env` says it (ADR 0029): whether `record_holding` and `correct_close`
   *  are listed and answered — in force only while `writes` is on too */
  writesPositions: boolean;
  /** `MCP_WRITES_PER_10_MIN` */
  writesPer10Min: number;
  /** the clock, injected as the routes' is, for the cache and every answer's `read_at` */
  now(): Date;
  /** the zone `read_at` is written in, the API's `DISPLAY_TZ` */
  displayTz: string;
}

/** JSON-RPC's own error codes, and the one the transport leaves to the server. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const REFUSED = -32000;

type Id = string | number | null;
type Message = Record<string, unknown>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const failure = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** An id JSON-RPC allows on a request: a string or a number, never null on one that wants an answer. */
const isId = (id: unknown): id is string | number =>
  typeof id === "string" || (typeof id === "number" && Number.isFinite(id));

/** What a refused message is answered with an id of: its own, where it had a usable one. */
const idOf = (message: unknown): Id =>
  message !== null && typeof message === "object" && isId((message as Message).id)
    ? (message as Message).id as string | number : null;

/** A request refused with a JSON-RPC error rather than a result. (A field assigned in the body:
 *  Node strips types and cannot run a parameter property.) */
class Refusal extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** The handler `app.ts` mounts at `/mcp`. */
export function mcpServer(options: McpOptions): (request: Request) => Promise<Response> {
  const tools = toolbox(options);
  // the book's switch is in force only beside the rules' (ADR 0029): on alone, it is said once — this
  // door is built once, at boot — and treated as off
  const positions = options.writes && options.writesPositions;
  if (options.writesPositions && !options.writes) {
    console.warn("MCP_WRITES_POSITIONS is on but MCP_WRITES is off: an agent's writes to the book stay off until MCP_WRITES is on too");
  }
  const writes = writer({
    read: options.read, write: options.write, notify: options.notify, now: options.now,
    displayTz: options.displayTz, on: options.writes, positions, per10Min: options.writesPer10Min,
  });
  const { server } = DESCRIBED;
  // off, a write tool is not listed (ADR 0028, 0029): an agent is not offered what it would be refused
  const listed = DESCRIBED.tools.filter((t) => t.method === undefined || (t.tier === "positions" ? positions : options.writes));
  const said = !options.writes ? server.writes_off
    : `${server.writes_on.replaceAll("{cap}", String(options.writesPer10Min))} ${positions ? server.positions_on : server.positions_off}`;

  const methods: Record<string, (params: Message, authorization: string | null) => Promise<unknown>> = {
    async initialize(params) {
      const asked = params.protocolVersion;
      // the version the client asked for where this server speaks it, else the newest it does —
      // the client then decides whether it can go on (the lifecycle's negotiation)
      const protocolVersion = typeof asked === "string" && server.protocol_versions.includes(asked)
        ? asked : server.protocol_versions[0];
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, title: server.title, version: server.version },
        instructions: `${server.instructions} ${said}`,
      };
    },
    async ping() {
      return {};
    },
    async "tools/list"() {
      return {
        // what a client may tell its user before calling (ADR 0028): each tool's, from the table
        tools: listed.map(({ name, title, description, inputSchema, annotations }) => ({
          name, title, description, inputSchema, annotations,
        })),
      };
    },
    async "tools/call"(params, authorization): Promise<ToolResult> {
      const { name } = params;
      if (typeof name !== "string") throw new Refusal(INVALID_PARAMS, "tools/call needs the tool's name");
      // a write tool is known whether writes are on or off: off, it answers that they are
      if (writes.has(name)) return writes.call(name, params.arguments, authorization);
      if (!tools.has(name)) throw new Refusal(INVALID_PARAMS, `Unknown tool: ${name}`);
      return tools.call(name, params.arguments, authorization);
    },
  };

  return async (request) => {
    if (request.headers.get("Origin") !== null) {
      return json(403, failure(null, REFUSED, "Forbidden: /mcp answers no browser page (a request with an Origin)"));
    }
    if (request.method !== "POST") {
      return json(405, failure(null, REFUSED, "Method not allowed: /mcp takes one JSON-RPC message per POST, and offers no stream"),
        { Allow: "POST" });
    }
    // the transport's rule for a request after initialization: a version this server does not
    // speak is a 400, never answered as though it were one it does
    const version = request.headers.get("MCP-Protocol-Version");
    if (version !== null && !server.protocol_versions.includes(version)) {
      return json(400, failure(null, INVALID_REQUEST, `Bad Request: unsupported MCP-Protocol-Version ${version}; this server speaks ${server.protocol_versions.join(", ")}`));
    }
    let message: unknown;
    try {
      message = JSON.parse(await request.text());
    } catch {
      return json(400, failure(null, PARSE_ERROR, "Parse error: the body is not JSON"));
    }
    if (Array.isArray(message)) {
      return json(400, failure(null, INVALID_REQUEST, "Invalid Request: one message per POST; batches are not supported"));
    }
    if (message === null || typeof message !== "object" || (message as Message).jsonrpc !== "2.0") {
      return json(400, failure(idOf(message), INVALID_REQUEST, "Invalid Request: not a JSON-RPC 2.0 message"));
    }
    const m = message as Message;
    // a response or an error from the client — to nothing this server asked — is accepted, and so
    // is any notification: neither wants an answer, and this server acts on none
    if (!("method" in m) || !("id" in m)) {
      if ("method" in m && typeof m.method !== "string") {
        return json(400, failure(null, INVALID_REQUEST, "Invalid Request: the method must be a string"));
      }
      return new Response(null, { status: 202 });
    }
    if (typeof m.method !== "string" || !isId(m.id)) {
      return json(400, failure(idOf(m), INVALID_REQUEST, "Invalid Request: a request needs a string method and a string or number id"));
    }
    const id = m.id;
    const params = m.params ?? {};
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      return json(200, failure(id, INVALID_PARAMS, "Invalid params: params must be an object"));
    }
    const method = Object.hasOwn(methods, m.method) ? methods[m.method] : undefined;
    if (method === undefined) return json(200, failure(id, METHOD_NOT_FOUND, `Method not found: ${m.method}`));
    try {
      const result = await method(params as Message, request.headers.get("Authorization"));
      return json(200, { jsonrpc: "2.0", id, result });
    } catch (err) {
      if (err instanceof Refusal) return json(200, failure(id, err.code, err.message));
      throw err;
    }
  };
}
