import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ImageDown, Plus, RefreshCw, Settings2 } from "lucide-react";

import "./next.css";
import {
  addReference, deleteMonitor, fetchHealth, fetchHoldings, fetchMonitors, fetchQuotes, fetchReferences,
  patchMonitor, removeReference,
  type Added, type Entry, type Health, type Holding, type Monitor, type Reference,
} from "../api";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Toaster, toast } from "@/components/ui/toast";
import { clockTime } from "../format";
import { Freshness } from "../Freshness";
import {
  readArrangement, readEntryStyle, readPrivacy, readRefresh, readUp, writeArrangement,
  writeEntryStyle, writePrivacy, writeRefresh, writeUp, type EntryStyle, type UpColour,
} from "../prefs";
import { ReferenceStrip } from "../ReferenceStrip";
import { useDismissOnBack } from "../useDismissOnBack";
import { AddSpread } from "./AddSpread";
import { ClosedResult } from "./ClosedResult";
import type { ClosedOutcome, HoldingWrites } from "./HoldingActions";
import { arrangementFor, useViewportWidth } from "./arrangement";
import type { BookProps } from "./Book";
import { DeskBook } from "./desk/DeskBook";
import { DeskJournal } from "./desk/DeskJournal";
import { useJournal } from "./journal";
import { MonitorActionsContext, type MonitorActions } from "./MonitorEdit";
import { PhoneBook } from "./phone/PhoneBook";
import { PhoneJournal } from "./phone/PhoneJournal";
import { clockMode, useSessionClock, type Mode } from "./mode";
import { NeedsLine, reveal } from "./NeedsLine";
import { needsYou } from "./needs";
import { Settings } from "./Settings";
import { Still, type StillProps } from "./snapshot/Still";
import { useSaveImage } from "./snapshot/useSaveImage";

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
  // changes: LIVE picked at 08:00 New York becomes the clock's at the open and REVIEW at the close,
  // rather than polling the Provider all night. LIVE picked AFTER a close therefore lasts until
  // the next open — over a weekend, until Monday — polling as LIVE does. Choosing what the clock
  // would pick hands the page straight back to it.
  const byClock = clockMode(useSessionClock());
  const [chosen, setChosen] = useState<Mode | null>(null);
  useEffect(() => { setChosen(null); }, [byClock]);
  const mode = chosen ?? byClock;
  const pickMode = useCallback((m: Mode) => setChosen(m === byClock ? null : m), [byClock]);

  const book = useBook(mode);
  // the picture (#300): the press, and the page's figures as they were at it — the off-screen tree
  // is drawn from that copy, so a poll landing mid-capture cannot make one picture two moments
  const { frame: pictured, stageRef, save } = useSaveImage<StillProps>();
  const shooting = pictured !== null;
  // REVIEW's closed trades (#296): read on entering REVIEW and after each write that changes them —
  // a close, a correction, a delete — and never polled; LIVE never asks for them
  const [journalAsk, setJournalAsk] = useState(0);
  const journal = useJournal(mode === "review", journalAsk);
  const rereadJournal = useCallback(() => setJournalAsk((n) => n + 1), []);
  // a closed trade deleted from the journal leaves it at once, and the re-read says the rest
  const { drop: dropTrade } = journal;
  const tradeDeleted = useCallback((id: string) => { dropTrade(id); rereadJournal(); }, [dropTrade, rereadJournal]);
  const { holdings, writes, outcomes, dismissOutcome } = useHoldingWrites(book.holdings, book.reload, rereadJournal);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  // adding a spread (#293): a panel above the desk's table, a bottom sheet from the phone's Add tab
  const [adding, setAdding] = useState(false);
  const panelId = useId();
  const plusButton = useRef<HTMLButtonElement>(null);
  const closeAdding = useCallback(() => setAdding(false), []);
  // the desk's panel hands the focus back to "+" when it goes, by Escape or Cancel
  const closePanel = useCallback(() => { setAdding(false); plusButton.current?.focus(); }, []);
  const { reload } = book;
  const saved = useCallback((added: Added) => {
    setAdding(false);
    // what was made, in rows; never a count of contracts, which privacy hides
    const made = [
      added.positions.length ? `${added.positions.length} holding${added.positions.length === 1 ? "" : "s"}` : null,
      `${added.monitors.length} Monitor${added.monitors.length === 1 ? "" : "s"}`,
    ].filter(Boolean).join(" and ");
    const r = added.replaced.length;
    toast.add({
      title: `added ${made}${r ? `, replacing ${r} watch rule${r === 1 ? "" : "s"}` : ""}`, type: "success",
    });
    plusButton.current?.focus();
    void reload();
  }, [reload]);
  // editing a Monitor in place (#292): each write then the page as the service now tells it, its
  // refusal thrown back to the form that sent it rather than toasted underneath it
  const retentionDays = book.health?.settings.expired_retention_days ?? null;
  const monitorActions = useMemo<MonitorActions>(() => ({
    patch: async (id, body) => { await patchMonitor(id, body as Record<string, unknown>); await reload(); },
    remove: async (id) => { await deleteMonitor(id); await reload(); },
    retentionDays,
  }), [reload, retentionDays]);
  // the preview's SPX marker: the book's last batch's derived price, never a Reference's (ADR 0024)
  const priced = book.quotes.find((q) => q.spx !== null) ?? book.holdings?.find((h) => h.spx !== null);
  const spx = priced?.spx ?? null;
  const spxReason = priced ? null : book.quotes[0]?.spx_reason ?? book.holdings?.[0]?.spx_reason ?? null;
  const addForm = (
    <AddSpread privacy={privacy} monitors={book.monitors} spx={spx} spxReason={spxReason} onSaved={saved}
               onCancel={phone ? closeAdding : closePanel} autoFocus={!phone} />
  );

  // Settings is the one surface that may say "nothing needs you" (ADR 0012), and where References
  // are kept or dropped. LIVE polls both already; REVIEW polls neither, so opening Settings there
  // asks for them afresh — otherwise they are as old as the mode. The mode is read through a ref:
  // a switch of mode with Settings open asks for them anyway, and must not ask twice.
  const { loadHoldings, loadReferences } = book;
  const modeNow = useRef(mode);
  modeNow.current = mode;
  useEffect(() => {
    if (settingsOpen && modeNow.current === "review") void Promise.all([loadHoldings(), loadReferences()]);
  }, [settingsOpen, loadHoldings, loadReferences]);

  // A banner tapped from the phone's Settings tab leads to a row that is not drawn there: back to
  // the book first, then to the row once it is.
  const revealRow = useCallback((ref: string) => {
    setSettingsOpen(false);
    setTimeout(() => reveal(ref), 0);
  }, []);

  // the line uses only what is polled (ADR 0012): holdings are polled in LIVE and asked for once
  // in REVIEW, so in REVIEW their Levels are left to Settings, which asks again and says when
  const items = useMemo(
    () => needsYou(book.quotes, book.monitors, book.health, mode === "live" ? holdings : null),
    [book.quotes, book.monitors, book.health, holdings, mode],
  );
  const everything = useMemo(
    () => needsYou(book.quotes, book.monitors, book.health, holdings),
    [book.quotes, book.monitors, book.health, holdings],
  );

  // one set of props for either arrangement's book: each draws `placeBook` of these (placement.ts)
  const bookProps: BookProps = {
    quotes: book.quotes, monitors: book.monitors, holdings,
    holdingsError: book.holdingsError, holdingsAt: book.holdingsAt, mode, privacy, entryStyle, writes,
    journal: mode === "review" && phone
      ? <PhoneJournal journal={journal} privacy={privacy} entryStyle={entryStyle} onCorrected={rereadJournal}
                      onDeleted={tradeDeleted} />
      : undefined,
  };

  const settings = (
    <Settings
      up={up} onUp={(v) => { setUp(v); writeUp(v); }}
      entryStyle={entryStyle} onEntryStyle={(v) => { setEntryStyle(v); writeEntryStyle(v); }}
      privacy={privacy} onPrivacy={(v) => { setPrivacy(v); writePrivacy(v); }}
      choice={choice} onChoice={(v) => { setChoice(v); writeArrangement(v); }}
      refresh={book.refresh} onRefresh={(n) => { book.setRefresh(n); writeRefresh(n); }}
      health={book.health} needs={everything}
      complete={holdings !== null && book.holdingsError === null}
      holdingsAt={book.holdingsAt}
      references={book.references}
      onAddReference={(body) => book.act(() => addReference(body))}
      onRemoveReference={(id) => void book.act(() => removeReference(id))}
    />
  );

  return (
    <MonitorActionsContext.Provider value={monitorActions}>
    <div className="nx" data-arrangement={arrangement} data-mode={mode} data-up={up}
         data-entry={entryStyle}>
      <header className="nx-head">
        <h1>optionality</h1>
        {phone ? null : <ModeSwitch mode={mode} byClock={chosen === null} onPick={pickMode} />}
        <span className="nx-spacer" />
        <Button variant="ghost" size="sm" aria-label="save as image" disabled={shooting}
                onClick={() => void save({
                  // the book, without REVIEW's closed trades: a journal is not the book
                  ...bookProps, journal: undefined, arrangement, needs: items, health: book.health, polledAt: book.polledAt,
                  error: book.error, references: book.references,
                })}>
          <ImageDown className={shooting ? "animate-pulse" : undefined} />
        </Button>
        <Button variant="ghost" size="sm" aria-label="refresh now" disabled={book.refreshing}
                onClick={() => void book.refreshNow()}>
          <RefreshCw className={book.refreshing ? "animate-spin" : undefined} />
        </Button>
        {phone ? null : (
          <Button ref={plusButton} variant="ghost" size="sm" aria-label="add a spread" aria-expanded={adding}
                  aria-controls={adding ? panelId : undefined} onClick={() => setAdding((a) => !a)}>
            <Plus />
          </Button>
        )}
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
        <NeedsLine items={items} arrangement={arrangement} entryStyle={entryStyle} onReveal={revealRow} />
        {/* the market as it is now, so only in LIVE: in REVIEW nothing re-reads it, and a strip
            frozen at the moment the mode was entered would be read as current (ADR 0018) */}
        {mode === "live" ? <ReferenceStrip references={book.references} /> : null}
        {/* a close's account (#294): the holding has left the book, and its detail with it */}
        {/* one per close, newest first, each until its own Done: a second close never discards the
            first's account, nor a correction half typed into it */}
        {phone && settingsOpen ? null : outcomes.map((o) => (
          <ClosedResult key={o.closed.id} outcome={o} privacy={privacy} onDone={() => dismissOutcome(o.closed.id)}
                        onCorrected={() => { rereadJournal(); void book.reload(); }}
                        served={journal.trades?.find((t) => t.id === o.closed.id) ?? null} />
        ))}
        {adding && !phone ? (
          <section id={panelId} className="nx-add-panel" aria-label="adding a spread"
                   onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); closePanel(); } }}>
            <h2>Add a spread</h2>
            {addForm}
          </section>
        ) : null}
        {phone && settingsOpen ? settings : phone ? <PhoneBook {...bookProps} /> : <DeskBook {...bookProps} />}
        {mode === "review" && !phone
          ? <DeskJournal journal={journal} privacy={privacy} onCorrected={rereadJournal} onDeleted={tradeDeleted} />
          : null}
      </main>

      {phone ? (
        <TabBar mode={mode} settings={settingsOpen} adding={adding}
                onMode={(m) => { setSettingsOpen(false); pickMode(m); }}
                onAdd={() => setAdding(true)}
                onSettings={() => setSettingsOpen(true)} />
      ) : null}
      {/* mounted in both, open only on the phone, for the reason DeskSettings below is */}
      <AddSheet open={adding && phone} onClose={closeAdding} up={up} entryStyle={entryStyle}>
        {phone ? addForm : null}
      </AddSheet>
      {/* Mounted in both arrangements and only OPEN on the desk: switching to the phone with it
          open then closes it, and closing is what takes its history entry back off the stack.
          Unmounted instead, the entry stayed and the next Back press did nothing. */}
      <DeskSettings open={settingsOpen && !phone} onClose={closeSettings} up={up} entryStyle={entryStyle}>
        {phone ? null : settings}
      </DeskSettings>
      {pictured ? (
        <div ref={stageRef} className="nx-still-stage" aria-hidden="true">
          <Still {...pictured} />
        </div>
      ) : null}
      <Toaster />
    </div>
    </MonitorActionsContext.Provider>
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

