/** The Client Portal gateway's JSON, as the few endpoints this service calls return it (ADR 0015).
 *
 *  Hand-written and partial, for the same reason `opend/types.ts` is: these cover what the client
 *  reads and nothing else. A wrong guess in a field nobody looks at is worse than its absence,
 *  and NONE of this has been seen from a real gateway yet — it is written from the Web API
 *  reference, and PR 6 is where it meets one (CLAUDE.md has no fake-gateway escape hatch for that).
 *
 *  Everything is optional. The gateway answers a snapshot for a conid it has no data for with a
 *  row carrying the conid and nothing else, which is not an error and must not read as one.
 */

/** `GET /iserver/auth/status` — whether the browser session behind the gateway is still alive. */
export interface AuthStatus {
  authenticated?: boolean;
  connected?: boolean;
  competing?: boolean;
}

/** One hit from `GET /iserver/secdef/search`. The service searches for the UNDERLYING (SPX) and
 *  wants only its conid; the sections say which months have options, which it does not consult —
 *  a month that is absent produces an empty `secdef/info`, which is the same answer one step later
 *  and one fewer thing to get wrong. */
export interface SecdefSearchHit {
  conid?: number | string;
  symbol?: string;
  companyName?: string;
  secType?: string;
  sections?: { secType?: string; months?: string }[];
}

/** One contract from `GET /iserver/secdef/info`, which is where a conid for an OPTION comes from.
 *
 *  `tradingClass` is load-bearing, not description: on the third Friday of a month SPX and SPXW
 *  both have a contract at the same strike and the same date, settling at different times of day
 *  on different prints. The service's codes are SPXW — `buildSpxCode` writes no others — so a
 *  conid from the wrong class would be a different instrument answering to the right name.
 */
export interface SecdefInfo {
  conid?: number | string;
  symbol?: string;
  /** "20261030" */
  maturityDate?: string;
  /** "C" | "P" */
  right?: string;
  strike?: number | string;
  /** "100", the points-to-money multiplier — moomoo sends this per QUOTE, IBKR per CONTRACT */
  multiplier?: number | string;
  tradingClass?: string;
}

/** One row of `GET /iserver/marketdata/snapshot`: the conid, and the requested fields by their
 *  numeric ids as STRING keys with STRING values. `6509` and the underscore keys are the gateway's
 *  own bookkeeping and are ignored. */
export interface SnapshotRow {
  conid?: number | string;
  [field: string]: unknown;
}
