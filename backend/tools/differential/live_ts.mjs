// The TypeScript domain over the SAME quotes the Python just computed from.
import { readFileSync, writeFileSync } from "node:fs";
import * as P from "../../src/domain/position.ts";

const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { positions: ps, by_code: byCode } = d;
const figures = ps.map((r) => ({
  id: r.id,
  codes: P.positionLegCodes(r),
  ctc: P.costToClose(r, byCode),
  pnl: P.positionPnl(r, byCode),
  size: P.contractSize(byCode),
  greeks: Object.fromEntries(P.POSITION_GREEK_FIELDS.map((f) => [f, P.positionGreek(r, byCode, f)])),
  calls_ctc: P.costToClose(r, byCode, "calls"),
  puts_ctc: P.costToClose(r, byCode, "puts"),
}));
const combined = {
  ctc: P.combinedCostToClose(ps, byCode),
  entry: P.combinedEntry(ps),
  pnl: P.combinedPnl(ps, byCode),
  greeks: Object.fromEntries(P.POSITION_GREEK_FIELDS.map((f) => [f, P.combinedGreek(ps, byCode, f)])),
};
writeFileSync(process.argv[3], JSON.stringify({ figures, combined }));
