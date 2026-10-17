/** The exit schedule: what a Position should be worth on the way out, and when to be out of it.
 *
 *  ADR 0011 has the reasoning. The short version: there is no pricing model in this codebase and
 *  no stored history to fit, and today's theta straight-lined to 21 DTE is wrong in the direction
 *  that matters — theta accelerates, so it promises decay that will not be there. What is left is
 *  a SHAPE. An option's extrinsic value scales as the square root of time, so the fraction of
 *  Entry still outstanding is √(d/D₀): no IV input, no spot input, no parameters.
 *
 *  It is a REFERENCE and never a rule. It says whether a trade is working; it raises no alarm,
 *  because being behind pace fires on every IV spike and says nothing about risk. And it is silent
 *  about spot, which is what actually kills a condor — a Position can sit exactly on pace under a
 *  short strike about to be breached. The Monitors watch that.
 */
import { normalizeStrikeDate } from "./contract.ts";

/** The policy as the settings hold it. One place reads the three knobs, so a route and the sweep
 *  cannot disagree about what the Target is. Settings is structurally typed here rather than
 *  imported, because the domain does not depend on the environment. */
export const exitPolicy = (
  s: { exitTakeFraction: number; exitStopMultiple: number; exitManageByDte: number },
): ExitPolicy => ({
  takeFraction: s.exitTakeFraction,
  stopMultiple: s.exitStopMultiple,
  manageByDte: s.exitManageByDte,
});

/** DTE on the day the Position was opened: `strike_date` less `opened_at`.
 *
 *  Two calendar dates subtracted, with no timezone anywhere — NOT `daysToExpiry` with the opened
 *  day as its clock, which reckons from the MARKET date and so reads a UTC midnight as the
 *  previous afternoon in New York and comes out a day short.
 */
export function dteAtOpen(strikeDate: string, openedAt: string): number {
  const utc = (iso: string) => Date.parse(`${normalizeStrikeDate(iso)}T00:00:00Z`);
  return Math.round((utc(strikeDate) - utc(openedAt)) / 86_400_000);
}

/** Target, Stop and the deadline, which are policy rather than per-Position facts (CLAUDE.md:
 *  behaviour knobs live in `.env`, no DB config layer). */
export interface ExitPolicy {
  /** fraction of Entry to take as profit */
  takeFraction: number;
  /** Cost to close, as a multiple of Entry, that ends the trade */
  stopMultiple: number;
  /** be dealt with at or inside this DTE whatever the P&L */
  manageByDte: number;
}

export interface ExitLevels {
  /** what Cost to close would be at this DTE if only time had passed */
  on_pace: number | null;
  /** Cost to close less on-pace, so BEHIND — costing more than it should — is positive */
  pace_gap: number | null;
  /** null for a debit structure: a fraction of Entry is the credit you keep, and there is none */
  target: number | null;
  stop: number | null;
  /** the DTE at which decay ALONE reaches the Target, which is later than people expect */
  target_dte: number | null;
  manage_by_dte: number;
  /** Which Level today's Cost to close has reached, or null for neither (CONTEXT.md: Level).
   *
   *  Decided in the service, not on screen. #129 was the dashboard measuring a figure its own way
   *  while the engine measured it another — the bell rang for ever on a row the sweep called calm —
   *  and a client-side `<=` would be a second definition of "reached" with nothing tying it to
   *  this one. The bot can read the same answer when `/holdings` needs to say it.
   *
   *  Never both: a Target is a fraction of a credit and a Stop a multiple of it, so target < stop
   *  whenever either exists at all.
   */
  reached: "target" | "stop" | null;
  /** Whether the Manage-by deadline has arrived. A deadline, not a Level: it is about time, and
   *  it arrives whatever the P&L. Inclusive, so the day itself counts. */
  manage_by_due: boolean;
}

/** What a Position's Cost to close would be at `dte` if nothing but time had passed.
 *
 *  Null rather than a guess wherever it cannot be computed, including the case that looks like
 *  arithmetic and is really bad data: a `dte` further out than the Opened one means the Opened is
 *  wrong, and a wrong Opened must read as unknown rather than as a number above Entry.
 *
 *  Signed, so it holds for a debit structure too — a long's Entry is a negative credit and its
 *  Cost to close is negative, and the same scaling carries the sign through (#92).
 */
export function onPace(
  entry: number | null, openedDte: number | null, dte: number,
): number | null {
  if (entry === null || openedDte === null) return null;
  if (openedDte <= 0 || dte < 0 || dte > openedDte) return null;
  return entry * Math.sqrt(dte / openedDte);
}

/** The whole schedule for one Position, or null if it was never declared Opened.
 *
 *  `opened_at` is the opt-in: without it there is no DTE at entry, and nothing is inferred from
 *  `created_at`, which is the day a Position was RECORDED rather than put on.
 */
export function exitLevels(
  entry: number | null,
  openedDte: number | null,
  dte: number,
  policy: ExitPolicy,
  costToClose: number | null = null,
): ExitLevels | null {
  if (openedDte === null) return null;
  const pace = onPace(entry, openedDte, dte);
  // a credit structure has something to keep a fraction of; a debit's max profit is unbounded,
  // so "take 50%" names nothing and the levels are honestly absent
  const credit = entry !== null && entry > 0;
  const target = credit ? entry * (1 - policy.takeFraction) : null;
  const stop = credit ? entry * policy.stopMultiple : null;
  // AT the level counts, both sides, matching the alarm invariant: "the bell flips truthfully at
  // the EXACT threshold — no value hysteresis". Stop is asked first; they cannot both hold, and
  // the worse news winning is the right way round for a check that cannot.
  let reached: "target" | "stop" | null = null;
  if (costToClose !== null && target !== null && stop !== null) {
    if (costToClose >= stop) reached = "stop";
    else if (costToClose <= target) reached = "target";
  }
  return {
    on_pace: pace,
    pace_gap: pace === null || costToClose === null ? null : costToClose - pace,
    target,
    stop,
    // √(d/D₀) = 1 - take  →  d = D₀(1-take)²
    target_dte: credit && openedDte > 0
      ? Math.round(openedDte * (1 - policy.takeFraction) ** 2)
      : null,
    manage_by_dte: policy.manageByDte,
    reached,
    manage_by_due: dte <= policy.manageByDte,
  };
}
