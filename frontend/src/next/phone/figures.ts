/** What the phone's cards say about a holding or a rule, in words and fixed places. Nothing here is
 *  computed: every figure is the service's (ADR 0005), and this only names and spells it. */
import type { Entry, Holding, Monitor } from "../../api";
import { DASH } from "../../format";

/** "Fri 18 Dec 2026": an expiry as a date to read, not a key. Read as a calendar date in UTC, so
 *  the device's zone can never move it a day. */
const EXPIRY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric",
});

export function expiryWords(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return EXPIRY.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))).replace(",", "");
}

export const points = (n: number | null | undefined) => n === null || n === undefined ? DASH : n.toFixed(2);
export const percent = (share: number | null) => share === null ? DASH : `${Math.round(share * 100)}%`;
/** Δ to three places, as a rule's sentence writes it (needs.ts: PLACES). */
export const delta = (n: number | null | undefined) => n === null || n === undefined ? DASH : n.toFixed(3);

/** `-P7150 +P7100`: a holding's legs as the watchlist writes a combo's, short as minus. */
export function holdingLegs(holding: Holding): string {
  return holding.legs
    .map((l) => `${l.side === "short" ? "-" : "+"}${l.option_type[0]}${l.strike}`)
    .join(" ");
}

/** "×2", or "×•••" under privacy: contracts × points × 100 is the dollar amount privacy hides, so
 *  the count beside a figure in points goes with it (owner's decision, #314). */
export function contractsWords(contracts: number, privacy: boolean): string {
  return privacy ? "×•••" : `×${contracts}`;
}

export interface ShortDelta {
  /** "C7300": which short leg, said only when a holding has more than one */
  leg: string;
  delta: number | null;
}

/** Each short leg's delta, read from the live quote of a single-contract rule on that very
 *  contract. `/positions/values` serves a holding's NET greeks only, so a short leg nobody watches
 *  has no delta on this page, and is a dash rather than a figure made up here. */
export function shortDeltas(holding: Holding, quotes: Entry[], monitors: Monitor[]): ShortDelta[] {
  const byId = new Map(quotes.map((q) => [q.id, q]));
  return holding.legs.filter((l) => l.side === "short").map((l) => {
    const rule = monitors.find((m) => m.legs === null && m.strike_date === holding.strike_date
      && m.option_type === l.option_type && m.strike === l.strike && byId.get(m.id)?.quote);
    const figure = rule ? byId.get(rule.id)?.quote?.option_delta : undefined;
    return { leg: `${l.option_type[0]}${l.strike}`, delta: typeof figure === "number" ? figure : null };
  });
}

export function shortDeltaWords(deltas: ShortDelta[]): string {
  if (deltas.length === 0) return DASH;
  if (deltas.length === 1) return delta(deltas[0]!.delta);
  return deltas.map((d) => `${d.leg} ${delta(d.delta)}`).join(" · ");
}

/** Why a rule that is off is off, when it is not a quarantine: somebody's choice or the calendar. */
const MUTED: Record<string, string> = {
  manual: "muted by hand",
  expired: "expired",
  "holding-closed": "its holding closed",
};

export function mutedWords(reason: string | null): string {
  return reason === null ? "muted" : MUTED[reason] ?? reason;
}