/** The phone's bottom bar: Live and Review are the mode, Settings a screen of its own, and Add
 *  opens the add form as a bottom sheet over whichever is showing (#293). */
function TabBar({ mode, settings, adding, onMode, onAdd, onSettings }: {
  mode: Mode; settings: boolean; adding: boolean; onMode: (m: Mode) => void; onAdd: () => void;
  onSettings: () => void;
}) {
  const current = adding ? "add" : settings ? "settings" : mode;
  return (
    <nav className="nx-tabs" aria-label="views">
      <button type="button" aria-current={current === "live" ? "page" : undefined}
              onClick={() => onMode("live")}>Live</button>
      <button type="button" aria-current={current === "review" ? "page" : undefined}
              onClick={() => onMode("review")}>Review</button>
      <button type="button" aria-current={current === "add" ? "page" : undefined}
              onClick={onAdd}>Add</button>
      <button type="button" aria-current={current === "settings" ? "page" : undefined}
              onClick={onSettings}>Settings</button>
    </nav>
  );
}

/** The phone's Add sheet: a bottom sheet over the page, closed by Back (ADR 0023). */
function AddSheet({ open, onClose, up, entryStyle, children }: {
  open: boolean; onClose: () => void; up: UpColour; entryStyle: EntryStyle; children: React.ReactNode;
}) {
  useDismissOnBack(open, onClose);
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="nx-tokens nxp-sheet" data-up={up} data-entry={entryStyle}>
        <SheetHeader>
          <SheetTitle>Add a spread</SheetTitle>
          <SheetDescription>The spread and the Monitors it starts with, saved together.</SheetDescription>
        </SheetHeader>
        <div className="nxp-sheet-body">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

function DeskSettings({ open, onClose, up, entryStyle, children }: {
  open: boolean; onClose: () => void; up: UpColour; entryStyle: EntryStyle; children: React.ReactNode;
}) {
  useDismissOnBack(open, onClose);
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      {/* drawn in a portal OUTSIDE .nx, so it carries the page's colour tokens itself (next.css:
          .nx-tokens) and the two settings they depend on — without them every glyph was grey */}
      <SheetContent className="overflow-y-auto nx-tokens" data-up={up} data-entry={entryStyle}>
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>This screen's preferences, and where the service stands in full.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

/** Editing, closing and deleting a holding (#294), as the page sees it.
 *
 *  A holding closed or deleted here leaves the live view AT ONCE, and stays out: its id is kept and
 *  filtered from every valuation the page draws, so a poll asked before the write and answered
 *  after it cannot bring it back. Neither can return — there is no reopen (ADR 0022) — so the list
 *  only grows, by one per write.
 */
function useHoldingWrites(valued: Holding[] | null, reload: () => Promise<void>, rereadJournal: () => void) {
  const [departed, setDeparted] = useState<ReadonlySet<string>>(new Set());
  const [outcomes, setOutcomes] = useState<ClosedOutcome[]>([]);
  const holdings = useMemo(
    () => (valued === null || departed.size === 0 ? valued : valued.filter((h) => !departed.has(h.id))),
    [valued, departed],
  );
  const writes = useMemo<HoldingWrites>(() => {
    const depart = (id: string) => setDeparted((d) => new Set([...d, id]));
    return {
      // said by the inspector's or the sheet's own buttons (HoldingActions), where it was saved
      edited: () => { void reload(); },
      closed: (o) => {
        depart(o.holding.id);
        setOutcomes((all) => [o, ...all]);
        rereadJournal();
        void reload();
      },
      deleted: (h) => {
        // an OPEN holding: the journal of closed ones has nothing to read again
        depart(h.id);
        toast.add({ title: `deleted ${h.name}, with its daily samples`, type: "success" });
        void reload();
      },
    };
  }, [reload, rereadJournal]);
  const dismissOutcome = useCallback(
    (id: string) => setOutcomes((all) => all.filter((o) => o.closed.id !== id)), [],
  );
  return { holdings, writes, outcomes, dismissOutcome };
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

  // The line's answers land as the holdings' do (below): unless a NEWER one already has. A poll
  // asked before a save and answered after its reload put the saved-over rows back (#292).
  const lineAsked = useRef(0);
  const lineLanded = useRef(0);
  const loadLine = useCallback(async () => {
    const mine = ++lineAsked.current;
    const [q, m, h] = await Promise.allSettled([fetchQuotes(), fetchMonitors(), fetchHealth()]);
    if (mine < lineLanded.current) return;
    lineLanded.current = mine;
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

  // An answer lands unless a NEWER one already has. A valuation asked for by a LIVE poll can land
  // after the switch to REVIEW, which asks again, and that older answer — success or failure —
  // must not replace the newer one, or REVIEW, which does not poll, keeps it for good. Not "only
  // the latest ASK lands": with a Provider slower than the poll (OpenD's 10 s request limit
  // against a 5 s or 15 s poll) every answer has a newer ask behind it, none ever landed, and
  // the page went on drawing the last figures with no error at all.
  const asked = useRef(0);
  const landed = useRef(0);
  const loadHoldings = useCallback(async () => {
    const mine = ++asked.current;
    try {
      const valued = await fetchHoldings();
      if (mine < landed.current) return;
      landed.current = mine;
      setHoldings(valued);
      setHoldingsAt(clockTime(new Date()));
      setHoldingsError(null);
    } catch (e: unknown) {
      if (mine < landed.current) return;
      landed.current = mine;
      // CLEARED, unlike `/opt`, which keeps the rows and relies on drawing the error first: here
      // the needs-you line reads them too, and must not go on saying a Level from a valuation
      // that has since failed — nor a time it was valued at
      setHoldings(null);
      setHoldingsAt(null);
      setHoldingsError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadReferences = useCallback(
    // a backdrop never blanks the page, and an empty list takes the strip away rather than
    // leaving figures nobody can vouch for (ADR 0018)
    () => fetchReferences().then(setReferences, () => setReferences([])),
    [],
  );

  /** `rest`: the market data beyond the line, the holdings; `references` with them, which is
   *  LIVE's poll, and any change the owner made — a Reference kept or dropped in Settings must be
   *  seen to have been, in REVIEW too. */
  const load = useCallback(
    (rest: boolean, references: boolean = rest && live) => Promise.all([
      loadLine(),
      rest ? loadHoldings() : null,
      references ? loadReferences() : null,
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
      await load(true, true);
      return true;
    } catch (e: unknown) {
      toast.add({ title: e instanceof Error ? e.message : String(e), type: "error" });
      return false;
    }
  }, [load]);

  /** everything again, after the add form saved */
  const reload = useCallback(() => load(true, true), [load]);

  return {
    quotes, monitors, health, references, holdings, holdingsError, holdingsAt, error, polledAt,
    refresh, setRefresh, refreshing, refreshNow, act, loadHoldings, loadReferences,
    reload,
  };
}
