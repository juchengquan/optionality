/** A stub Client Portal gateway, so the harness can be run before there is a real one (ADR 0015).
 *
 *      make ibkr-fake-gateway                     # in one terminal
 *      make ibkr-first-contact ARGS="--url http://127.0.0.1:5056/v1/api --no-moomoo"
 *
 *  This exists for ONE reason: `tools/ibkr-first-contact.ts` is the half of the harness that no
 *  test can drive, because it reaches a gateway. Pointing it at this proves its wiring — that it
 *  counts calls, separates cold from warm, times batches and reaches every probe — without
 *  claiming anything about IBKR. **Nothing it answers is market data.** The figures are made up,
 *  and a report from this run is a proof that the harness works, never evidence about a provider.
 *
 *  It imitates three behaviours deliberately, because they are the ones the client was written
 *  for: the first snapshot for a conid carries no figures, `secdef/info` answers for a whole month
 *  (so one call covers several expiries), and plain HTTP — a real gateway's self-signed TLS is a
 *  configuration problem, not a behaviour to imitate.
 */
import { createServer } from "node:http";

import { parseSpxCode } from "../src/domain/contract.ts";

const port = Number(process.argv[2] ?? 5056);
/** which conids have been asked for before: the first ask returns nothing, as documented */
const primed = new Set<number>();
/** `US.SPXW261030C8100000` → a stable made-up conid */
const conids = new Map<string, number>();
let next = 700_000;

function conidFor(month: string, strike: number, right: string, maturity: string): number {
  const key = `${month}/${strike}/${right}/${maturity}`;
  if (!conids.has(key)) conids.set(key, (next += 7));
  return conids.get(key)!;
}

/** Every expiry in a month at one strike and side, which is what the real endpoint answers with.
 *
 *  Every WEEKDAY of the month, because SPXW expires daily — which is also what makes one
 *  `secdef/info` call cover several of the owner's contracts, the property the client's per-month
 *  caching is built on. The first version of this listed two dates a month and reported every real
 *  contract unknown; the harness said so, which is the harness working.
 */
function monthOfContracts(month: string, strike: number, right: string) {
  const [mmm, yy] = [month.slice(0, 3), month.slice(3)];
  const index = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
    .indexOf(mmm.toUpperCase());
  if (index < 0 || !/^\d\d$/.test(yy)) return [];
  const year = 2000 + Number(yy);
  const mm = String(index + 1).padStart(2, "0");
  const last = new Date(Date.UTC(year, index + 1, 0)).getUTCDate();
  const out = [];
  for (let day = 1; day <= last; day += 1) {
    const weekday = new Date(Date.UTC(year, index, day)).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const maturity = `${year}${mm}${String(day).padStart(2, "0")}`;
    out.push({
      conid: conidFor(month, strike, right, maturity), symbol: "SPX", maturityDate: maturity,
      right, strike, multiplier: "100", tradingClass: "SPXW",
    });
  }
  return out;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const path = url.pathname.replace("/v1/api", "");
  const q = url.searchParams;
  const send = (body: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  console.log(`${req.method} ${path}${url.search}`);

  if (path === "/iserver/auth/status") return send({ authenticated: true, connected: true, competing: false });
  if (path === "/iserver/accounts") return send({ accounts: ["DU0000000"] });
  if (path === "/tickle") return send({ session: "fake", iserver: { authStatus: { authenticated: true } } });
  if (path === "/iserver/secdef/search") return send([{ conid: 416904, symbol: "SPX", secType: "IND" }]);
  if (path === "/iserver/secdef/info") {
    return send(monthOfContracts(q.get("month") ?? "", Number(q.get("strike")), q.get("right") ?? "C"));
  }
  if (path === "/iserver/marketdata/snapshot") {
    const asked = (q.get("conids") ?? "").split(",").map(Number).filter(Boolean);
    return send(asked.map((conid) => {
      // the documented empty first answer, which is what the client's retry is for
      if (!primed.has(conid)) {
        primed.add(conid);
        return { conid };
      }
      const bid = 4 + (conid % 11) / 10;
      return {
        conid, "31": `${(bid + 0.1).toFixed(2)}`, "84": `C${bid.toFixed(2)}`,
        "86": `${(bid + 0.4).toFixed(2)}`, "87": "1.2K",
        "7308": `0.1${conid % 7}`, "7309": "0.0012", "7310": "-0.85", "7311": "1.42",
        "7633": "18.5",
      };
    }));
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: `fake gateway has no ${path}` }));
});

// a convenience, so that a code can be asked about without a watchlist: --codes passes through
void parseSpxCode;

server.listen(port, "127.0.0.1", () => {
  console.log(`fake IBKR gateway on http://127.0.0.1:${port}/v1/api — answers NO real market data`);
});
