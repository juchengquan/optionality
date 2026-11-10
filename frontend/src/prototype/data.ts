/** PROTOTYPE — throwaway. Branch `prototype/ui-revamp`, never merged to main.
 *
 *  Question: what should the redesigned dashboard look like? Three structurally different
 *  variants render THIS book, switchable with `?variant=A|B|C` (see main.tsx).
 *
 *  The book is normalised for the variants so none of them re-derives anything:
 *  - the WATCHLIST is the owner's real one, captured read-only from the live API on 2026-11-10
 *    (fixtures/*.json). Its alerts are ENTRY signals on candidate spreads, not risk.
 *  - the HOLDINGS are SYNTHETIC (the live book holds none): a 12-18 condor recorded as two
 *    spreads, a 12-31 put spread, and one closed 12-04 trade, with invented daily samples, so
 *    Review mode has something to show. Every synthetic object carries `synthetic: true`.
 *  Static on purpose: each live poll is a provider batch (ADR 0010), and a snapshot works
 *  off-hours on a phone.
 */
import healthJson from "./fixtures/health.json";
import quotesJson from "./fixtures/quotes.json";
import referencesJson from "./fixtures/references.json";

export type Side = "call" | "put";
/** entry = a candidate became worth selling (good news); risk = a holding needs attention. */
export type AlertKind = "entry" | "risk";
export type AlertState = "armed" | "near" | "fired" | "quarantined" | "muted";

export interface Alert {
  id: string;
  kind: AlertKind;
  /** what is watched, in words: "spread value", "short Δ", "cost to close" */
  field: string;
  direction: "above" | "below";
  threshold: number;
  current: number | null;
  /** 0..100, how far the current value has travelled toward the threshold (the service's fill) */
  fill: number;
  state: AlertState;
  /** plain-language sentence, e.g. "spread value ≥ 6.01 — now 2.00, 4.01 away" */
  sentence: string;
  /** why a quarantined/muted alert is off */
  reason?: string;
  synthetic?: boolean;
}

export interface SpreadBase {
  id: string;
  name: string;
  expiry: string; // YYYY-MM-DD
  dte: number;
  side: Side;
  short: number;
  /** null for a single short leg watched without its wing */
  long: number | null;
  width: number | null;
  /** cost to close one spread, positive points (what you would pay to buy it back) */
  value: number | null;
  shortDelta: number | null;
  /** short leg IV, percent */
  shortIv: number | null;
  /** position greeks per one spread, signed as held short */
  theta: number | null;
  vega: number | null;
}

export interface Candidate extends SpreadBase {
  kind: "candidate";
  alerts: Alert[];
  synthetic?: boolean;
}

export interface Sample {
  date: string; // New York market date
  dte: number;
  cost: number; // cost to close, points
  spot: number;
  shortIv: number;
  shortDelta: number;
  /** false when the row is not the 16:15 close (an evening fill, a missed session) */
  atClose: boolean;
}

export interface Holding extends SpreadBase {
  kind: "holding";
  contracts: number;
  entry: number; // credit received per spread, points
  opened: string;
  /** (entry - value) in points per spread, and in dollars for the whole holding */
  pnlPoints: number;
  pnlDollars: number;
  /** share of the maximum profit (the entry credit) already captured, 0..1 */
  captured: number;
  target: number; // cost to close at which to take profit
  stop: number; // cost to close at which to stop out
  manageBy: string; // date
  manageByDte: number;
  /** cost to close the exit schedule planned for today */
  plannedToday: number;
  pace: "ahead" | "on pace" | "behind";
  alerts: Alert[];
  samples: Sample[];
  /** id of the other spread when two holdings form a condor on one expiry */
  pairedWith?: string;
  synthetic: true;
}

export interface Closed {
  id: string;
  name: string;
  side: Side;
  short: number;
  long: number;
  expiry: string;
  contracts: number;
  entry: number;
  exit: number;
  opened: string;
  closedOn: string;
  realizedPoints: number;
  realizedDollars: number;
  samples: Sample[];
  synthetic: true;
}

export interface Need {
  kind: "risk" | "entry" | "fault" | "target" | "manage";
  text: string;
  refId: string;
}

export interface Reference {
  label: string;
  source: string;
  figure: number | null;
  change: number | null;
  error: string | null;
}

export interface Book {
  asOf: string; // display time
  displayTz: string;
  spot: number;
  spotChange: number;
  provider: { name: string; ok: boolean };
  sweepSeconds: number;
  references: Reference[];
  candidates: Candidate[];
  holdings: Holding[];
  closed: Closed[];
  needs: Need[];
}

// ---------------------------------------------------------------------------------------------
// the real watchlist

type QuoteEntry = (typeof quotesJson)[number];
const MULT = 100;

