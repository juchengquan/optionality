import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Settings2 } from "lucide-react";

import "./next.css";
import {
  addReference, fetchHealth, fetchHoldings, fetchMonitors, fetchQuotes, fetchReferences,
  removeReference,
  type Entry, type Health, type Holding, type Monitor, type Reference,
} from "../api";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Toaster, toast } from "@/components/ui/toast";
import { clockTime } from "../format";
import { Freshness } from "../Freshness";
import {
  readArrangement, readEntryStyle, readPrivacy, readRefresh, readUp, writeArrangement,
  writeEntryStyle, writePrivacy, writeRefresh, writeUp,
} from "../prefs";
import { ReferenceStrip } from "../ReferenceStrip";
import { useDismissOnBack } from "../useDismissOnBack";
import { arrangementFor, useViewportWidth } from "./arrangement";
import { Book } from "./Book";
import { clockMode, useSessionClock, type Mode } from "./mode";
import { NeedsLine } from "./NeedsLine";
import { needsYou } from "./needs";
import { Settings } from "./Settings";

/** The redesigned dashboard, at `/opt/next` beside today's (ADR 0023, #287).
 *
 *  A shell first: the arrangement, the mode, the colours, the needs-you line and Settings, around a
 *  plain list of the book that the desk table and the phone cards replace. Modes and arrangements
 *  are state, never routes (ADR 0005), so this is one page whichever is showing.
 */
export function Next() {
  const [up, setUp] = useState(readUp);
  const [entryStyle, setEntryStyle] = useState(readEntryStyle);
  const [privacy, setPrivacy] = useState(readPrivacy);
  const [choice, setChoice] = useState(readArrangement);
  const arrangement = arrangementFor(useViewportWidth(), choice);
  const phone = arrangement === "phone";

  // On the document as well as the page: a dialog or a toast is drawn in a portal outside `.nx`,
  // and on a phone its buttons need the same 44pt targets (next.css).
  useEffect(() => {
    document.documentElement.dataset.nxArrangement = arrangement;
    return () => { delete document.documentElement.dataset.nxArrangement; };
  }, [arrangement]);

  // The clock's mode unless the owner chose one. A choice lasts until the clock's own mode next
  // changes — LIVE picked at 08:00 New York is still LIVE at the open and becomes REVIEW at the
  // close, rather than polling the Provider all night — and choosing what the clock would pick
  // hands the page straight back to it.
  const byClock = clockMode(useSessionClock());
  const [chosen, setChosen] = useState<Mode | null>(null);
  useEffect(() => { setChosen(null); }, [byClock]);
  const mode = chosen ?? byClock;
  const pickMode = useCallback((m: Mode) => setChosen(m === byClock ? null : m), [byClock]);

  const book = useBook(mode);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // Settings is the one surface that may say "nothing needs you" (ADR 0012), so opening it asks
  // for the holdings afresh, whatever the mode — in REVIEW they are otherwise as old as the mode.
  // And it is where References are kept or dropped, so it reads them too: REVIEW polls neither.
  const { loadHoldings, loadReferences } = book;
  useEffect(() => {
    if (settingsOpen) void Promise.all([loadHoldings(), loadReferences()]);
  }, [settingsOpen, loadHoldings, loadReferences]);

  // the line uses only what is polled (ADR 0012): holdings are polled in LIVE and asked for once
  // in REVIEW, so in REVIEW their Levels are left to Settings, which asks again and says when
  const items = useMemo(
    () => needsYou(book.quotes, book.monitors, book.health, mode === "live" ? book.holdings : null),
    [book.quotes, book.monitors, book.health, book.holdings, mode],
  );
  const everything = useMemo(
    () => needsYou(book.quotes, book.monitors, book.health, book.holdings),
    [book.quotes, book.monitors, book.health, book.holdings],
  );

  const settings = (
    <Settings
      up={up} onUp={(v) => { setUp(v); writeUp(v); }}
      entryStyle={entryStyle} onEntryStyle={(v) => { setEntryStyle(v); writeEntryStyle(v); }}
      privacy={privacy} onPrivacy={(v) => { setPrivacy(v); writePrivacy(v); }}
      choice={choice} onChoice={(v) => { setChoice(v); writeArrangement(v); }}
      refresh={book.refresh} onRefresh={(n) => { book.setRefresh(n); writeRefresh(n); }}
      health={book.health} needs={everything}
      complete={book.holdings !== null && book.holdingsError === null}
      holdingsAt={book.holdingsAt}
      references={book.references}
      onAddReference={(body) => book.act(() => addReference(body))}
      onRemoveReference={(id) => void book.act(() => removeReference(id))}
    />
  );

  return (
    <div className="nx" data-arrangement={arrangement} data-mode={mode} data-up={up}
         data-entry={entryStyle}>
      <header className="nx-head">
        <h1>optionality</h1>
        {phone ? null : <ModeSwitch mode={mode} byClock={chosen === null} onPick={pickMode} />}
        <span className="nx-spacer" />
        <Button variant="ghost" size="sm" aria-label="refresh now" disabled={book.refreshing}
                onClick={() => void book.refreshNow()}>
          <RefreshCw className={book.refreshing ? "animate-spin" : undefined} />
        </Button>
        {phone ? null : (
          <Button variant="ghost" size="sm" aria-label="settings" onClick={() => setSettingsOpen(true)}>
            <Settings2 />
          </Button>
        )}
      </header>

      <main className="nx-main">
        {book.error ? <div className="nx-banner" role="alert">{book.error}</div> : null}
        <Freshness fetchedAt={book.health?.monitor.fetched_at ?? null} polledAt={book.polledAt}
                   sweepSeconds={book.health?.settings.sweep_seconds ?? null} />
        <NeedsLine items={items} arrangement={arrangement} entryStyle={entryStyle} />
        {/* the market as it is now, so only in LIVE: in REVIEW nothing re-reads it, and a strip
            frozen at the moment the mode was entered would be read as current (ADR 0018) */}
        {mode === "live" ? <ReferenceStrip references={book.references} /> : null}
        {phone && settingsOpen ? settings : (
          <Book quotes={book.quotes} holdings={book.holdings} holdingsError={book.holdingsError}
                holdingsAt={book.holdingsAt} mode={mode} privacy={privacy} />
        )}
      </main>

      {phone ? (
        <TabBar mode={mode} settings={settingsOpen}
                onMode={(m) => { setSettingsOpen(false); pickMode(m); }}
                onSettings={() => setSettingsOpen(true)} />
      ) : null}
      {/* Mounted in both arrangements and only OPEN on the desk: switching to the phone with it
          open then closes it, and closing is what takes its history entry back off the stack.
          Unmounted instead, the entry stayed and the next Back press did nothing. */}
      <DeskSettings open={settingsOpen && !phone} onClose={closeSettings}>
        {phone ? null : settings}
      </DeskSettings>
      <Toaster />
    </div>
  );
}

