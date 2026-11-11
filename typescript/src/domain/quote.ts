/** One contract's live figures, as the sweep caches them (ADR 0009).
 *
 *  Values are `unknown` rather than `string | number | null` because moomoo sends booleans too
 *  (`suspension`) and has no published schema — it is a wire format, not a type. Everything that
 *  reads a field coerces it explicitly, which is also what the Python does: `total += sign * value`
 *  on a bool gives 1 there as `Number(true)` does here.
 */
import { parseSpxCode } from "./contract.ts";
import { toFixed } from "./js.ts";
import { displayTime, marketTimeToDisplay } from "./timefmt.ts";

export type Quote = Record<string, unknown>;
export type ByCode = Record<string, Quote>;

/** What one bounded batch came back with: the quotes, and the codes the Provider does not know.
 *
 *  Here rather than in `quotes.ts` since ADR 0017, because the two pure functions below answer in
 *  terms of it and the port that produces it is not pure. The Provider reports an unknown contract
 *  this way instead of throwing: a throw is for a Provider that could not answer at all, which is
 *  an outage and must never read as a watchlist full of unknown contracts (ADR 0015).
 */
export interface Batch {
  records: Quote[];
  unknown: string[];
}

/** A points figure derived from quotes, rounded for a human.
 *
 *  4dp: a credit is quoted in points to two or three places, and rounding is only to keep float
 *  noise (7.4999999999999964) out of a figure the owner reads back or that is stored as an entry.
 */
export function round4(value: number): number {
  return Number(value.toFixed(4));
}

/** Index a batch's records by code, with display-tz timestamps stamped on.
 *
 *  Copies rather than mutates: the records are SHARED — the sweeper caches its last batch and
 *  renders it on every dashboard poll — so writing `fetched_at` into them would plant one caller's
 *  stamp in state another owns.
 *
 *  It said `marketTimeToDisplay` was not idempotent, and that was wrong: its pattern requires a
 *  NAIVE time, so a value already carrying an offset does not match and comes back whole — the
 *  strict-or-decline discipline `shortContract` and `buildSpxCode` also follow. Measured in both
 *  languages while testing the claim (ADR 0017), and now cased in timefmt. The copy stays; only
 *  its reason was false.
 *
 *  Moved in from `quotes.ts` by ADR 0017: it is pure, four service paths use it, and the Python had
 *  never had it at all. `fetched_at` is the honest "data as-of"; `update_time` is only the last
 *  trade (CLAUDE.md).
 */
export function displayRecords(
  records: Quote[], displayTz: string, fetchedAt: Date | null,
): ByCode {
  const stamped = displayTime(fetchedAt, displayTz);
  const byCode: ByCode = {};
  for (const raw of records) {
    const record = { ...raw };
    if (record.update_time) {
      record.update_time = marketTimeToDisplay(String(record.update_time), displayTz);
    }
    record.fetched_at = stamped;
    byCode[String(record.code)] = record;
  }
  return byCode;
}

/** Why a probe that THREW cannot vouch for these contracts.
 *
 *  `verifyVerdict`'s sibling, for the path where the Provider did not answer about them at all.
 *  It said "cannot verify contract: OpenD unreachable", which asserts an outage — and a Provider
 *  that answered and DECLINED throws here too: moomoo refuses every US stock index as a class,
 *  with a sentence and no culprit, so the containment loop in `opend/client.ts` re-throws it
 *  (ADR 0018). Adding `US..SPX` therefore reported a gateway failure that had not happened, and
 *  sent the owner to look at a gateway that was up.
 *
 *  So it asserts neither, and prints the Provider's own sentence — which is where the difference
 *  between "could not be reached" and "answered and declined" actually reads: a dropped socket
 *  says so in errno, and a refusal says so in words.
 */
export function unverifiableVerdict(message: string): string {
  return `cannot verify contract: the Provider did not confirm it — ${message}`;
}

/** Why these contracts cannot be trusted to exist, or null.
 *
 *  The decision half of `quotes.verifyContracts`, which is otherwise a fetch and a catch. Strict on
 *  purpose: creation is gated by a live probe and rejects while the Provider is down (CLAUDE.md),
 *  because a monitor created against a contract that does not exist would quarantine itself on the
 *  first sweep — a worse way to find out.
 *
 *  BOTH checks, though a code named unknown usually has no record either: a Provider that does both
 *  at once is contradicting itself, and a gate this strict takes the pessimistic reading.
 */
export function verifyVerdict(codes: string[], batch: Batch): string | null {
  if (batch.unknown.length > 0) {
    return `contract does not exist: ${batch.unknown.join(", ")} — check strike and expiry`;
  }
  const returned = new Set(batch.records.map((r) => r.code));
  const missing = codes.filter((c) => !returned.has(c));
  if (missing.length > 0) {
    return `contract does not exist: ${missing.join(", ")} — check strike and expiry`;
  }
  return null;
}

/** SPX's price as the batch implies it, or null and the reason there is none (#288, ADR 0024). */
export interface DerivedSpx {
  /** points, to two places; null where nothing in the batch can give it */
  price: number | null;
  /** why `price` is null, in words a dash can sit beside; null when there is a price */
  reason: string | null;
}

