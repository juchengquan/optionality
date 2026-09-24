import type { Entry, PositionValue } from "./api";

/** Bands at which a row is worth noticing. One scale for every rule type: a leg rule at 80%
 *  of its delta and a position at 80% of its stop are not equally alarming, but inventing
 *  per-type bands before knowing that is guesswork. */
export function urgencyBand(fill: number | null): "" | "near" | "close" {
  if (fill === null) return "";
  if (fill >= 90) return "close";
  if (fill >= 70) return "near";
  return "";
}

/** The number this rule is measured on — the same one the fill bar tracks. */
export function watchedValue(entry: Entry): number | null {
  if (entry.positions.length > 0 && entry.legs) return entry.cost_to_close;
  if (entry.legs) return entry.combo_value ?? null;
  const snap = entry.snapshot;
  return snap ? ((snap[entry.field as keyof typeof snap] as number | null) ?? null) : null;
}

export interface Book {
  total: number;
  priced: number;
  of: number;
}

/** Sums across holdings, and says how much of the book it could actually price — a total
 *  that silently omits a position you opened this morning is worse than no total. */
export function bookPnl(positions: PositionValue[]): Book {
  const priced = positions.filter((p) => p.pnl !== null);
  return {
    total: priced.reduce((sum, p) => sum + (p.pnl ?? 0), 0),
    priced: priced.length,
    of: positions.length,
  };
}

export function closestToFiring(entries: Entry[]): Entry | null {
  const withFill = entries.filter((e) => e.fill !== null);
  if (withFill.length === 0) return null;
  return withFill.reduce((worst, e) => ((e.fill ?? 0) > (worst.fill ?? 0) ? e : worst));
}

const BASELINE_KEY = "optionality_baseline";

export interface Baseline {
  at: string;
  watched: Record<string, number>;
}

/** Where each rule stood when you last looked. Kept in localStorage so a page reload does
 *  not lose it, and never sent anywhere — it is a fact about your attention, not your book. */
export function loadBaseline(): Baseline | null {
  try {
    const raw = localStorage.getItem(BASELINE_KEY);
    return raw ? (JSON.parse(raw) as Baseline) : null;
  } catch {
    return null; // private browsing, cleared storage, a corrupt value — all mean "no baseline"
  }
}

export function saveBaseline(entries: Entry[]): Baseline {
  const watched: Record<string, number> = {};
  for (const e of entries) {
    const v = watchedValue(e);
    if (v !== null) watched[e.id] = v;
  }
  const baseline: Baseline = { at: new Date().toISOString(), watched };
  try {
    localStorage.setItem(BASELINE_KEY, JSON.stringify(baseline));
  } catch {
    // storage unavailable: the feature degrades to nothing rather than breaking the page
  }
  return baseline;
}

export function movedSince(entry: Entry, baseline: Baseline | null): number | null {
  if (!baseline) return null;
  const was = baseline.watched[entry.id];
  const now = watchedValue(entry);
  if (was === undefined || now === null) return null;
  const delta = now - was;
  return Math.abs(delta) < 1e-9 ? null : delta;
}
