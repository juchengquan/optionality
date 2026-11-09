/** A stub IB Gateway on a port, for driving the socket client by hand.
 *
 *      make ibkr-fake-gateway
 *      make ibkr-fake-gateway ARGS="--port 4099 --conversation link-down"
 *
 *  It answers NO real market data: it replays one conversation from
 *  `testdata/vendors/ibkr-gateway/`, each of which says whether it was recorded from the real
 *  gateway on this machine or constructed, and why. A session against this proves the CLIENT
 *  works and is never evidence about IB Gateway, an account's entitlements, or a live market.
 *
 *  The replaying is the library's `typescript/src/vendors/ibkr/fake.ts`, reached by its
 *  published name, so that the library's suite and this tool cannot drift apart — and the files
 *  are the ones a Python stub replays to `ib_async` (ADR 0021), so neither can the two languages.
 */
import { DEFAULT_CONVERSATION, startFakeGateway } from "optionality/vendors/ibkr/fake";

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

const port = Number(option("port") ?? 4099);
const conversation = option("conversation") ?? DEFAULT_CONVERSATION;
const serverVersion = option("server-version") ? Number(option("server-version")) : undefined;

const gateway = await startFakeGateway(port, { conversation, serverVersion });
const { provenance, summary, ask } = gateway.conversation;
console.log(`fake IB Gateway on 127.0.0.1:${gateway.port} — answers NO real market data`);
console.log(`  replaying: ${conversation} (${provenance.kind}) — ${summary}`);
console.log(`  recorded for: ${ask.join(", ")}`);
if (serverVersion !== undefined) console.log(`  pretending: serverVersion=${serverVersion}`);
