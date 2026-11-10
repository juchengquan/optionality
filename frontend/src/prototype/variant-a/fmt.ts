/** PROTOTYPE — throwaway. Variant A's number formats: ONE fixed precision per field, so a
 *  column never changes width as figures move, and gamma-at-six-places never happens. */
import type { Prefs } from "../data";

const grp = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const pts = (x: number | null | undefined) => (x == null ? "—" : x.toFixed(2));
export const spx = (x: number | null | undefined) => (x == null ? "—" : grp.format(x));
export const delta = (x: number | null | undefined) => (x == null ? "—" : Math.abs(x).toFixed(3));
export const iv = (x: number | null | undefined) => (x == null ? "—" : `${x.toFixed(1)}%`);
export const pct = (x: number | null | undefined, d = 0) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
export const signedPts = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`;
export const chg = (x: number | null) => (x == null ? "—" : `${x >= 0 ? "▲" : "▼"}${Math.abs(x * 100).toFixed(2)}%`);

export function usd(x: number, prefs: Prefs, signed = true): string {
  if (prefs.privacy) return "$•••";
  const s = signed ? (x >= 0 ? "+" : "−") : "";
  return `${s}$${int.format(Math.abs(x))}`;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export const mmmdd = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(8, 10)}`;
export const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

/** "2026-11-10 12:27:20+08:00" -> "12:27:20" */
export const clock = (stamp: string) => stamp.slice(11, 19);

export const strikes = (side: "call" | "put", short: number, long: number | null) =>
  long == null ? `${short}${side === "call" ? "C" : "P"}` : `${short}/${long}${side === "call" ? "C" : "P"}`;

export const gainClass = (x: number) => (x >= 0 ? "gain" : "loss");
