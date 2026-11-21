import { BellRing, OctagonAlert, Sparkles } from "lucide-react";

import type { Entry, Holding, Monitor } from "./shared/api";
import type { EntryStyle } from "./shared/prefs";
import type { MarketPhase } from "./session";
import { DASH } from "./shared/format";
import { money } from "./shared/numbers";
import type { HoldingWrites } from "./HoldingActions";

/** What every drawing of the book is handed: the polled figures and the viewer's settings. The
 *  desk's table (`desk/`, #289) and the phone's cards (`phone/`, #290) each take exactly this, and
 *  place the book with `placeBook` so the two cannot group it differently. */
export interface BookProps {
  quotes: Entry[];
  /** every rule, enabled or not: the muted and quarantined ones are only here */
  monitors: Monitor[];
  /** null while not valued, and after a valuation failed: the error is said INSTEAD of figures
   *  nobody can vouch for, as the old page did (#301) */
  holdings: Holding[] | null;
  holdingsError: string | null;
  /** whether the last read of `/quotes` answered: until it has, and while it fails, the book drawn
   *  is missing the watchlist's groups, and the folds (`folds.ts`) drop none of theirs. Absent, the
   *  quotes given are taken as read */
  quotesRead?: boolean;
  /** the last valuation that succeeded, while `holdings` is null because one failed since: only the
   *  holding already open in the inspector or the sheet is drawn from it, said to be stale, so a
   *  failed poll costs no half-typed form (`kept.ts`). The book itself never draws it */
  holdingsKept?: Holding[] | null;
  /** when the service last valued them, from its own stamp: said outside the session, where they
   *  are not polled ("market closed — valued at 21:04", #371) */
  holdingsAt: string | null;
  /** the same stamp whole, with its date (`valuedStamp`): the market-closed line dates a valuation
   *  from another day by it (#371's review). Absent, the line says `holdingsAt`'s time alone. */
  holdingsServed?: string | null;
  /** whether New York's session is open (`session.ts`). It decides what is fetched, the
   *  market-closed line, whether a figure carries its time, what the needs-you line states
   *  (holdings' Levels only in session), whether a holding's history starts open (outside it), and
   *  the saved picture's session line. The columns, the rows and the fold do not follow it
   *  (#371–#375). */
  session: boolean;
  /** which of SPX options' sessions it is (`marketPhase`, #416): the page polls in the regular one,
   *  the Curb and GTH alike (`session` is true in all three), and the session line says which —
   *  "overnight session — live quotes, thin" — wherever it is not the regular one. Absent, it is
   *  read from `session`: regular, or closed. */
  phase?: MarketPhase;
  privacy: boolean;
  entryStyle: EntryStyle;
  /** editing, closing and deleting a holding (#294); absent, its detail offers none of them */
  writes?: HoldingWrites;
  /** the closed trades' fold (#296, #373), drawn by either arrangement as the LAST thing in its
   *  book, after its expiries. The saved picture (#394) draws none: a journal is not the book */
  journal?: React.ReactNode;
}

const CHIP = {
  fault: { Icon: OctagonAlert, words: "fault" },
  alarm: { Icon: BellRing, words: "ringing" },
  entry: { Icon: Sparkles, words: "entry signal" },
} as const;

/** A filled chip with a glyph (ADR 0023): attention is told apart from the "down" colour by its
 *  shape and lightness as well as its hue, so it reads the same whichever way up the viewer has
 *  set the colours, and to somebody who cannot tell the hues apart at all. */
export function Chip({ state, words }: {
  state: keyof typeof CHIP;
  /** in place of the state's own word: a folded expiry's count of them, "2 entry signals" */
  words?: string;
}) {
  const { Icon, words: own } = CHIP[state];
  return (
    <span className="nx-chip" data-attention={state}>
      <Icon aria-hidden="true" />{words ?? own}
    </span>
  );
}

/** Money, or nothing a stranger can read. Privacy keeps %, Δ and DTE (ADR 0023): a share
 *  captured says how the trade is going without saying how big it is. */
export function Money({ value, privacy }: { value: number | null; privacy: boolean }) {
  if (value === null) return <span data-money="">{DASH}</span>;
  return (
    <span data-money="" data-outcome={value > 0 ? "gain" : value < 0 ? "loss" : "flat"}>
      {privacy ? "$•••" : money(value)}
    </span>
  );
}
