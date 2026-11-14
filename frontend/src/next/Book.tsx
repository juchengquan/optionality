import { BellRing, OctagonAlert, Sparkles } from "lucide-react";

import type { Entry, Holding, Monitor } from "../shared/api";
import type { EntryStyle } from "../shared/prefs";
import { DASH } from "../shared/format";
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
  /** when the service last valued them, from its own stamp: said outside the session, where they
   *  are not polled ("market closed — valued at 21:04", #371) */
  holdingsAt: string | null;
  /** the same stamp whole, with its date (`valuedStamp`): the market-closed line dates a valuation
   *  from another day by it (#371's review). Absent, the line says `holdingsAt`'s time alone. */
  holdingsServed?: string | null;
  /** whether New York's session is open (`session.ts`): what is fetched, what the needs-you line
   *  says and whether a figure carries its time all follow this; what is DRAWN does not (#371–#375) */
  session: boolean;
  /** values the book once more, from the market-closed line: the header's refresh. Absent where
   *  nothing can be pressed, as in the saved picture. */
  onRevalue?: () => void;
  /** a valuation asked by `onRevalue` or the header is still out */
  revaluing?: boolean;
  privacy: boolean;
  entryStyle: EntryStyle;
  /** editing, closing and deleting a holding (#294); absent, its detail offers none of them */
  writes?: HoldingWrites;
  /** the closed trades' fold (#296, #373), drawn by either arrangement as the LAST thing in its
   *  book, after the watchlist; absent from the saved picture, which is not a journal */
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
export function Chip({ state }: { state: keyof typeof CHIP }) {
  const { Icon, words } = CHIP[state];
  return (
    <span className="nx-chip" data-attention={state}>
      <Icon aria-hidden="true" />{words}
    </span>
  );
}

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0, signDisplay: "exceptZero",
});

/** Money, or nothing a stranger can read. Privacy keeps %, Δ and DTE (ADR 0023): a share
 *  captured says how the trade is going without saying how big it is. */
export function Money({ value, privacy }: { value: number | null; privacy: boolean }) {
  if (value === null) return <span data-money="">{DASH}</span>;
  return (
    <span data-money="" data-outcome={value > 0 ? "gain" : value < 0 ? "loss" : "flat"}>
      {privacy ? "$•••" : MONEY.format(value)}
    </span>
  );
}
