/** A stub IB Gateway on a port, for driving the socket client by hand.
 *
 *      make ibkr-fake-gateway
 *      make ibkr-fake-gateway ARGS="--port 4099 --no-figures"
 *
 *  It answers NO real market data: every reply is a byte sequence recorded from the official
 *  Python client (what we send) and from the real gateway on this machine (what comes back), on
 *  2026-11-08 at protocol 157. A session against this proves the CLIENT works and is never
 *  evidence about IB Gateway, an account's entitlements, or a live market — the same warning
 *  `ibkr-fake-gateway.ts` carries, for the same reason.
 *
 *  The replies live in `src/ibkr/fake.ts` so that the suite and this tool cannot drift apart.
 */
import { startFakeGateway } from "../src/ibkr/fake.ts";

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

const port = Number(option("port") ?? 4099);
const options = {
  noFigures: args.includes("--no-figures"),
  silent: args.includes("--silent"),
  refuseSession: args.includes("--refuse") ? "client id is already in use" : undefined,
  serverVersion: option("server-version") ? Number(option("server-version")) : undefined,
};

const gateway = await startFakeGateway(port, options);
const shape = Object.entries(options).filter(([, v]) => v !== undefined && v !== false)
  .map(([k, v]) => `${k}=${v}`).join(" ");
console.log(`fake IB Gateway on 127.0.0.1:${gateway.port} — answers NO real market data`);
if (shape) console.log(`  pretending: ${shape}`);