const round = (x: number, p = 2) => Math.round(x * 10 ** p) / 10 ** p;
const sideOf = (t: string): Side => (t.toUpperCase().startsWith("C") ? "call" : "put");

function alertState(triggered: boolean, fill: number): AlertState {
  if (triggered) return "fired";
  return fill >= 80 ? "near" : "armed";
}

function sentence(field: string, dir: "above" | "below", threshold: number, current: number | null) {
  const op = dir === "above" ? "≥" : "≤";
  if (current === null) return `${field} ${op} ${threshold} — no figure yet`;
  const away = round(Math.abs(threshold - current), field.includes("Δ") ? 3 : 2);
  return `${field} ${op} ${threshold} — now ${current}, ${away} away`;
}

function buildCandidates(): Candidate[] {
  const entries = quotesJson as QuoteEntry[];
  const singles = entries.filter((e) => !e.legs);
  const combos = entries.filter((e) => e.legs);
  const used = new Set<string>();
  const out: Candidate[] = [];

  for (const c of combos) {
    const legs = c.legs!;
    const shortLeg = legs.find((l) => l.sign === -1)!;
    const longLeg = legs.find((l) => l.sign === 1)!;
    const side = sideOf(shortLeg.option_type);
    // the single-leg delta rule on this spread's short leg, if the owner set one
    const deltaRule = singles.find((s) => s.strike_date === c.strike_date
      && sideOf(s.option_type) === side && s.code.endsWith(`${String(shortLeg.strike * 1000)}`));
    if (deltaRule) used.add(deltaRule.id);
    const q = (deltaRule?.quote ?? null) as unknown as Record<string, number> | null;
    const value = c.combo_value == null ? null : round(Math.abs(c.combo_value));
    const alerts: Alert[] = [{
      id: c.id, kind: "entry", field: "spread value", direction: c.direction as "above",
      threshold: c.threshold, current: value, fill: c.fill ?? 0,
      state: alertState(c.triggered, c.fill ?? 0),
      sentence: sentence("spread value", c.direction as "above", c.threshold, value),
    }];
    if (deltaRule) {
      const d = q?.option_delta === undefined ? null : round(Math.abs(q.option_delta), 3);
      alerts.push({
        id: deltaRule.id, kind: "entry", field: "short Δ", direction: deltaRule.direction as "above",
        threshold: deltaRule.threshold, current: d, fill: deltaRule.fill ?? 0,
        state: alertState(deltaRule.triggered, deltaRule.fill ?? 0),
        sentence: sentence("short Δ", deltaRule.direction as "above", deltaRule.threshold, d),
      });
    }
    const g = c.combo_greeks as unknown as Record<string, number> | null;
    out.push({
      kind: "candidate", id: c.id, name: c.code, expiry: c.strike_date, dte: c.dte ?? 0, side,
      short: shortLeg.strike, long: longLeg.strike, width: Math.abs(longLeg.strike - shortLeg.strike),
      value, shortDelta: alerts[1]?.current ?? null,
      shortIv: q?.option_implied_volatility ?? null,
      theta: g ? round(-(g.option_theta ?? 0), 3) : null, vega: g ? round(-(g.option_vega ?? 0), 3) : null,
      alerts,
    });
  }
  // delta rules on a short leg with no spread watched beside it
  for (const s of singles) {
    if (used.has(s.id)) continue;
    const q = s.quote as unknown as Record<string, number> | null;
    const strike = Number(/[CP](\d+)$/.exec(s.code)?.[1] ?? NaN) / 1000;
    const d = q?.option_delta === undefined ? null : round(Math.abs(q.option_delta), 3);
    out.push({
      kind: "candidate", id: s.id, name: s.code.replace("US.SPXW", "SPXW "), expiry: s.strike_date,
      dte: s.dte ?? 0, side: sideOf(s.option_type), short: strike, long: null, width: null,
      value: q?.mid_price ?? null, shortDelta: d, shortIv: q?.option_implied_volatility ?? null,
      theta: q ? round(-(q.option_theta ?? 0), 3) : null, vega: q ? round(-(q.option_vega ?? 0), 3) : null,
      alerts: [{
        id: s.id, kind: "entry", field: "short Δ", direction: s.direction as "above",
        threshold: s.threshold, current: d, fill: s.fill ?? 0,
        state: alertState(s.triggered, s.fill ?? 0),
        sentence: sentence("short Δ", s.direction as "above", s.threshold, d),
      }],
    });
  }
  // SYNTHETIC: a quarantined rule, so every variant has to show that state
  out.push({
    kind: "candidate", id: "syn-quarantine", name: "1211_8300", expiry: "2026-12-11", dte: 32,
    side: "call", short: 8300, long: 8350, width: 50, value: null, shortDelta: null, shortIv: null,
    theta: null, vega: null, synthetic: true,
    alerts: [{
      id: "syn-quarantine-a", kind: "entry", field: "spread value", direction: "above",
      threshold: 4.01, current: null, fill: 0, state: "quarantined", synthetic: true,
      reason: "no delta has arrived for 20 sweeps — switched off, not deleted",
      sentence: "spread value ≥ 4.01 — switched off: a figure never arrived",
    }],
  });
  return out.sort((a, b) => a.expiry.localeCompare(b.expiry) || a.short - b.short);
}

