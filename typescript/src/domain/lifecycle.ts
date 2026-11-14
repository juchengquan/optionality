/** What the sweep does about a rule it cannot evaluate, and about one whose expiry has passed.
 *
 *  Both were branches inside `sweeper.ts`, interleaved with the writes they caused — the same shape
 *  the alarm decision had before #185 pulled it out, and extracted here for the same reason plus
 *  one more: ADR 0017 wants every decision the sweep makes held by a golden case, and a decision
 *  tangled with `updateMonitorFields` cannot be.
 *
 *  Each is a pure function over EXPLICIT state. The sweep's silence counter lives in memory on
 *  purpose (the claim is about a RUN of sweeps, and a restart genuinely breaks the run), so it is
 *  passed in and handed back rather than read from anywhere. The sweeper keeps the IO: read the
 *  rows, call the fetcher, apply the changes, send the notices.
 *
 *  Retention is NOT a policy object here. `expiryVerdict` takes the window in days because the
 *  package takes its knobs directly, the same decision `exit.exitPolicy` and `alarm.alarmPolicy`
 *  record by being the two functions the port does not have.
 */
import { ruleShape, ruleShort, type RuleShape } from "./alarm.ts";
import { monitorLegCodes, type Monitor } from "./monitor.ts";
import type { ByCode } from "./quote.ts";

/** Why a figure did not arrive, in the words the notice uses. Sorted, so the sentence a rule
 *  produces does not depend on the order a provider happened to answer in. */
export function silenceReason(monitor: Monitor, priced: Set<string>): string {
  const unpriced = monitorLegCodes(monitor).filter((code) => !priced.has(code));
  if (unpriced.length > 0) return `no quote for ${unpriced.sort().join(", ")}`;
  return `no ${monitor.field} in the quote`;
}

/** The field a price rule reads: the mid, which a vendor derives only from a two-sided quote. */
const PRICE_FIELD = "mid_price";

/** Whether the sweep HOLDS this rule rather than count its silence (#380): it watches the price,
 *  every leg came back in the batch, and at least one came back with no two-sided quote — so no mid.
 *
 *  That is the market's answer, not a figure that failed to arrive. Out of hours moomoo quotes every
 *  option bid 0 / ask 0 and IB Gateway sends no sides at all, and a mid needs an offer above zero
 *  (`quote.ts` `midPrice`). Counted, every price rule would be quarantined about 2.5 minutes into
 *  every evening; read as 0, as it was, the 0 cleared an `above` rule and rang a `below` one, and a
 *  combo with one leg quoted at the open and the other not read as one leg's whole price and rang.
 *
 *  So a held rule is not evaluated at all: its bell, its last figure and when it was last checked
 *  stay as the last quoted sweep left them, nothing is said, and the run of silence is forgotten.
 *  At any hour, by the batch and never the clock, so a holiday and the open's first seconds are
 *  held the same way. The cost is that a price rule is no longer quarantined for silence, only for
 *  a leg the Provider does not return or does not know. Any other field missing is silence still:
 *  a greek that does not arrive is the account's entitlement speaking, and quarantine is how the
 *  owner hears about it.
 */
export function holdsWithoutQuote(monitor: Monitor, byCode: ByCode): boolean {
  if (monitor.field !== PRICE_FIELD) return false;
  const records = monitorLegCodes(monitor).map((code) => byCode[code]);
  if (records.some((r) => r === null || r === undefined)) return false;
  return records.some((r) => r![PRICE_FIELD] === null || r![PRICE_FIELD] === undefined);
}

export interface SilenceVerdict {
  /** the run's new length, or null to forget it — forgotten rather than held at the limit, so
   *  unmuting a quarantined rule gives it its full count again */
  count: number | null;
  /** true once the run has reached the limit and the rule must be disabled */
  quarantine: boolean;
  /** what to tell the owner, or null while the run is still short enough to be only logged */
  notice: string | null;
}

/** A sweep in which this rule's figure did not arrive.
 *
 *  `limit` of 0 only logs, by the invariant: quarantine is OBSERVED, never declared, and what a
 *  provider serves depends on the account rather than on its code (CLAUDE.md).
 */
/** A rule by its code AND its rule in short (#388): "1120_7100 |Δ| ≥ 0.30". A notice is read alone,
 *  and one contract may carry a delta rule and a price rule — by its code alone the two notices
 *  were one sentence, and said nothing of which rule had stopped. */
