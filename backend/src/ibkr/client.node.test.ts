/** The client under Node itself, in a process with nothing else to do (ADR 0015).
 *
 *  One claim, and it needs its own subprocess to make: a batch must still finish when nothing
 *  else is holding the event loop open. Vitest's runner holds it open, so no in-process test can
 *  see the failure — and the live service's HTTP server holds it open too, which is why this
 *  would have waited until some future caller was the only thing running.
 *
 *  It cost a real bug to learn: the retry's `sleep` unref'd its timer, and a process whose only
 *  pending work was that sleep exited mid-batch. Node calls it "Detected unsettled top-level
 *  await" and exits 13. The same shape as `tools/check-loads.ts`, and for the same reason: some
 *  things are only true of Node running the file.
 */
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const CLIENT = new URL("./client.ts", import.meta.url).pathname;

/** The documented empty first answer, then figures — so the retry, and its wait, are exercised. */
const SCRIPT = `
import { IbkrClient } from ${JSON.stringify(CLIENT)};
let asked = 0;
const fetch = async (url) => {
  const path = String(url);
  const body = path.includes("secdef/search") ? [{ conid: 1, symbol: "SPX" }]
    : path.includes("secdef/info") ? [{ conid: 9, maturityDate: "20261030", tradingClass: "SPXW" }]
    : path.includes("snapshot") ? (asked++ === 0 ? [{ conid: 9 }] : [{ conid: 9, "84": "4.30" }])
    : {};
  return { ok: true, status: 200, json: async () => body };
};
const client = new IbkrClient({
  baseUrl: "http://gw/v1/api", fetch, tickleEverySeconds: 0, emptyRetryMs: 120,
});
const batch = await client.batch(["US.SPXW261030C8100000"]);
client.close();
console.log(JSON.stringify({ snapshots: asked, bid: batch.records[0]?.bid_price }));
`;

function run(): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", SCRIPT],
      { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => { out += String(c); });
    child.stderr.on("data", (c) => { err += String(c); });
    child.on("exit", (code) => resolve({ code, out, err }));
  });
}

describe("a batch in a process with nothing else pending", () => {
  it("waits out its own retry instead of letting the process exit", async () => {
    const { code, out, err } = await run();
    expect(err).not.toMatch(/unsettled top-level await/);
    expect(code, err).toBe(0);
    expect(JSON.parse(out.trim())).toEqual({ snapshots: 2, bid: 4.3 });
  }, 20_000);
});
