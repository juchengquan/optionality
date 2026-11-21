/** What the phone's cards say about a holding or a rule, in words and fixed places. Nothing here is
 *  computed: every figure is the service's (ADR 0005), and this only names and spells it. */
import type { Entry, Holding, Monitor } from "../shared/api";
import { DASH } from "../shared/format";
import { servedDelta } from "../legs";
import { delta } from "../shared/numbers";
import { reasonLabel } from "../shared/groups";

/** "×2", or "×•••" under privacy: contracts × points × 100 is the dollar amount privacy hides, so
 *  the count beside a figure in points goes with it (owner's decision, #314). */
export function contractsWords(contracts: number, privacy: boolean): string {
  return privacy ? "×•••" : `×${contracts}`;
}

interface ShortDelta {
  /** which short leg, `C7300`, said only when a holding has more than one */
  leg: { option_type: string; strike: number };
  delta: number | null;
}

/** Each short leg's delta: as `/positions/values` serves it (`legs_delta`, #318), or where it sent
 *  none, from the live quote of a single-contract rule on that very contract, and otherwise a dash
 *  rather than a figure made up here — the holding's net greeks are not the short leg's delta. */
export function shortDeltas(holding: Holding, quotes: Entry[], monitors: Monitor[]): ShortDelta[] {
  const byId = new Map(quotes.map((q) => [q.id, q]));
  return holding.legs.filter((l) => l.side === "short").map((l) => {
    const served = servedDelta(holding, l);
    const leg = { option_type: l.option_type, strike: l.strike };
    if (served !== null) return { leg, delta: served };
    const rule = monitors.find((m) => m.legs === null && m.strike_date === holding.strike_date
      && m.option_type === l.option_type && m.strike === l.strike && byId.get(m.id));
    const ruled = rule ? byId.get(rule.id) : undefined;
    // the quote's own delta, or — where the quote carried none — the figure a delta rule watches, as
    // the desk's table reads it (`columns.shortLegDelta`, review of #420): one source for the three
    const figure = ruled?.quote?.option_delta ?? (ruled?.field === "option_delta" ? ruled.watched : undefined);
    return { leg, delta: typeof figure === "number" ? figure : null };
  });
}

/** The short legs' deltas as the card and the sheet say them: the one figure, or each leg named
 *  `C7300 0.120 · P6300 -0.250` — the name drawn as a leg by `ShortDeltaWords` (Cards.tsx, #391). */
export function shortDeltaWords(deltas: ShortDelta[]): string | { leg: ShortDelta["leg"]; words: string }[] {
  if (deltas.length === 0) return DASH;
  if (deltas.length === 1) return delta(deltas[0]!.delta);
  return deltas.map((d) => ({ leg: d.leg, words: ` ${delta(d.delta)}` }));
}

/** Why a rule that is off is off, in the page's one set of words (`shared/groups.ts`, part I). */
export const mutedWords = (reason: string | null): string => reasonLabel(reason);
