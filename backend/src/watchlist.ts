/** The watchlist entries the dashboard and the bot render (ADR 0009, phase 5).
 *
 *  Ported from monitor.py's build_entries and watchlist_quotes. Everything a client needs without
 *  re-deriving it: how long the contract has left, which holdings the rule watches, what they cost
 *  to close, and how close it is to firing. These used to be computed in routes/ui.py and reachable
 *  over no endpoint at all.
 */
import {
  COMBO_GREEK_FIELDS, comboFieldSum, isBreached, monitorLegCodes, monitorValue, thresholdFill,
} from "./domain/monitor.ts";
import { daysToExpiry } from "./domain/expiry.ts";
import {
  combinedCostToClose, combinedEntry, combinedPnl, positionLegCodes,
} from "./domain/position.ts";
import type { Monitor, MonitorLeg } from "./domain/monitor.ts";
import type { Position } from "./domain/position.ts";
import type { QuoteRecord } from "./quotes.ts";

export interface WatchlistEntry {
  id: string;
  code: string;
  strike_date: string;
  field: string;
  threshold: number;
  direction: string;
  compare: string;
  /** breaching NOW, by the figures in this same entry — not the alarm engine's stored verdict.
   *  `last_value` used to sit here too, the sweep's figure beside this fetch's; no client read it
   *  and `/monitors` is where the engine's own record belongs. See ADR 0010. */
  triggered: boolean;
  /** the contract's own figures; null for a combo, which has no single contract */
  snapshot: QuoteRecord | null;
  legs?: MonitorLeg[];
  combo_value?: number | null;
  combo_greeks?: Record<string, number | null>;
  error?: string;
  dte: number;
  scope: string | null;
  positions: { id: string; name: string }[];
  cost_to_close: number | null;
  entry: number | null;
  pnl: number | null;
  fill: number | null;
}

/** What buildEntries needs, and deliberately no more: the engine's `triggered` and `last_value`
 *  columns are NOT here, so the entry cannot be built from them. That is the fix made structural
 *  rather than written down — it was a comment before, and the comment was accurate while the code
 *  beside it was not. */
export interface MonitorForEntry extends Monitor {
  id: string;
  scope: string | null;
}

export interface EntryInputs {
  monitors: MonitorForEntry[];
  byCode: Record<string, QuoteRecord>;
  /** codes OpenD rejected as unknown */
  bad: Set<string>;
  owned: Record<string, (Position & { id: string })[]>;
  /** injectable so a test can state the date rather than wait for it */
  now?: Date;
}

/** Watchlist entries for a set of monitors against an already-fetched batch of records.
 *
 *  Combo entries carry their signed sum under `combo_value` and no per-contract snapshot: summing
 *  other fields under the combo's signs would fabricate plausible-but-wrong aggregates, and IV is
 *  never summed at all (CLAUDE.md).
 */
export function buildEntries(inputs: EntryInputs): WatchlistEntry[] {
  const { monitors, byCode, bad, owned, now } = inputs;
  return monitors.map((m) => {
    const isCombo = Boolean(m.legs && m.legs.length > 0);
    const positions = owned[m.id] ?? [];
    const snapshot = isCombo ? null : (byCode[m.code] ?? null);

    const comboValue = isCombo ? monitorValue(m, byCode) : undefined;
    const costToClose = positions.length > 0
      ? combinedCostToClose(positions, byCode, m.scope)
      : null;
    // only a rule that covers whole positions has an entry to speak of; a leg rule watches part of
    // a structure and its P&L would be a fraction of someone else's credit
    const whole = m.scope === "all" ? positions : [];

    const entry: WatchlistEntry = {
      id: m.id,
      code: m.code,
      strike_date: m.strike_date,
      field: m.field,
      threshold: m.threshold,
      direction: m.direction,
      compare: m.compare,
      // derived below, from the figure this row actually shows
      triggered: false,
      snapshot,
      dte: daysToExpiry(m.strike_date, now),
      scope: m.scope,
      positions: positions.map((p) => ({ id: p.id, name: p.name })),
      cost_to_close: costToClose,
      entry: whole.length > 0 ? combinedEntry(whole) : null,
      pnl: whole.length > 0 ? combinedPnl(whole, byCode) : null,
      fill: null,
    };

    if (isCombo) {
      entry.legs = m.legs!;
      entry.combo_value = comboValue;
      entry.combo_greeks = Object.fromEntries(
        COMBO_GREEK_FIELDS.map((f) => [f, comboFieldSum(m, byCode, f)]),
      );
    }
    if (monitorLegCodes(m).some((c) => bad.has(c))) entry.error = "unknown contract";

    // The figure this row is about, read ONCE and then used for both the fill bar and the bell.
    // They are one claim drawn twice and must not be able to disagree: the bell came from the
    // sweep's stored column while every figure beside it came from this fetch, so a row could show
    // a value past its threshold with no bell, or a bell beside a value well inside it (ADR 0010).
    //
    // A rule backed by a Position is measured on its cost to close, which cannot be negative — so
    // the comparison is always above/abs regardless of the rule's own mode, matching what the
    // dashboard has shown since the sign reconciliation.
    const measured = positions.length > 0 && isCombo
      ? { value: entry.cost_to_close, direction: "above", compare: "abs" }
      : {
        value: isCombo ? (comboValue ?? null) : ((snapshot?.[m.field] ?? null) as number | null),
        direction: m.direction,
        compare: m.compare,
      };
    entry.fill = thresholdFill(measured.value, m.threshold, measured.direction, measured.compare);
    // An unreadable figure is neither calm nor breaching, so no bell beside a dash — otherwise the
    // stored state would be back, by the other door. isBreached is the ENGINE's own predicate, so
    // the bell flips at the exact threshold and cannot drift from how the alarm is decided.
    entry.triggered = measured.value !== null
      && isBreached(measured.value, m.threshold, measured.direction, measured.compare);
    return entry;
  });
}

/** Every code a batch has to carry for these monitors and the positions they watch.
 *
 *  A Position can hold legs no Monitor names — a rule watching one wing of a condor, say. Without
 *  them the cost to close would be a partial sum, so they join the batch instead. */
export function codesFor(
  monitors: MonitorForEntry[], owned: Record<string, (Position & { id: string })[]>,
): string[] {
  const codes = new Set<string>();
  for (const m of monitors) for (const c of monitorLegCodes(m)) codes.add(c);
  for (const positions of Object.values(owned)) {
    for (const p of positions) for (const c of positionLegCodes(p)) codes.add(c);
  }
  return [...codes].sort();
}

/** Re-exported so the sweeper in phase 6 takes its breach rule from the same place the dashboard
 *  takes its fill from. */
export { isBreached };