// ---------------------------------------------------------------------------------------------
// SYNTHETIC holdings: invented, deterministic, plausible for SPX at ~7550 on 2026-11-09

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T12:00:00Z`); d <= new Date(`${to}T12:00:00Z`);
    d = new Date(d.getTime() + 86400000)) out.push(d.toISOString().slice(0, 10));
  return out;
}
const dteOf = (date: string, expiry: string) =>
  Math.round((Date.parse(`${expiry}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86400000);

/** spot path: ~7300 at the end of October, rallying to the snapshot's 7549.94 */
function spotOn(date: string): number {
  const all = days("2026-10-20", "2026-11-09");
  const i = all.indexOf(date);
  const t = i < 0 ? 1 : i / (all.length - 1);
  return round(7290 + 259.94 * t ** 1.6 + (i < all.length - 1 ? (rand() - 0.5) * 30 : 0));
}

interface Spec {
  id: string; name: string; expiry: string; side: Side; short: number; long: number;
  contracts: number; entry: number; opened: string; costNow: number; deltaNow: number; ivNow: number;
  pairedWith?: string;
}

function samplesFor(s: Spec, until: string): Sample[] {
  const ds = days(s.opened, until);
  return ds.map((date, i) => {
    const t = i / Math.max(1, ds.length - 1);
    const cost = round(s.entry + (s.costNow - s.entry) * t + (i && i < ds.length - 1 ? (rand() - 0.5) * 0.25 : 0));
    return {
      date, dte: dteOf(date, s.expiry), cost: Math.max(0.05, cost), spot: spotOn(date),
      shortIv: round(15.5 + (s.ivNow - 15.5) * t + (rand() - 0.5) * 0.6, 2),
      shortDelta: round(0.16 + (s.deltaNow - 0.16) * t + (rand() - 0.5) * 0.01, 3),
      // one evening fill, so variants have to show a point that is not the close
      atClose: !(i === 3),
    };
  });
}

function holding(s: Spec): Holding {
  const samples = samplesFor(s, "2026-11-09");
  const dte = dteOf("2026-11-09", s.expiry);
  const dteAtOpen = dteOf(s.opened, s.expiry);
  const manageByDte = 21;
  const target = round(s.entry * 0.5);
  const stop = round(s.entry * 2);
  const span = Math.max(1, dteAtOpen - manageByDte);
  const left = Math.max(0, dte - manageByDte);
  // the decay shape of ADR 0011, roughly: from entry to target by manage-by, along √(time left)
  const plannedToday = round(target + (s.entry - target) * Math.sqrt(left / span));
  const pnlPoints = round(s.entry - s.costNow);
  const pace = s.costNow <= plannedToday - 0.1 ? "ahead" : s.costNow >= plannedToday + 0.1 ? "behind" : "on pace";
  const stopFill = Math.min(100, Math.max(0, Math.round(((s.costNow - s.entry) / (stop - s.entry)) * 100)));
  const deltaFill = Math.min(100, Math.round((s.deltaNow / 0.3) * 100));
  return {
    kind: "holding", id: s.id, name: s.name, expiry: s.expiry, dte, side: s.side, short: s.short,
    long: s.long, width: Math.abs(s.long - s.short), value: s.costNow, shortDelta: s.deltaNow,
    shortIv: s.ivNow, theta: round(0.011 * (s.entry + s.costNow), 3), vega: round(-0.09 * s.costNow, 3),
    contracts: s.contracts, entry: s.entry, opened: s.opened, pnlPoints,
    pnlDollars: round(pnlPoints * MULT * s.contracts, 0), captured: round(pnlPoints / s.entry, 3),
    target, stop, manageBy: days("2026-11-09", s.expiry)[Math.max(0, dte - manageByDte)] ?? s.expiry,
    manageByDte, plannedToday, pace, samples, pairedWith: s.pairedWith, synthetic: true,
    alerts: [
      {
        id: `${s.id}-stop`, kind: "risk", field: "cost to close", direction: "above", threshold: stop,
        current: s.costNow, fill: stopFill, state: alertState(s.costNow >= stop, stopFill),
        sentence: sentence("cost to close", "above", stop, s.costNow), synthetic: true,
      },
      {
        id: `${s.id}-delta`, kind: "risk", field: "short Δ", direction: "above", threshold: 0.3,
        current: s.deltaNow, fill: deltaFill, state: alertState(s.deltaNow >= 0.3, deltaFill),
        sentence: sentence("short Δ", "above", 0.3, s.deltaNow), synthetic: true,
      },
    ],
  };
}