/** LIVE or REVIEW on the desk, and whose choice it is. */
function ModeSwitch({ mode, byClock, onPick }: {
  mode: Mode; byClock: boolean; onPick: (m: Mode) => void;
}) {
  return (
    <div className="nx-mode" role="group" aria-label="mode">
      <button type="button" aria-pressed={mode === "live"} onClick={() => onPick("live")}>Live</button>
      <button type="button" aria-pressed={mode === "review"} onClick={() => onPick("review")}>Review</button>
      <span className="nx-meta">{byClock ? "by the clock" : "your choice"}</span>
    </div>
  );
}

/** The phone's bottom bar: Live and Review are the mode, Settings a screen of its own. Add joins
 *  it when adding a spread lands (#293). */
function TabBar({ mode, settings, onMode, onSettings }: {
  mode: Mode; settings: boolean; onMode: (m: Mode) => void; onSettings: () => void;
}) {
  const current = settings ? "settings" : mode;
  return (
    <nav className="nx-tabs" aria-label="views">
      <button type="button" aria-current={current === "live" ? "page" : undefined}
              onClick={() => onMode("live")}>Live</button>
      <button type="button" aria-current={current === "review" ? "page" : undefined}
              onClick={() => onMode("review")}>Review</button>
      <button type="button" aria-current={current === "settings" ? "page" : undefined}
              onClick={onSettings}>Settings</button>
    </nav>
  );
}

