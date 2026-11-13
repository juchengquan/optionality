/** The closed trades' journal (#296, ADR 0022), folded at the bottom of the book (#373): every
 *  holding the service keeps after its close, newest first, with what it made in POINTS.
 *
 *  Read from `GET /positions`, which lists every holding on record — held or closed — as stored, with
 *  `closed_on`, `exit` and `realized_points`, and asks the Provider nothing. Nothing here works a
 *  figure out: what a trade made is the service's `realized_points`, and a figure nobody recorded is
 *  said as unknown rather than as 0, which would read as a trade that broke even.
 *
 *  - **Read on first opening the section**, at any hour and in either mode, and again only after a
 *    write that changes it — a close, a correction, a delete. Never polled: a closed holding does
 *    not move (ADR 0023). Shutting the section and opening it again asks nothing.
 *  - **Never before it is opened.** A page nobody opens the section on never asks for it; the book
 *    draws `/positions/values`, which values open holdings alone (`openPositions`).
 */
import { useCallback, useEffect, useState } from "react";

import { fetchPositions, type Recorded } from "../shared/api";

/** A holding no longer held: its close day is known. */
export type ClosedTrade = Recorded & { closed_on: string };

const isClosed = (r: Recorded): r is ClosedTrade => r.closed_on !== null;

/** The closed holdings among `recorded`, newest close first, then by name — unique across open and
 *  closed (ADR 0022), so two closes on one day keep one order whatever order they were served in. */
export function journalOf(recorded: Recorded[]): ClosedTrade[] {
  return recorded.filter(isClosed).sort((a, b) =>
    b.closed_on.localeCompare(a.closed_on) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** An Entry or an Exit as STORED — 1.225 is not 1.23 — with only a sum's float noise trimmed, and
 *  blank said as unknown: blank is what the owner did not know (ADR 0022), never 0. */
export function storedWords(n: number | null): string {
  return n === null ? "unknown" : String(Number(n.toFixed(6)));
}

/** What a trade made, in the service's points, or unknown where its Entry or Exit was not recorded.
 *  Across the contracts held, so under privacy the figure goes as ClosedResult's does: × 100 is
 *  dollars, and it would give the size away. */
export function madeWords(points: number | null, privacy: boolean): string {
  if (points === null) return "unknown";
  // as served, with only a sum's float noise trimmed: rounded to the cent, 0.004 read as even
  return `${privacy ? "•••" : storedWords(points)} pts`;
}

export interface Journal {
  /** null until the first answer; a failed RE-read keeps the rows it had, with `error` beside them */
  trades: ClosedTrade[] | null;
  error: string | null;
  /** takes a trade out at once, as a delete answered: the re-read that follows says the rest */
  drop: (id: string) => void;
}

/** The journal, read when `on` turns true and again each time `ask` changes — the page's count of
 *  writes that change what it holds. An answer to an older ask never lands over a newer one, and a
 *  re-read keeps the rows it has until its answer comes. */
export function useJournal(on: boolean, ask: number): Journal {
  const [state, setState] = useState<{ trades: ClosedTrade[] | null; error: string | null }>(
    { trades: null, error: null });
  useEffect(() => {
    if (!on) return;
    let current = true;
    fetchPositions().then(
      (rows) => { if (current) setState({ trades: journalOf(rows), error: null }); },
      (e: unknown) => {
        // the rows it had stay: a trade open on them must not close because a re-read failed
        if (current) setState((was) => ({ trades: was.trades, error: e instanceof Error ? e.message : String(e) }));
      },
    );
    return () => { current = false; };
  }, [on, ask]);
  const drop = useCallback((id: string) => setState((was) => ({
    ...was, trades: was.trades === null ? null : was.trades.filter((t) => t.id !== id),
  })), []);
  return { ...state, drop };
}
