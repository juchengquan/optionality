/** One snapshot read through the TypeScript WebSocket client, for the OpenD differential. */
import { readFileSync, writeFileSync } from "node:fs";

import { OpendClient } from "../../src/opend/client.ts";

const codes = JSON.parse(readFileSync(process.argv[2], "utf8"));
const client = new OpendClient({
  host: process.env.OPEND_HOST ?? "127.0.0.1",
  port: Number(process.env.MOOMOO_WS_PORT),
  key: process.env.MOOMOO_WS_KEY ?? "",
});
const started = Date.now() / 1000;
const records = await client.snapshot(codes);
const took = Date.now() / 1000 - started;
writeFileSync(process.argv[3], JSON.stringify({
  at: started,
  took,
  by_code: Object.fromEntries(records.map((r) => [r.code, r])),
}));
console.error(`typescript: ${records.length} snapshots in ${took.toFixed(2)}s`);
client.close();
process.exit(0);