function DeskSettings({ open, onClose, children }: {
  open: boolean; onClose: () => void; children: React.ReactNode;
}) {
  useDismissOnBack(open, onClose);
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>This screen's preferences, and where the service stands in full.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

/** Whether a poll would disturb something being operated (App.tsx: `beingOperated`). */
function beingOperated(el: Element | null): boolean {
  return Boolean(el?.closest('[data-poll="hold"]'));
}

/** What the page reads, and when.
 *
 *  The LINE's inputs — the watchlist, the rules and health — are polled in both modes: REVIEW
 *  carries the needs-you line and every fault, and a line can only do that if what it reads keeps
 *  coming. Each is read on its own, so a Provider outage that fails `/quotes` still lets health
 *  say so and the rules' quarantines through.
 *
 *  Beyond the line, LIVE also polls the holdings' valuation and the References: three market-data
 *  calls per poll where `/opt` makes two (ADR 0010), the cost of holdings leading the page; with
 *  nothing held the valuation asks the Provider nothing. REVIEW asks for the holdings once, on
 *  entering it, and not for the References, which it does not show.
 */
function useBook(mode: Mode) {
  const [quotes, setQuotes] = useState<Entry[]>([]);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [references, setReferences] = useState<Reference[]>([]);
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [holdingsError, setHoldingsError] = useState<string | null>(null);
  const [holdingsAt, setHoldingsAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polledAt, setPolledAt] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(15);
  const [refreshing, setRefreshing] = useState(false);
  const [pollFrom, setPollFrom] = useState(0);
  const live = mode === "live";

  const loadLine = useCallback(async () => {
    const [q, m, h] = await Promise.allSettled([fetchQuotes(), fetchMonitors(), fetchHealth()]);
    if (q.status === "fulfilled") setQuotes(q.value);
    if (m.status === "fulfilled") setMonitors(m.value);
    if (h.status === "fulfilled") setHealth(h.value);
    const failed = [q, m, h].find((r) => r.status === "rejected");
    if (failed) {
      // the page still renders when the service is unhappy; this says the figures are stale and
      // stays up until a poll succeeds
      const why: unknown = failed.reason;
      setError(why instanceof Error ? why.message : String(why));
    } else {
      // only when everything arrived: "screen updated" is a claim about the figures
      setPolledAt(clockTime(new Date()));
      setError(null);
    }
  }, []);

  const loadHoldings = useCallback(async () => {
    try {
      setHoldings(await fetchHoldings());
      setHoldingsAt(clockTime(new Date()));
      setHoldingsError(null);
    } catch (e: unknown) {
      // CLEARED, unlike `/opt`, which keeps the rows and relies on drawing the error first: here
      // the needs-you line reads them too, and must not go on saying a Level from a valuation
      // that has since failed
      setHoldings(null);
      setHoldingsError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadReferences = useCallback(
    // a backdrop never blanks the page, and an empty list takes the strip away rather than
    // leaving figures nobody can vouch for (ADR 0018)
    () => fetchReferences().then(setReferences, () => setReferences([])),
    [],
  );

  /** `rest`: the market data beyond the line — the holdings, and in LIVE the References. */
  const load = useCallback(
    (rest: boolean) => Promise.all([
      loadLine(),
      rest ? loadHoldings() : null,
      rest && live ? loadReferences() : null,
    ]).then(() => undefined),
    [loadLine, loadHoldings, loadReferences, live],
  );

  // everything once on opening and on every change of mode: entering REVIEW is when it asks
  // (`load` changes with the mode, so this runs once per mode)
  useEffect(() => { void load(true); }, [load]);

  // the viewer's cadence if chosen, the service's sweep if not (prefs.readRefresh)
  useEffect(() => {
    if (health) setRefresh(readRefresh(health.settings.sweep_seconds));
  }, [health]);

  useEffect(() => {
    const id = setInterval(() => {
      if (!beingOperated(document.activeElement)) void load(live);
    }, refresh * 1000);
    return () => clearInterval(id);
  }, [refresh, load, live, pollFrom]);

  const refreshNow = useCallback(async () => {
    setRefreshing(true);
    try {
      await load(true);
    } finally {
      setRefreshing(false);
      // restarts the interval: a press just before a tick must displace it, not add a batch
      setPollFrom((n) => n + 1);
    }
  }, [load]);

  /** A change the service has to make, then the page as the service now tells it. */
  const act = useCallback(async (fn: () => Promise<void>) => {
    try {
      await fn();
      await load(true);
      return true;
    } catch (e: unknown) {
      toast.add({ title: e instanceof Error ? e.message : String(e), type: "error" });
      return false;
    }
  }, [load]);

  return {
    quotes, monitors, health, references, holdings, holdingsError, holdingsAt, error, polledAt,
    refresh, setRefresh, refreshing, refreshNow, act, loadHoldings, loadReferences,
  };
}
