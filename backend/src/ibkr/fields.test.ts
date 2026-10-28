/** What the gateway's strings mean, and what the service reads instead (ADR 0015).
 *
 *  Every number IBKR sends arrives as a string, sometimes with a letter in front of it or a
 *  suffix behind it. This is the one place in the IBKR client where a wrong reading is SILENT:
 *  `"C4.50"` parsed as NaN makes a monitor stop alarming, exactly as a missing `option_delta`
 *  does for moomoo (opend/snapshot.ts says the same thing about its own mapping).
 */
import { describe, expect, it } from "vitest";

import { SNAPSHOT_FIELDS, contractName, toRecord } from "./fields.ts";
import { parseSpxCode } from "../domain/contract.ts";

const CODE = "US.SPXW261030C8100000";
const spec = { code: CODE, conid: 712345, multiplier: 100, contract: parseSpxCode(CODE)! };

describe("reading one snapshot row", () => {
  it("names the figures the service reads, by the ids it asked for", () => {
    const record = toRecord(spec, {
      conid: 712345, "31": "4.50", "84": "4.30", "86": "4.70", "7308": "0.17",
      "7309": "0.0012", "7310": "-0.85", "7311": "1.42", "7633": "18.5",
    });
    expect(record).toMatchObject({
      code: CODE, last_price: 4.5, bid_price: 4.3, ask_price: 4.7,
      option_delta: 0.17, option_gamma: 0.0012, option_theta: -0.85, option_vega: 1.42,
      option_implied_volatility: 18.5,
    });
  });

  it("keeps the number when the gateway marks it a close rather than a trade", () => {
    // IBKR prefixes a price with C while the market is shut and H when the contract is halted.
    // The prefix is a freshness marker, not part of the figure — and `fetched_at` is this
    // service's answer about freshness anyway (CLAUDE.md).
    const record = toRecord(spec, { conid: 712345, "31": "C4.50", "84": "H4.30" });
    expect(record.last_price).toBe(4.5);
    expect(record.bid_price).toBe(4.3);
  });

  it("reads a figure the gateway has thousands-separated", () => {
    expect(toRecord(spec, { conid: 712345, "31": "1,234.50" }).last_price).toBe(1234.5);
  });

  it("reads a volume the gateway has abbreviated", () => {
    // field 87 is a DISPLAY string: the gateway sends "1.2K" where every other field sends digits
    expect(toRecord(spec, { conid: 712345, "87": "1.2K" }).volume).toBe(1200);
    expect(toRecord(spec, { conid: 712345, "87": "3M" }).volume).toBe(3_000_000);
    expect(toRecord(spec, { conid: 712345, "87": "41" }).volume).toBe(41);
  });

  it("drops a field it cannot read rather than reporting NaN", () => {
    // the domain treats an ABSENT figure as "no complete value — do not alarm", and treats NaN as
    // a number. A greek that did not arrive must read as absent.
    const record = toRecord(spec, { conid: 712345, "7308": "", "7309": "n/a", "31": "4.50" });
    expect("option_delta" in record).toBe(false);
    expect("option_gamma" in record).toBe(false);
    expect(record.last_price).toBe(4.5);
  });

  it("derives the mid only when both sides arrived", () => {
    // the same rule as moomoo's: a mid from one side is a number that looks like a price and is
    // not one. Four of the owner's monitors watch mid_price, and no provider sends it.
    expect(toRecord(spec, { conid: 712345, "84": "4.30", "86": "4.70" }).mid_price).toBe(4.5);
    expect("mid_price" in toRecord(spec, { conid: 712345, "84": "4.30" })).toBe(false);
  });

  it("carries the multiplier the snapshot does not, because the contract has it", () => {
    // every P&L figure in the service is points x contract_size. moomoo sends it per quote;
    // IBKR has it on the security definition, so the conid cache carries it here.
    expect(toRecord(spec, { conid: 712345 }).option_contract_size).toBe(100);
  });

  it("says what it knows from the code itself, rather than asking", () => {
    const record = toRecord(spec, { conid: 712345 });
    expect(record.option_type).toBe("CALL");
    expect(record.option_strike_price).toBe(8100);
    expect(record.name).toBe("SPXW 261030 8100.00C");
  });

  it("leaves update_time absent, because no snapshot field has been shown to mean it", () => {
    // moomoo's update_time is a naive US-Eastern LAST TRADE time. Nothing in the Client Portal
    // reference has been confirmed to mean that, so the column reads "—" on IBKR rather than
    // reading something else's timestamp as a trade (PR 6, question 2).
    expect("update_time" in toRecord(spec, { conid: 712345, "_updated": 1761000000000 }))
      .toBe(false);
  });

  it("reads every field it asks for, and derives exactly what it claims to", () => {
    // the requested list and the mapping cannot disagree — `fields=` is built FROM the mapping —
    // so what is pinned here is the other half: that a row full of figures becomes those figures
    // and the five things the code and the definition already knew, and nothing else.
    const asked = SNAPSHOT_FIELDS.split(",");
    const row: Record<string, unknown> = { conid: 712345 };
    for (const id of asked) row[id] = "1";
    const record = toRecord(spec, row);
    // one key per asked field, plus code, name, option_type, option_strike_price,
    // option_contract_size and the derived mid_price
    expect(Object.keys(record).length).toBe(asked.length + 6);
  });
});

describe("the name a code implies", () => {
  it("spells a contract the way the rest of the service already shows it", () => {
    // deliberately moomoo's spelling: `name` is a display label on the dashboard and in every
    // alarm message, and a row that renames itself because the deployment changed provider would
    // read as a different contract.
    expect(contractName(parseSpxCode("US.SPXW261030P8100000")!)).toBe("SPXW 261030 8100.00P");
    expect(contractName(parseSpxCode("US.SPXW270115C6950000")!)).toBe("SPXW 270115 6950.00C");
  });
});
