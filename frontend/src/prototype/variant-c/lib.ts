/** PROTOTYPE — throwaway. Variant C's arithmetic and formatting: nothing here is canonical,
 *  and everything here would move to the service (ADR 0005: the browser computes nothing)
 *  if this direction won. */
import type { Alert, Book, Candidate, Closed, Holding, Side } from "../data";

export type Spread = Holding | Candidate;
export const MULT = 100;
const MINUS = "−";

// ---- numbers -----------------------------------------------------------------------------------

export const fmtPx = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtStrike = (n: number) => String(Math.round(n));
export const fmtPts = (n: number | null, d = 2) => (n === null ? "—" : n.toFixed(d));
export const fmtSigned = (n: number, d = 2) =>
  `${n > 0 ? "+" : n < 0 ? MINUS : ""}${Math.abs(n).toFixed(d)}`;
export const fmtDelta = (n: number | null) => (n === null ? "—" : n.toFixed(3));
/** the map's label: "Δ.31" — two places is all a glance needs; the drawer shows three */
export const fmtDeltaShort = (n: number | null) =>
  n === null ? "Δ—" : `Δ${n.toFixed(2).replace(/^0/, "")}`;
export const fmtPct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
export const fmtSignedPct = (x: number, d = 2) => `${x > 0 ? "+" : x < 0 ? MINUS : ""}${Math.abs(x * 100).toFixed(d)}%`;
export function fmtUsd(n: number, privacy: boolean, signed = true) {
  if (privacy) return "$•••";
  const s = `$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
  return signed ? `${n > 0 ? "+" : n < 0 ? MINUS : ""}${s}` : s;
}

// ---- dates -------------------------------------------------------------------------------------

export const dayIndex = (iso: string) => Math.round(Date.parse(`${iso}T12:00:00Z`) / 86400000);
export const isoOfDay = (i: number) => new Date(i * 86400000 + 43200000).toISOString().slice(0, 10);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDate(iso: string) {
  const [, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

/** The book's own market day: the New York date of its as-of instant. */
export function marketToday(book: Book): string {
  const at = new Date(book.asOf.replace(" ", "T"));
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(at);
}

/** "12:27:20 SGT" from the book's as-of stamp, in the display zone */
export function fmtAsOf(book: Book) {
  const at = new Date(book.asOf.replace(" ", "T"));
  const t = new Intl.DateTimeFormat("en-GB", {
    timeZone: book.displayTz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(at);
  return `${t} ${book.displayTz === "Asia/Singapore" ? "SGT" : book.displayTz}`;
}

// ---- spreads -----------------------------------------------------------------------------------

export function lo(s: { short: number; long: number | null }) {
  return s.long === null ? s.short : Math.min(s.short, s.long);
}
export function hi(s: { short: number; long: number | null }) {
  return s.long === null ? s.short : Math.max(s.short, s.long);
}

/** P&L at expiry of ONE spread sold for `credit`, at SPX = x, in points */
export function pnlAtExpiry(side: Side, short: number, width: number, credit: number, x: number) {
  const intrinsic = side === "call" ? x - short : short - x;
  return credit - Math.min(Math.max(intrinsic, 0), width);
}

export interface PayoffLeg { side: Side; short: number; width: number; credit: number; contracts: number }

/** dollars at expiry for a set of short spreads (a condor is two) */
export function payoff(legs: PayoffLeg[], x: number) {
  return legs.reduce((sum, l) => sum + pnlAtExpiry(l.side, l.short, l.width, l.credit, x) * MULT * l.contracts, 0);
}
export const breakeven = (l: PayoffLeg) => (l.side === "call" ? l.short + l.credit : l.short - l.credit);

/** ±1σ to expiry, in index points: spot × IV × √(dte/365). Approximate on purpose — one IV for a lane. */
export const sigma = (spot: number, ivPct: number, dte: number) => spot * (ivPct / 100) * Math.sqrt(Math.max(dte, 0.5) / 365);

/** distance from spot to a short strike, in the direction that hurts: positive = still out of the money */
export function cushion(side: Side, short: number, spot: number) {
  return side === "call" ? short - spot : spot - short;
}

/** the exit schedule's planned cost to close on day `iso` (ADR 0011's √-shape, approximated) */
export function planned(h: Holding, iso: string) {
  const dteAt = (d: string) => Math.max(0, dayIndex(h.expiry) - dayIndex(d));
  const span = Math.max(1, dteAt(h.opened) - h.manageByDte);
  const left = Math.max(0, dteAt(iso) - h.manageByDte);
  return h.target + (h.entry - h.target) * Math.sqrt(left / span);
}

// ---- alerts ------------------------------------------------------------------------------------

export type Tone = "neutral" | "near" | "opportunity" | "alarm" | "fault" | "muted";

/** The attention family. Never flips with the up/down setting. */
export function toneOf(a: Alert, entryStyle: "distinct" | "same"): Tone {
  if (a.state === "quarantined") return "fault";
  if (a.state === "muted") return "muted";
  if (a.state === "fired") return a.kind === "entry" && entryStyle === "distinct" ? "opportunity" : "alarm";
  if (a.state === "near") return "near";
  return "neutral";
}

const RANK: Record<Tone, number> = { fault: 5, alarm: 4, opportunity: 3, near: 2, muted: 1, neutral: 0 };
export function worstTone(alerts: Alert[], entryStyle: "distinct" | "same"): Tone {
  return alerts.map((a) => toneOf(a, entryStyle)).reduce<Tone>((w, t) => (RANK[t] > RANK[w] ? t : w), "neutral");
}

export function plainSentence(a: Alert) {
  const op = a.direction === "above" ? "≥" : "≤";
  const isDelta = a.field.includes("Δ");
  const f = (n: number) => (isDelta ? n.toFixed(3) : n.toFixed(2));
  const what = a.kind === "entry" ? "Tell me when" : "Warn me when";
  if (a.state === "quarantined") return `${what} ${a.field} ${op} ${f(a.threshold)} — off: ${a.reason ?? "unreadable"}`;
  if (a.current === null) return `${what} ${a.field} ${op} ${f(a.threshold)} — no figure yet`;
  const away = Math.abs(a.threshold - a.current);
  const crossed = a.direction === "above" ? a.current >= a.threshold : a.current <= a.threshold;
  return crossed
    ? `${what} ${a.field} ${op} ${f(a.threshold)} — now ${f(a.current)}, crossed`
    : `${what} ${a.field} ${op} ${f(a.threshold)} — now ${f(a.current)}, ${f(away)} away`;
}

/** re-derive an alert after the owner edits it in place (local state only) */
export function edited(a: Alert, threshold: number, direction: "above" | "below"): Alert {
  if (a.state === "quarantined" || a.current === null) return { ...a, threshold, direction };
  const crossed = direction === "above" ? a.current >= threshold : a.current <= threshold;
  const fill = Math.max(0, Math.min(100, Math.round((a.current / threshold) * 100)));
  const state = crossed ? "fired" : fill >= 80 ? "near" : "armed";
  return { ...a, threshold, direction, fill: crossed ? 100 : fill, state };
}

// ---- lanes -------------------------------------------------------------------------------------

export interface Lane {
  expiry: string;
  dte: number;
  holdings: Holding[];
  candidates: Candidate[];
  /** the IV used for this lane's ±1σ band: the nearest-to-spot short leg that has one */
  iv: number | null;
}

export function lanesOf(book: Book, holdings: Holding[], candidates: Candidate[]): Lane[] {
  const byExpiry = new Map<string, Lane>();
  const lane = (expiry: string, dte: number) => {
    let l = byExpiry.get(expiry);
    if (!l) { l = { expiry, dte, holdings: [], candidates: [], iv: null }; byExpiry.set(expiry, l); }
    return l;
  };
  for (const h of holdings) lane(h.expiry, h.dte).holdings.push(h);
  for (const c of candidates) lane(c.expiry, c.dte).candidates.push(c);
  for (const l of byExpiry.values()) {
    const withIv = [...l.holdings, ...l.candidates].filter((s) => s.shortIv !== null);
    withIv.sort((a, b) => Math.abs(a.short - book.spot) - Math.abs(b.short - book.spot));
    l.iv = withIv[0]?.shortIv ?? null;
  }
  return [...byExpiry.values()].sort((a, b) => a.dte - b.dte);
}

export function priceDomain(book: Book, lanes: Lane[]): [number, number] {
  let min = book.spot, max = book.spot;
  for (const l of lanes) {
    for (const s of [...l.holdings, ...l.candidates]) { min = Math.min(min, lo(s)); max = Math.max(max, hi(s)); }
    if (l.iv !== null) { const sg = sigma(book.spot, l.iv, l.dte); min = Math.min(min, book.spot - sg); max = Math.max(max, book.spot + sg); }
  }
  const pad = (max - min) * 0.04 + 25;
  return [Math.floor((min - pad) / 50) * 50, Math.ceil((max + pad) / 50) * 50];
}

export function niceTicks(min: number, max: number, target: number): number[] {
  const raw = (max - min) / Math.max(1, target);
  const step = [25, 50, 100, 250, 500, 1000].find((s) => s >= raw) ?? 1000;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
  return out;
}

export function closedPayoffLeg(c: Closed): PayoffLeg {
  return { side: c.side, short: c.short, width: Math.abs(c.long - c.short), credit: c.entry, contracts: c.contracts };
}
export function holdingLeg(h: Holding): PayoffLeg {
  return { side: h.side, short: h.short, width: h.width ?? 0, credit: h.entry, contracts: h.contracts };
}
