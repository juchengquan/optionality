// Run the TypeScript domain over the same cases. Node 25 executes the .ts source directly.
import { readFileSync, writeFileSync } from "node:fs";
import { buildSpxCode } from "../../src/domain/contract.ts";
import { daysToExpiry } from "../../src/domain/expiry.ts";
import * as M from "../../src/domain/monitor.ts";
import * as P from "../../src/domain/position.ts";

const [, , inPath, outPath] = process.argv;
const { cases, clock } = JSON.parse(readFileSync(inPath, "utf8"));
const out = cases.map((c) => {
  const ps = c.positions;
  const byCode = Object.fromEntries(
    c.quotes.map((q) => [buildSpxCode(q.strike_date, q.option_type, q.strike), q.quote]),
  );
  const scope = c.scope;
  const watched = c.contract_picks.map(([pi, li]) =>
    buildSpxCode(ps[pi].strike_date, ps[pi].legs[li].option_type, ps[pi].legs[li].strike),
  );
  if (c.stranger) watched.push(buildSpxCode(ps[0].strike_date, "CALL", 9999));
  const holding = P.positionsHolding(ps, watched);
  const monitors = c.monitors.map((mon) => {
    const m = { ...mon, code: buildSpxCode(mon.strike_date, mon.option_type, mon.strike) };
    const value = M.monitorValue(m, byCode);
    const breached = value === null ? null : M.isBreached(value, m.threshold, m.direction, m.compare);
    return {
      codes: M.monitorLegCodes(m),
      value,
      field_error: M.comboFieldError(m.field),
      sums: m.legs
        ? [...M.COMBO_GREEK_FIELDS, "option_implied_volatility"].map((f) => M.comboFieldSum(m, byCode, f))
        : null,
      fill: M.thresholdFill(value, m.threshold, m.direction, m.compare),
      breached,
    };
  });
  return {
    monitors,
    watched,
    holding: [[...holding.found].sort(), holding.scope],
    codes: ps.map((p) => P.positionLegCodes(p, scope)),
    ctc: ps.map((p) => P.costToClose(p, byCode, scope)),
    greeks: ps.map((p) => P.POSITION_GREEK_FIELDS.map((f) => P.positionGreek(p, byCode, f, scope))),
    size: P.contractSize(byCode),
    pnl: ps.map((p) => P.positionPnl(p, byCode)),
    comb_ctc: P.combinedCostToClose(ps, byCode, scope),
    comb_entry: P.combinedEntry(ps),
    comb_pnl: P.combinedPnl(ps, byCode),
    comb_greek: P.POSITION_GREEK_FIELDS.map((f) => P.combinedGreek(ps, byCode, f, scope)),
  };
});
const dte = clock.instants.map((i) => clock.dates.map((d) => daysToExpiry(d, new Date(i))));

writeFileSync(outPath, JSON.stringify({ cases: out, dte }));
console.log(`typescript: ${out.length} rows`);
