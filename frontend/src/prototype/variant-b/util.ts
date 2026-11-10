/** PROTOTYPE — throwaway. Variant B's formatting and the few derivations the book does not carry. */
import type { Alert, AlertState, Closed, Holding, Prefs, Sample, Side } from "../data";

export const MULT = 100;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-12-18" -> "Dec 18" */
export const day = (iso: string) => `${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
export const pts = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? "—" : x.toFixed(d));
export const signed = (x: number, d = 2) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(d)}`;
export const delta = (x: number | null | undefined) => (x === null || x === undefined ? "—" : x.toFixed(2));
export const pct = (x: number, d = 0) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(d)}%`;
export const strike = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });
export const price = (x: number) => x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** dollars, unless the viewer asked for privacy (keeps %, Δ and DTE) */
export function usd(x: number, prefs: Prefs, signedOut = true) {
  if (prefs.privacy) return "$•••";
  const s = Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return `${signedOut ? (x > 0 ? "+" : x < 0 ? "−" : "") : ""}$${s}`;
}

/** "2026-11-10 12:27:20+08:00" -> "12:27:20 SGT" */
export function asOf(stamp: string, tz: string) {
  const zone = tz === "Asia/Singapore" ? "SGT" : tz;
  return `${stamp.slice(11, 19)} ${zone}`;
}

export const spreadLabel = (s: { short: number; long: number | null; side: Side }) =>
  s.long === null ? `${strike(s.short)} ${s.side}` : `${strike(s.short)}/${strike(s.long)} ${s.side} spread`;

export const dteBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);

/** One spread's P&L at expiry, points per spread, for a credit received of `entry`. */
export function payoffAt(spot: number, side: Side, short: number, long: number, entry: number) {
  if (side === "put") return entry - Math.max(0, short - spot) + Math.max(0, long - spot);
  return entry - Math.max(0, spot - short) + Math.max(0, spot - long);
}
export const breakeven = (side: Side, short: number, entry: number) =>
  side === "put" ? short - entry : short + entry;

/** σ of the move to expiry from the short leg's own IV: spot × iv × √(dte/365) */
export const sigma = (spot: number, ivPct: number, dte: number) => spot * (ivPct / 100) * Math.sqrt(Math.max(dte, 0.5) / 365);

/** The exit schedule's planned cost on a date — the same √ shape data.ts uses for today. */
export function plannedOn(h: Pick<Holding, "entry" | "target" | "expiry" | "opened" | "manageByDte">, date: string) {
  const dteAtOpen = dteBetween(h.opened, h.expiry);
  const span = Math.max(1, dteAtOpen - h.manageByDte);
  const left = Math.max(0, dteBetween(date, h.expiry) - h.manageByDte);
  return h.target + (h.entry - h.target) * Math.sqrt(left / span);
}

/** An alert re-evaluated after a local edit: the state and sentence follow the new threshold. */
export function reevaluate(a: Alert, threshold: number, direction: "above" | "below"): Alert {
  if (a.state === "quarantined" || a.state === "muted" || a.current === null) {
    return { ...a, threshold, direction };
  }
  const hit = direction === "above" ? a.current >= threshold : a.current <= threshold;
  const fill = Math.max(0, Math.min(100, Math.round((a.current / threshold) * 100)));
  const state: AlertState = hit ? "fired" : fill >= 80 ? "near" : "armed";
  const op = direction === "above" ? "≥" : "≤";
  const away = Math.abs(threshold - a.current);
  return {
    ...a, threshold, direction, fill: hit ? 100 : fill, state,
    sentence: `${a.field} ${op} ${threshold} — now ${a.current}, ${away.toFixed(a.field.includes("Δ") ? 3 : 2)} away`,
  };
}

/** No alarm log is stored yet, so a holding's alert history is DERIVED from its daily samples. */
export function alertHistory(h: Holding): string[] {
  const out: string[] = [];
  const d = h.alerts.find((a) => a.field === "short Δ");
  if (d) {
    const first = h.samples.find((s) => s.shortDelta >= d.threshold);
    out.push(first
      ? `short Δ first reached ${d.threshold.toFixed(2)} on ${day(first.date)} (${first.shortDelta.toFixed(2)})`
      : `short Δ peaked at ${Math.max(...h.samples.map((s) => s.shortDelta)).toFixed(2)}, never ${d.threshold.toFixed(2)}`);
  }
  const worst = h.samples.reduce((m, s) => (s.cost > m.cost ? s : m), h.samples[0]!);
  out.push(`highest close to buy back: ${worst.cost.toFixed(2)} on ${day(worst.date)} (stop ${h.stop.toFixed(2)})`);
  const best = h.samples.reduce((m, s) => (s.cost < m.cost ? s : m), h.samples[0]!);
  out.push(`lowest: ${best.cost.toFixed(2)} on ${day(best.date)} (target ${h.target.toFixed(2)})`);
  const offClose = h.samples.filter((s) => !s.atClose);
  if (offClose.length) out.push(`${offClose.map((s) => day(s.date)).join(", ")}: not a 16:15 close (filled after hours)`);
  return out;
}

export const closedCaptured = (c: Closed) => c.realizedPoints / c.entry;
export const lastSample = (s: Sample[]) => s[s.length - 1];