const SPECS: Spec[] = [
  // the 12-18 condor, recorded as two spreads: the rally has run into the call side
  { id: "syn-h1", name: "1218_7700C", expiry: "2026-12-18", side: "call", short: 7700, long: 7750,
    contracts: 2, entry: 1.1, opened: "2026-10-27", costNow: 1.95, deltaNow: 0.31, ivNow: 12.4,
    pairedWith: "syn-h2" },
  { id: "syn-h2", name: "1218_7150P", expiry: "2026-12-18", side: "put", short: 7150, long: 7100,
    contracts: 2, entry: 1.6, opened: "2026-10-27", costNow: 0.45, deltaNow: 0.06, ivNow: 17.9,
    pairedWith: "syn-h1" },
  // a lone put spread, on pace
  { id: "syn-h3", name: "1231_7000P", expiry: "2026-12-31", side: "put", short: 7000, long: 6950,
    contracts: 3, entry: 1.3, opened: "2026-11-03", costNow: 0.95, deltaNow: 0.07, ivNow: 18.6 },
];

const CLOSED: Closed[] = [(() => {
  const spec: Spec = { id: "syn-c1", name: "1204_6900P", expiry: "2026-12-04", side: "put",
    short: 6900, long: 6850, contracts: 2, entry: 1.45, opened: "2026-10-20", costNow: 0.7,
    deltaNow: 0.05, ivNow: 19.2 };
  const samples = samplesFor(spec, "2026-11-05");
  return {
    id: spec.id, name: spec.name, side: spec.side, short: spec.short, long: spec.long,
    expiry: spec.expiry, contracts: spec.contracts, entry: spec.entry, exit: 0.7,
    opened: spec.opened, closedOn: "2026-11-05", realizedPoints: 0.75,
    realizedDollars: 0.75 * MULT * spec.contracts, samples, synthetic: true as const,
  };
})()];

// ---------------------------------------------------------------------------------------------

function needsOf(candidates: Candidate[], holdings: Holding[]): Need[] {
  const out: Need[] = [];
  for (const h of holdings) {
    for (const a of h.alerts) if (a.state === "fired") out.push({ kind: "risk", text: `${h.name} ${a.field} ${a.current} ≥ ${a.threshold}`, refId: h.id });
    if (h.value !== null && h.value <= h.target) out.push({ kind: "target", text: `${h.name} at target`, refId: h.id });
    if (h.dte <= h.manageByDte) out.push({ kind: "manage", text: `${h.name} at its manage-by`, refId: h.id });
  }
  for (const c of candidates) {
    for (const a of c.alerts) {
      if (a.state === "fired") out.push({ kind: "entry", text: `${c.name} ${a.field} ${a.current} ≥ ${a.threshold}`, refId: c.id });
      if (a.state === "quarantined") out.push({ kind: "fault", text: `${c.name} switched off — ${a.reason}`, refId: c.id });
    }
  }
  const order = ["fault", "risk", "manage", "entry", "target"];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

const spx = referencesJson.find((r) => r.source === "yahoo")!;
const candidates = buildCandidates();
const holdings = SPECS.map(holding);

export const BOOK: Book = {
  asOf: healthJson.monitor.fetched_at,
  displayTz: healthJson.settings.display_tz,
  spot: spx.figure!,
  spotChange: spx.change!,
  provider: healthJson.provider,
  sweepSeconds: healthJson.settings.sweep_seconds,
  references: [
    ...referencesJson.map((r) => ({ label: r.label ?? r.code, source: r.source, figure: r.figure, change: r.change, error: r.error })),
    // SYNTHETIC: VIX is not among the owner's References today
    { label: "VIX", source: "yahoo", figure: 15.82, change: -0.061, error: null },
  ],
  candidates,
  holdings,
  closed: CLOSED,
  needs: needsOf(candidates, holdings),
};

/** Viewer preferences every variant must honour (the real app keeps these in cookies). */
export interface Prefs {
  /** green-up (default) or red-up; P&L follows it, attention colours never flip */
  upColor: "green" | "red";
  /** fired entry alerts in their own "opportunity" style (default) or the same as risk alarms */
  entryStyle: "distinct" | "same";
  /** hide $ amounts, keep %, Δ and DTE */
  privacy: boolean;
}
export const DEFAULT_PREFS: Prefs = { upColor: "green", entryStyle: "distinct", privacy: false };
