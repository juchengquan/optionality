/** A contract's conid, which is the only name IBKR answers to (ADR 0015).
 *
 *  The service's identity for a contract is the string `buildSpxCode` writes, and decision 03 of
 *  the plan kept it that way: a vendor's spelling is not an identity, and the codes key the
 *  watchlist, the samples and every test fake. So a provider that addresses contracts by number
 *  has to do the translating, and this is where it happens — `parseSpxCode` read the code (which
 *  is why that was PR 1), and two security-definition lookups turn it into an integer.
 *
 *  ## Why it caches, and what it refuses to cache
 *
 *  A conid never changes, so a resolved contract is remembered for the life of the process and
 *  rebuilt at boot — nothing goes in the schema, which would otherwise raise the question of what
 *  those rows mean after a provider switch. An UNKNOWN is never remembered: a definition that is
 *  missing while the gateway's session is half-awake is not a verdict for the life of the process.
 *
 *  The underlying's conid is fetched once for the same reason, and because the reference says a
 *  `secdef/search` must precede any derivative request — which makes the first call of a cold
 *  sweep both the translation and the pre-flight the gateway wants.
 */
import type { ContractSpec } from "./fields.ts";
import type { SecdefInfo, SecdefSearchHit } from "./types.ts";
import { parseSpxCode, type SpxContract } from "../domain/contract.ts";

/** One GET against the gateway, already decoded. `client.ts` supplies the real one; a test
 *  supplies a stub, which is how everything here is provable without an account. */
export type GatewayGet = <T>(path: string) => Promise<T>;

/** The index these options are written on. The service deals in SPX and no other underlying —
 *  `buildSpxCode` writes SPXW codes exclusively. */
const UNDERLYING = "SPX";
/** The weekly, PM-settled class every code this service creates belongs to. NOT "SPX": see
 *  types.ts, where the distinction is spelled out. */
const CLASS = "SPXW";

const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
] as const;

/** `2026-10-30` as `OCT26`, which is what the `month` parameter takes. */
function ibkrMonth(strikeDate: string): string {
  const [year, month] = strikeDate.split("-") as [string, string];
  return `${MONTHS[Number(month) - 1]}${year.slice(2)}`;
}

/** `2026-10-30` as `20261030`, which is what `maturityDate` carries. */
function maturity(strikeDate: string): string {
  return strikeDate.replace(/-/g, "");
}

function asNumber(value: number | string | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const n = Number(value.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

export class ConidCache {
  private readonly get: GatewayGet;
  /** resolved contracts, by the service's code. Never holds an unknown. */
  private readonly specs = new Map<string, ContractSpec>();
  private underlying: number | null = null;
  private searching: Promise<number> | null = null;

  constructor(get: GatewayGet) {
    this.get = get;
  }

  /** The conids for these codes, and the codes that have none.
   *
   *  `unknown` is a verdict ABOUT a contract and nothing else (#168): a gateway that cannot answer
   *  at all throws from here, because a whole watchlist reported unknown would quarantine every
   *  rule the owner has (#167) on the strength of one outage.
   */
  async resolve(codes: string[]): Promise<{ specs: ContractSpec[]; unknown: string[] }> {
    const specs: ContractSpec[] = [];
    const unknown: string[] = [];
    /** one secdef/info response per month+strike+side, for this pass: an iron condor is four
     *  strikes in one month, and the response covers every expiry in it */
    const pages = new Map<string, Promise<SecdefInfo[]>>();

    for (const code of codes) {
      const cached = this.specs.get(code);
      if (cached) {
        specs.push(cached);
        continue;
      }
      const contract = parseSpxCode(code);
      // a string buildSpxCode could not have written has no conid to look for, and asking the
      // gateway about it would spend a call to learn what the grammar already said
      if (!contract) {
        unknown.push(code);
        continue;
      }
      const spec = await this.lookup(code, contract, pages);
      if (spec) specs.push(spec);
      else unknown.push(code);
    }
    return { specs, unknown };
  }

  private async lookup(
    code: string, contract: SpxContract, pages: Map<string, Promise<SecdefInfo[]>>,
  ): Promise<ContractSpec | null> {
    const right = contract.option_type === "CALL" ? "C" : "P";
    const month = ibkrMonth(contract.strike_date);
    const key = `${month}/${contract.strike}/${right}`;
    const underlying = await this.underlyingConid();
    let pending = pages.get(key);
    if (!pending) {
      pending = this.get<SecdefInfo[]>(
        `/iserver/secdef/info?conid=${underlying}&sectype=OPT`
        + `&month=${month}&strike=${contract.strike}&right=${right}`,
      );
      pages.set(key, pending);
    }
    const page = await pending;

    const want = maturity(contract.strike_date);
    const hit = (Array.isArray(page) ? page : []).find(
      (c) => c.maturityDate === want && (c.tradingClass ?? CLASS) === CLASS,
    );
    const conid = asNumber(hit?.conid);
    if (conid === undefined) return null;
    const spec: ContractSpec = { code, conid, contract };
    const multiplier = asNumber(hit?.multiplier);
    // absent rather than 100: a guessed multiplier is every P&L figure in the service, wrong by
    // whatever the guess was off by
    if (multiplier !== undefined) spec.multiplier = multiplier;
    this.specs.set(code, spec);
    return spec;
  }

  /** SPX's own conid, once per process. A constant of the exchange, not of the request — and
   *  re-searching it every sweep would spend a call per sweep for ever against a 10 req/s budget
   *  shared with the dashboard's poll (ADR 0010). */
  private async underlyingConid(): Promise<number> {
    if (this.underlying !== null) return this.underlying;
    this.searching ??= this.search();
    try {
      this.underlying = await this.searching;
      return this.underlying;
    } finally {
      this.searching = null;
    }
  }

  private async search(): Promise<number> {
    const hits = await this.get<SecdefSearchHit[]>(
      `/iserver/secdef/search?symbol=${UNDERLYING}&name=false&secType=IND`,
    );
    const hit = (Array.isArray(hits) ? hits : []).find((h) => h.symbol === UNDERLYING);
    const conid = asNumber(hit?.conid);
    // a throw, not an empty answer: without the underlying nothing can be resolved, which is an
    // outage and must not read as a watchlist full of unknown contracts
    if (conid === undefined) throw new Error(`ibkr: no conid for underlying ${UNDERLYING}`);
    return conid;
  }
}
