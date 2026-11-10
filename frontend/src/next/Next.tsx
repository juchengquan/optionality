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
import { clockMode, useMinuteClock, type Mode } from "./mode";
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

  // the clock's mode unless the owner chose one; choosing the mode the clock would pick anyway
  // hands the page back to the clock, so the override never outlives its reason
  const byClock = clockMode(useMinuteClock());
  const [chosen, setChosen] = useState<Mode | null>(null);
  const mode = chosen ?? byClock;
  const pickMode = useCallback((m: Mode) => setChosen(m === byClock ? null : m), [byClock]);

  const book = useBook(mode);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // the line uses only what is polled (ADR 0012): holdings are polled in LIVE and asked for once in
  // REVIEW, so in REVIEW their Levels wait for Settings, which can say how old they are
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
      references={book.references}
      onAddReference={(body) => book.act(() => addReference(body))}
      onRemoveReference={(id) => void book.act(() => removeReference(id))}
    />
  );

  const phone = arrangement === "phone";
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
        <ReferenceStrip references={book.references} />
        {phone && settingsOpen ? settings : (
          <Book quotes={book.quotes} holdings={book.holdings} holdingsError={book.holdingsError}
                mode={mode} privacy={privacy} />
        )}
      </main>

      {phone ? (
        <TabBar mode={mode} settings={settingsOpen}
                onMode={(m) => { setSettingsOpen(false); pickMode(m); }}
                onSettings={() => setSettingsOpen(true)} />
      ) : (
        <DeskSettings open={settingsOpen} onClose={closeSettings}>{settings}</DeskSettings>
      )}
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
 *  coming. The rest is market data beyond the line, the holdings' valuation and the References: in
 *  LIVE it is polled with the line, in REVIEW asked for once when the mode is entered (ADR 0023).
 *  Polling holdings in LIVE is a second batch per poll (ADR 0010), the cost of holdings leading the
 *  page; with nothing held it asks the Provider nothing.
 */
function useBook(mode: Mode) {
  const [quotes, setQuotes] = useState<Entry[]>([]);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [references, setReferences] = useState<Reference[]>([]);
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [holdingsError, setHoldingsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polledAt, setPolledAt] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(15);
  const [refreshing, setRefreshing] = useState(false);
  const [pollFrom, setPollFrom] = useState(0);
  const live = mode === "live";

  const loadLine = useCallback(async () => {
    try {
      const [q, m, h] = await Promise.all([fetchQuotes(), fetchMonitors(), fetchHealth()]);
      setQuotes(q);
      setMonitors(m);
      setHealth(h);
      setPolledAt(clockTime(new Date()));
      setError(null);
    } catch (e: unknown) {
      // the page still renders when the service is unhappy; this says every figure is stale and
      // stays up until a poll succeeds
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadRest = useCallback(async () => {
    await Promise.all([
      // a backdrop never blanks the page, and an empty list takes the strip away rather than
      // leaving figures nobody can vouch for (ADR 0018)
      fetchReferences().then(setReferences, () => setReferences([])),
      fetchHoldings().then(
        (h) => { setHoldings(h); setHoldingsError(null); },
        (e: unknown) => setHoldingsError(e instanceof Error ? e.message : String(e)),
      ),
    ]);
  }, []);

  const load = useCallback(
    (rest: boolean) => Promise.all([loadLine(), rest ? loadRest() : null]).then(() => undefined),
    [loadLine, loadRest],
  );

  // everything once on opening and on every change of mode: entering REVIEW is when it asks
  useEffect(() => { void load(true); }, [load, mode]);

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
    quotes, monitors, health, references, holdings, holdingsError, error, polledAt,
    refresh, setRefresh, refreshing, refreshNow, act,
  };
}
