import { marketClock } from "./format";

/** How fresh the figures are — one line, shared by the page and by the picture it saves.
 *
 *  The two cadences stay worded distinctly because they answer different questions: the SERVICE
 *  decides how fresh the figures are, the screen only decides when they arrived. Both are kept
 *  because the page had only the first, and with the market shut no figure moves, so pressing
 *  refresh changed nothing visible and the button looked broken.
 *
 *  The session time sits beside the service's because the owner reads this in Singapore and
 *  trades a US session — and because the PNG carries this line to people who do not know which
 *  zone the dashboard is in. It is the FIGURES' time that gets the twin, not the screen's: the
 *  browser's own clock says nothing about the trading day.
 *
 *  One component rather than two copies: App had this markup and SnapshotView had it again, so
 *  the image could have told a different story about its own freshness than the page did.
 */
export function Freshness({ fetchedAt, polledAt, sweepSeconds }: {
  fetchedAt: string | null;
  polledAt: string | null;
  sweepSeconds: number | null;
}) {
  const session = marketClock(fetchedAt);
  return (
    <p className="meta">
      {fetchedAt ? `fetched at ${fetchedAt}` : "waiting for first sweep"}
      {session ? ` · ${session}` : ""}
      {polledAt ? ` · screen updated ${polledAt}` : ""}
      {sweepSeconds ? ` · service sweeps every ${sweepSeconds}s` : ""}
    </p>
  );
}