/** A figure from the wire, or null for anything that is not a finite number. `typeof` because
 *  moomoo has no published schema: a field can arrive as a string or a boolean. */
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** SPX's price, worked out from the option quotes a batch already holds (#288, ADR 0024).
 *
 *  moomoo serves each option's `option_premium`: how far the index has to move for the option to
 *  break even at expiry, as a percentage of the index, worked out from the option's LAST price
 *  against the index as moomoo quotes it at that moment. Inverting it with that same last gives
 *  that index level back, with p = premium / 100:
 *
 *    call  S = (K + last) / (1 + p)        put  S = (K − last) / (1 − p)
 *
 *  The batch's figure is the MEDIAN over every SPX option carrying both, rounded to two places.
 *  Measured across the 2026-11-10 session against ^GSPC: median 0.05 points, p95 0.64.
 *
 *  - **No staleness filter.** moomoo recomputes the premium against the live index whatever the
 *    last's age, so a contract that last traded thirteen hours ago inverts as well as one that
 *    traded a minute ago — the check found the same error for both. A filter would only throw away
 *    contracts.
 *  - **Never the mid.** The premium was not worked out from it: inverted with the mid the error
 *    was 2.6 points at the median and 29 at the p95.
 *  - **Never a Reference.** A Reference is a figure nothing derives from (ADR 0018); this reads
 *    only the options' own records, so there is nothing for one to fill.
 *
 *  A last of zero or less is no trade, and is left out: an option that never traded has no price
 *  for the premium to have been worked out from. A premium may be negative (a deep put trading
 *  below its intrinsic value) and is taken as it comes. An inversion that is not a positive finite
 *  number — a put whose premium is 100% — is left out rather than allowed to move the median.
 */
export function derivedSpx(records: Quote[]): DerivedSpx {
  let options = 0;
  let premiums = 0;
  const levels: number[] = [];
  for (const record of records) {
    // a code that is not a string is no code: `String([code])` would read an array as one
    const contract = typeof record.code === "string" ? parseSpxCode(record.code) : null;
    if (!contract) continue;
    options += 1;
    const premium = finite(record.option_premium);
    if (premium === null) continue;
    premiums += 1;
    const last = finite(record.last_price);
    if (last === null || last <= 0) continue;
    const p = premium / 100;
    const level = contract.option_type === "CALL"
      ? (contract.strike + last) / (1 + p)
      : (contract.strike - last) / (1 - p);
    if (Number.isFinite(level) && level > 0) levels.push(level);
  }
  if (levels.length === 0) {
    const reason = options === 0 ? "no SPX option in the batch to derive it from"
      : premiums === 0 ? "the Provider gives no option premium to derive it from"
        : "no option in the batch has both a last trade and a premium";
    return { price: null, reason };
  }
  levels.sort((a, b) => a - b);
  const mid = Math.floor(levels.length / 2);
  const median = levels.length % 2 === 1 ? levels[mid]! : (levels[mid - 1]! + levels[mid]!) / 2;
  return { price: toFixed(median, 2), reason: null };
}

/** How many standard deviations of SPX to expiry a distance in points is (#297):
 *
 *    σ = points / (SPX × IV × √(DTE / 365))
 *
 *  IV is the leg's own `option_implied_volatility`, which is a PERCENTAGE wherever it comes from —
 *  moomoo serves 18.5 for 18.5%, and IB Gateway's fraction is converted to the same at its
 *  `fields.ts` — so it is divided by 100 here. DTE is calendar days (`daysToExpiry`), over a
 *  calendar year.
 *
 *  Rounded to two places, and signed as the points are. Null where it cannot be a figure: an IV,
 *  an SPX or a DTE that is not positive — on the expiry day itself there is no time left for a σ
 *  to measure — or an answer that is not finite.
 */
export function sigmaDistance(points: number, spx: number, iv: number, dte: number): number | null {
  if (!(iv > 0) || !(spx > 0) || !(dte > 0)) return null;
  const sigma = points / (spx * (iv / 100) * Math.sqrt(dte / 365));
  return Number.isFinite(sigma) ? toFixed(sigma, 2) : null;
}

/** A short strike placed against SPX: what the strike strip draws (#297). */
export interface StrikeDistance {
  code: string;
  option_type: "CALL" | "PUT";
  strike: number;
  /** the leg's own delta from the same batch, or null where it served none */
  delta: number | null;
  /** how far SPX has still to move to reach the strike, to two places: POSITIVE while it has not
   *  (above a put's strike, below a call's) and negative by how far past. Null without an SPX. */
  points: number | null;
  /** `points` in σ to expiry (`sigmaDistance`), or null where either cannot be a figure */
  sigma: number | null;
}

/** Each of these contracts — a spread's SHORT legs — placed against SPX's price, in the order
 *  given, with its delta and IV read from the same batch (#297).
 *
 *  The price is the batch's own `derivedSpx`, passed in, never a Reference's figure (ADR 0018):
 *  where there is none, each strike is still placed and its delta still read, and only the
 *  distances are null. A code that names no SPX option has no strike to place and is left out.
 */
export function strikeDistances(
  codes: string[], byCode: ByCode, spx: number | null, dte: number,
): StrikeDistance[] {
  const out: StrikeDistance[] = [];
  for (const code of codes) {
    const contract = parseSpxCode(code);
    if (!contract) continue;
    const record = byCode[code];
    const points = spx === null ? null
      : toFixed(contract.option_type === "CALL" ? contract.strike - spx : spx - contract.strike, 2);
    const iv = finite(record?.option_implied_volatility);
    out.push({
      code,
      option_type: contract.option_type,
      strike: contract.strike,
      delta: finite(record?.option_delta),
      points,
      sigma: points === null || spx === null || iv === null ? null : sigmaDistance(points, spx, iv, dte),
    });
  }
  return out;
}
