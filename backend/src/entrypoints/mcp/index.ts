/** The MCP door's one door (ADR 0026): the handler `main.ts` mounts at `/mcp` through `createApp`,
 *  and the options it is built with.
 *
 *  Behind it: `server.ts` (the protocol — MCP's Streamable HTTP, stateless, one JSON-RPC message per
 *  POST), `tools.ts` (the read tools, each a GET of the API's own, and the shared cache in front of
 *  the live ones) and `writes.ts` (the two write tools, ADR 0028: off unless `MCP_WRITES`, held to
 *  `POST /monitors` and `PATCH /monitors/{id}`). The table they serve is shared ground,
 *  `schema/mcp/server.json`.
 *
 *  A surface of its own rather than routes inside `http/`, because it is a different way in for a
 *  different client — an agent, not the dashboard — with its own protocol, as the bot is (ADR
 *  0020). But it serves nothing the HTTP door does not: it is handed a GET of the API's own, a write
 *  of the API's own that it holds to two routes (ADR 0028) and a way to tell the owner, so it can
 *  neither compute a figure the routes do not nor reach any other write. It is
 *  mounted on the HTTP server because that is where the tailnet already reaches (`/opt/api/mcp`,
 *  behind the same proxy and the same token), and `main.ts` does the mounting: this door imports
 *  nothing from `http/`, and `http/` nothing from it.
 */
export { type McpOptions, mcpServer } from "./server.ts";