function named(monitor: Monitor): string {
  return `${monitor.code} ${ruleShort(ruleShape(monitor))}`;
}

export function silenceVerdict(
  monitor: Monitor, priced: Set<string>, sweepsSoFar: number, limit: number,
): SilenceVerdict {
  const count = sweepsSoFar + 1;
  const why = silenceReason(monitor, priced);
  if (limit > 0 && count >= limit) {
    return {
      count: null,
      quarantine: true,
      notice: `⚠️ monitor ${named(monitor)} disabled: ${why} for ${count} consecutive sweeps`,
    };
  }
  return { count, quarantine: false, notice: null };
}

/** The notice for a rule whose ROW the engine could not read at all.
 *
 *  Here rather than in `sweeper.ts` for the reason the other two verdicts are: the three faults a
 *  sweep can quarantine for are one decision wearing three hats, and two of them had their words
 *  written beside the `updateMonitorFields` they caused while the third was already cased. A
 *  notebook that asks "what would the next sweep say about this rule?" could be answered for a
 *  silent figure and not for a corrupt one.
 *
 *  A notice rather than a verdict object, because there is nothing to decide: a row that cannot be
 *  hydrated cannot be evaluated, so it is always quarantined. What varies is only the sentence.
 */
export function unreadableNotice(code: string): string {
  return `⚠️ monitor ${code} disabled: its row could not be read `
    + "(corrupt legs, or a strike date this service refuses)";
}

export interface UnknownContractVerdict {
  /** the legs this provider does not recognise, sorted — so the sentence does not depend on the
   *  order the structure was entered in, which is `silenceReason`'s rule and for its reason */
  hits: string[];
  /** true once ANY leg is unknown: a combo with one delisted leg has no value to compare */
  quarantine: boolean;
  notice: string | null;
}

/** A sweep whose batch came back naming some of this rule's contracts as ones it does not carry.
 *
 *  `silenceVerdict`'s twin, and the symmetry is the point: the same answer — disable with a notice,
 *  never delete — to the other half of "cannot evaluate". The asymmetry is in how long it takes to
 *  be sure. An unknown contract is a fact the provider stated, so one sweep is enough; a figure
 *  that has not arrived may yet arrive, which is why only that one counts sweeps.
 */
export function unknownContractVerdict(
  monitor: Monitor, unknown: Set<string>,
): UnknownContractVerdict {
  const hits = monitorLegCodes(monitor).filter((code) => unknown.has(code)).sort();
  if (hits.length === 0) return { hits, quarantine: false, notice: null };
  return {
    hits,
    quarantine: true,
    notice: `⚠️ monitor ${named(monitor)} disabled: unknown contract ${hits.join(", ")} `
      + "(delisted or never existed)",
  };
}

export type ExpiryAction = "remove" | "mute" | "keep";

export interface ExpiryVerdict {
  action: ExpiryAction;
  notice: string | null;
}

/** What becomes of a monitor whose expiry is behind it.
 *
 *  Expired monitors are muted with a notice and auto-deleted after the retention window; nothing
 *  else is ever auto-deleted (CLAUDE.md). `enabled` is here because the notices are about a CHANGE:
 *  a rule already muted says nothing when it is finally removed, except on the retention=0 path
 *  where it never got the muted notice in the first place. `rule` is the row's, short, so two rules
 *  on one expiring contract are two notices that say which is which (#388).
 */
export function expiryVerdict(
  monitor: { code: string; strike_date: string; enabled: boolean; rule: RuleShape },
  today: string, retentionDays: number,
): ExpiryVerdict {
  const cutoff = addDays(today, -retentionDays);
  const { strike_date: expiry } = monitor;
  const code = `${monitor.code} ${ruleShort(monitor.rule)}`;
  if (expiry < cutoff) {
    return {
      action: "remove",
      notice: monitor.enabled ? `ℹ️ monitor ${code} expired (${expiry}) — removed` : null,
    };
  }
  if (expiry < today) {
    if (!monitor.enabled) return { action: "keep", notice: null };
    return {
      action: "mute",
      notice: `ℹ️ monitor ${code} expired (${expiry}) — muted; auto-removes in ${retentionDays} days`,
    };
  }
  return { action: "keep", notice: null };
}

/** Days added to a market date, as text. Carried across from `sweeper.ts` unchanged: it compares
 *  market DATES rather than instants, because a monitor expires on a day and not at a moment. */
export function addDays(isoDate: string, days: number): string {
  const at = new Date(`${isoDate}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}
