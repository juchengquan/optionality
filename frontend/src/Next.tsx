import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ClipboardCopy, ImageDown, Plus, RefreshCw, Search, Settings2 } from "lucide-react";

import "./next.css";
import {
  addReference, deleteMonitor, fetchCloses, fetchHealth, fetchHoldings, fetchMonitors, fetchPositions,
  fetchQuotes, fetchReferences,
  patchMonitor, removeReference, setTotalEntry,
  type Added, type Closes, type Entry, type Health, type Holding, type Monitor, type Reference,
} from "./shared/api";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Toaster, toast } from "@/components/ui/toast";
import { marketDay } from "./shared/format";
import { setDisplayZone, viewerClock } from "./shared/times";
import { everyHoldingValued, valuedAt, valuedStamp } from "./levels";
import { Freshness } from "./shared/Freshness";
import {
  readArrangement, readEntryStyle, readHidden, readPrivacy, readRefresh, readUp, writeArrangement,
  writeEntryStyle, writePrivacy, writeRefresh, writeUp, type ArrangementChoice, type EntryStyle, type UpColour,
} from "./shared/prefs";
import { ReferenceStrip } from "./shared/ReferenceStrip";
import { useDismissOnBack } from "./shared/useDismissOnBack";
import { AddSpread, type AddInitial } from "./AddSpread";
import { heldFromWatch } from "./add";
import { draftKeeper } from "./addKeep";
import { contractFromWatch } from "./contract";
import { takenOverBy, type Rule } from "./edit";
import { ClosedResult } from "./ClosedResult";
import type { ClosedOutcome, HoldingWrites } from "./HoldingActions";
import { arrangementFor, useViewportWidth } from "./arrangement";
import type { BookProps } from "./Book";
import { DeskBook } from "./desk/DeskBook";
import { DeskJournal } from "./desk/DeskJournal";
import { useJournal } from "./journal";
import { JournalFold } from "./JournalFold";
import { rowId, tableRows } from "./desk/columns";
import { holdOnDesk, NOTHING_SELECTED, type DeskSelection } from "./desk/keys";
import { MonitorActionsContext, type MonitorActions } from "./MonitorEdit";
import { PhoneBook } from "./phone/PhoneBook";
import { PhoneJournal } from "./phone/PhoneJournal";
import { marketPhase, servedWhen, sessionEdge, useSessionClock } from "./session";
import { withCloses, withLastKnown } from "./lastknown";
import { NeedsLine, reveal } from "./NeedsLine";
import { needsYou } from "./needs";
import { UnreadableHoldings } from "./UnreadableHoldings";
import { Palette, paletteShortcut, type Chosen } from "./Palette";
import { findables, HOLD_WHY, paletteActions } from "./commands";
import { placeBook } from "./placement";
import { beingOperated, givenUpAfter, skipWhileOut } from "./poll";
import { Settings } from "./Settings";
import { Still, type StillProps } from "./snapshot/Still";
import { useSaveImage } from "./snapshot/useSaveImage";
import { copyView } from "./snapshot/copyText";
import { plainError, rawError } from "./shared/errors";
import { ErrorWords } from "./shared/ErrorWords";

/** The dashboard, at `/opt` (ADR 0023): built at `/opt/next` beside the page before it from #287,
 *  and the only page since the swap (#301).
 *
 *  A shell: the arrangement, the colours, the needs-you line and Settings, around the book — the
 *  desk's table or the phone's cards. Arrangements are state, never routes (ADR 0005), so this is
 *  one page whichever is showing.
 *
 *  ONE page at every hour, with no switch (ADR 0023, amended 2026-11-13: one page, by the
 *  session; #371–#375). What it draws is the same in session and out of it — the desk's one column
 *  set, the phone's cards, the closed trades folded at the bottom of the book. New York's
 *  session decides only: what it FETCHES; the market-closed line; whether a figure says when it
 *  was read; what the needs-you line states (holdings' Levels only in session); whether a
 *  holding's history starts open (outside it), in the inspector and the phone's sheet; and the
 *  saved picture's header. `session` is computed here, once, and handed to everything that asks.
 */
export function Next() {
  const [up, setUp] = useState(readUp);
  const [entryStyle, setEntryStyle] = useState(readEntryStyle);
  const [privacy, setPrivacy] = useState(readPrivacy);
  const [choice, setChoice] = useState(readArrangement);
  const width = useViewportWidth();
  const arrangement = arrangementFor(width, choice);
  const phone = arrangement === "phone";

  // On the document as well as the page: a dialog or a toast is drawn in a portal outside `.nx`,
  // and on a phone its buttons need the same 44pt targets (next.css).
  useEffect(() => {
    document.documentElement.dataset.nxArrangement = arrangement;
    return () => { delete document.documentElement.dataset.nxArrangement; };
  }, [arrangement]);

  // New York's session, read off the clock every 15 s and on coming back into view: what the page
  // fetches and what the needs-you line says follow it, and nothing else does (#371).
  const now = useSessionClock();
  // ...and which of SPX options' sessions (#416): the page polls in the regular one, the Curb and
  // GTH alike, since SPX options trade in all three and the holdings are valued live where quoted;
  // only while nothing trades is the book valued once. `session` is that: whether the page polls
  const phase = marketPhase(now);
  const session = phase !== "closed";
  // and WHICH session it is in or after: a tab asleep from Monday 20:00 to Tuesday 20:00 New York
  // reads `false` at both ends, and must still value the book again when it wakes
  const edge = sessionEdge(now).getTime();

  const book = useBook(session, edge, phase === "regular");
  // the picture (#300): the press, and the page's figures as they were at it — the off-screen tree
  // is drawn from that copy, so a poll landing mid-capture cannot make one picture two moments
  const { frame: pictured, stageRef, save } = useSaveImage<StillProps>();
  const shooting = pictured !== null;
  // the closed trades (#296), folded at the bottom of the book (#373): shut on every load, read
  // the first time the fold is opened and then after each write that changes them — a close, a
  // correction, a delete — whether it is open or shut by then; never polled, in session or out.
  // A write made before the fold was ever opened reads nothing: the first opening reads it all
  const [journalOpen, setJournalOpen] = useState(false);
  const [journalOpened, setJournalOpened] = useState(false);
  const [journalAsk, setJournalAsk] = useState(0);
  const journal = useJournal(journalOpened, journalAsk);
  // opened again on nothing but a failed read, it asks again: the latch would otherwise leave
  // "could not be read" there until some write. Rows it has, even beside an error, ask nothing
  const journalFailed = journal.trades === null && journal.error !== null;
  const toggleJournal = useCallback(() => {
    if (!journalOpen && journalFailed) setJournalAsk((n) => n + 1);
    setJournalOpen(!journalOpen);
    setJournalOpened(true);
  }, [journalOpen, journalFailed]);
  const rereadJournal = useCallback(() => setJournalAsk((n) => n + 1), []);
  // a closed trade deleted from the journal leaves it at once, and the re-read says the rest
  const { drop: dropTrade } = journal;
  const tradeDeleted = useCallback((id: string) => { dropTrade(id); rereadJournal(); }, [dropTrade, rereadJournal]);
  const { holdings, holdingsKept, unreadable, writes, outcomes, dismissOutcome } =
    useHoldingWrites(book.holdings, book.holdingsKept, book.reload, rereadJournal);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  // Settings' Back entry is the PAGE's, held for as long as Settings is open, whichever sheet draws
  // it (#410): the arrangement is switched from inside it, and with an entry per sheet the desk's
  // side sheet took one as the phone's bottom sheet gave its own up — the browser's back() runs
  // later, went one entry further than meant, and the next close then left the dashboard
  useDismissOnBack(settingsOpen, closeSettings);
  // adding a spread or a contract (#293, #331; named for both since #301): a side sheet on the desk,
  // as Settings is, and a bottom sheet on the phone — opened from the header's "add" on both since #410
  const [adding, setAddingNow] = useState(false);
  // what the form opens with: a fresh draft, or one prefilled by "Record as held" (#408) — numbered,
  // so a second prefill while the form is open draws a new form rather than keeping the last one's
  const [prefill, setPrefill] = useState<{ n: number; initial: AddInitial } | null>(null);
  // ...and what has been typed into it, kept here so a switch of arrangement, which draws the form
  // anew in the other sheet, carries it over; emptied whenever the form opens or closes (addKeep.ts)
  const [addKeeper] = useState(draftKeeper);
  // ...and whether its save is out, for the same reason: the form drawn anew mid-save must not send it again
  const addSaving = useState(false);
  const [, setAddSaving] = addSaving;
  // the button that opened the sheet: a rule's "Record as held" (#408), or null for "+"
  const opener = useRef<HTMLElement | null>(null);
  const setAdding = useCallback((open: boolean) => {
    if (open) opener.current = null;
    addKeeper.clear();
    setAddSaving(false);
    setAddingNow(open);
    setPrefill(null);
  }, [addKeeper, setAddSaving]);
  const panelId = useId();
  // the Add sheet is described by its form's footer (2026-11-16), where a subtitle repeated its title
  const addSaysId = useId();
  const plusButton = useRef<HTMLButtonElement>(null);
  const closeAdding = useCallback(() => setAdding(false), [setAdding]);
  // the Add sheet's Back entry is the page's too, as Settings' is: the desk's side sheet and the
  // phone's bottom sheet are one Add, kept across a switch of arrangement
  useDismissOnBack(adding, closeAdding);
  // the desk's sheet hands the focus back to what opened it when it goes, by Escape, Cancel or Save
  const addReturn = useCallback(
    () => (opener.current?.isConnected ? opener.current : plusButton.current), [],
  );
  const { reload } = book;
  const saved = useCallback((added: Added) => {
    setAdding(false);
    opener.current = null;
    // what was made, in rows; never a count of contracts, which privacy hides
    const made = [
      added.positions.length ? `${added.positions.length} holding${added.positions.length === 1 ? "" : "s"}` : null,
      `${added.monitors.length} rule${added.monitors.length === 1 ? "" : "s"}`,
    ].filter(Boolean).join(" and ");
    const r = added.replaced.length;
    const title = `added ${made}${r ? `, replacing ${r} watch rule${r === 1 ? "" : "s"}` : ""}`;
    plusButton.current?.focus();
    if (added.positions.length === 0) {
      toast.add({ title, type: "success" });
      void reload();
      return;
    }
    // what the holdings took over besides, as the service now links it — read back, never the
    // form's prediction (#408)
    void reload().then(() => fetchMonitors()).then((after) => {
      const taken = takenOverBy(added, after);
      toast.add({ title: taken.length ? `${title}; also linked to ${added.positions.length === 1 ? "it" : "them"}: ${taken.join(", ")}` : title, type: "success" });
    }, () => toast.add({ title, type: "success" }));
  }, [reload, setAdding]);
  // editing a Monitor in place (#292): each write then the page as the service now tells it, its
  // refusal thrown back to the form that sent it rather than toasted underneath it
  const retentionDays = book.health?.settings.expired_retention_days ?? null;
  // a total entry split across a rule's holdings (#336), by the route the old page used; and a watch
  // rule recorded as held (#408), by the add form, prefilled from it, over the inspector or the sheet
  const ruleMonitors = book.monitors;
  const monitorsNow = useRef(ruleMonitors);
  monitorsNow.current = ruleMonitors;
  const holdingsNow = useRef(holdings);
  holdingsNow.current = holdings;
  const recordAsHeld = useCallback((rule: Rule, served: Entry | null, from: HTMLElement | null) => {
    const open = (initial: AddInitial) => {
      opener.current = from;
      addKeeper.clear();
      setAddingNow(true);
      setPrefill((p) => ({ n: (p?.n ?? 0) + 1, initial }));
    };
    const today = marketDay();
    // a spread's legs, signed and with their quantities (#351): `/monitors`' where it has been read,
    // or the row's own from `/quotes`, which carries them too
    const legs = monitorsNow.current.find((m) => m.id === rule.id)?.legs ?? served?.legs ?? null;
    if (rule.combo && !legs) {
      toast.add({ title: `${rule.name}'s legs are not read yet: try again in a moment`, type: "error" });
      return;
    }
    // every holding's name on record, closed ones too, which the new one's may not be; where that
    // cannot be read, the open ones the page has
    void fetchPositions().then((all) => all.map((p) => p.name))
      .catch(() => (holdingsNow.current ?? []).map((h) => h.name))
      .then((names) => {
        if (rule.combo && legs) {
          open({ kind: "spread", draft: heldFromWatch({ code: rule.code, strike_date: rule.strike_date, legs }, today), taken: names });
          return;
        }
        const draft = contractFromWatch(rule, today, names);
        if (draft) open({ kind: "contract", draft });
      });
  }, [addKeeper]);
  const monitorActions = useMemo<MonitorActions>(() => ({
    patch: async (id, body) => { await patchMonitor(id, body as Record<string, unknown>); await reload(); },
    remove: async (id) => { await deleteMonitor(id); await reload(); },
    totalEntry: async (id, entry) => { await setTotalEntry(id, entry); await reload(); },
    recordAsHeld,
    book: { monitors: ruleMonitors, holdings, privacy },
    retentionDays,
  }), [reload, retentionDays, ruleMonitors, holdings, privacy, recordAsHeld]);
  // the preview's SPX marker: the book's last batch's derived price, never a Reference's (ADR 0024)
  const priced = book.quotes.find((q) => q.spx !== null) ?? book.holdings?.find((h) => h.spx !== null);
  const spx = priced?.spx ?? null;
  // ...with its reason beside it where it is not current, outside the regular session (#416)
  const spxReason = priced ? priced.spx_reason ?? null : book.quotes[0]?.spx_reason ?? book.holdings?.[0]?.spx_reason ?? null;
  const addForm = (
    <AddSpread key={prefill?.n ?? 0} initial={prefill?.initial} privacy={privacy} monitors={book.monitors}
               holdings={holdings} spx={spx}
               spxReason={spxReason} onSaved={saved} onCancel={closeAdding} autoFocus={!phone} footerId={addSaysId}
               keeper={addKeeper} savingState={addSaving} />
  );

  // Settings is the one surface that may say "nothing needs you" (ADR 0012), and where References
  // are kept or dropped. In session both are polled already; outside it neither is, so opening
  // Settings there asks for them afresh — otherwise they are as old as the last valuation. The
  // session is read through a ref: a change of session with Settings open asks for them anyway,
  // and must not ask twice.
  const { loadHoldings, loadReferences } = book;
  const sessionNow = useRef(session);
  sessionNow.current = session;
  useEffect(() => {
    if (settingsOpen && !sessionNow.current) void Promise.all([loadHoldings(), loadReferences()]);
  }, [settingsOpen, loadHoldings, loadReferences]);

  // the page's header is held at the top of the screen (#410): its height, on the document, so
  // that a row brought into view — by a banner, the palette, j and k, a sheet's closing — lands
  // below it (next.css: scroll-padding-top), and what sticks under it sticks at its bottom edge
  const header = useHeaderHeight();

  // The desk's selection, kept here so the palette (#299) can read it and land on a row; the table
  // moves it itself, by a click, j and k, or the price map.
  const deskSelection = useState<DeskSelection>(NOTHING_SELECTED);
  const [desk, setDesk] = deskSelection;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const requests = useRef(0);
  // out of the session a price rule has no figure; its last known one, read in the session, is said
  // beside the dash (#380, lastknown.ts)
  // and each row's last close (#402), which is its value wherever there is no live one: out of the
  // session, and while /quotes is failing, whose rows are then the last ones read
  const quotes = useMemo(
    () => withLastKnown(withCloses(book.quotes, book.closes), book.monitors,
      book.quotesFailed || !session ? "close" : phase === "regular" ? "live" : "live-or-close"),
    [book.quotes, book.closes, book.monitors, session, phase, book.quotesFailed],
  );
  const placed = useMemo(() => placeBook(quotes, holdings, book.monitors), [quotes, holdings, book.monitors]);
  const found = useMemo(() => findables(placed), [placed]);
  const selectedRow = useMemo(
    () => (desk.id === null ? null : tableRows(placed).find((r) => rowId(r) === desk.id) ?? null), [placed, desk.id],
  );
  // a form open on the desk, read as the palette opens: while one holds, the palette lands on
  // nothing and opens no other form, as j and k move nothing (desk/keys.ts)
  const hold = useMemo(() => (paletteOpen ? holdOnDesk(document.querySelector(".nxd")) : null), [paletteOpen]);
  const autoIsPhone = arrangementFor(width, "auto") === "phone";
  const actions = useMemo(
    () => paletteActions({ choice, selected: selectedRow, hold, autoIsPhone }),
    [choice, selectedRow, hold, autoIsPhone],
  );
  // the desk's selection is the desk's: the phone has none, and coming back to the desk must not
  // reopen an inspector on a row picked before it went
  useEffect(() => { if (phone) setDesk(NOTHING_SELECTED); }, [phone, setDesk]);
  const chooseArrangement = useCallback((v: ArrangementChoice) => { setChoice(v); writeArrangement(v); }, []);
  // the clipboard is granted only inside the gesture (Safari): copied in the pick, not after the close
  const runNow = useCallback((c: Chosen) => {
    if (!("action" in c) || c.action.key !== "copy-text") return false;
    copyViewNow.current();
    return true;
  }, []);
  const runChosen = useCallback((c: Chosen) => {
    const land = (id: string, then: "inspect" | "edit" | "close") =>
      setDesk({ id, open: true, request: { n: ++requests.current, then } });
    if ("find" in c) {
      if (c.find.kind === "muted rule" || c.find.kind === "expired rule") landOnMuted(c.find.ref);
      else land(c.find.ref, "inspect");
      return;
    }
    const a = c.action;
    if (a.key === "add") {
      if (!adding) { setAdding(true); return; }
      document.getElementById(panelId)?.querySelector<HTMLElement>("input, select, textarea")?.focus();
    } else if (a.key === "edit-monitor" && desk.id !== null) land(desk.id, "edit");
    else if (a.key === "close-holding" && desk.id !== null) land(desk.id, "close");
    else if (a.key === "save-image") saveViewNow.current();
    else if (a.key === "arrange-desk") chooseArrangement("desk");
    else if (a.key === "arrange-phone") {
      chooseArrangement("phone");
      // the phone has no palette, so the way back is said where it will be seen
      toast.add({ title: "the phone arrangement: Settings switches it back", type: "success" });
    }
    else if (a.key === "arrange-auto") chooseArrangement("auto");
  }, [adding, panelId, desk.id, setDesk, chooseArrangement]);
  const shortcut = paletteShortcut();

  // the line uses only what is polled (ADR 0012): holdings are polled in session and valued once
  // outside it, so outside it the line says no holding's Levels — not even through a rule linked
  // to one, whose schedule `/quotes` serves (#354, re-keyed to the session by #371): each holding's
  // chip says them, "as valued at", and the market-closed line says when. The book is still DRAWN
  // with them outside the session, so they still say which combos are drawn apart (#346)
  const items = useMemo(
    () => needsYou(quotes, book.monitors, book.health, session ? holdings : null, holdings, session, unreadable),
    [quotes, book.monitors, book.health, holdings, session, unreadable],
  );
  const everything = useMemo(
    () => needsYou(quotes, book.monitors, book.health, holdings, holdings, true, unreadable),
    [quotes, book.monitors, book.health, holdings, unreadable],
  );

  // one set of props for either arrangement's book: each draws `placeBook` of these (placement.ts)
  const bookProps: BookProps = {
    quotes, monitors: book.monitors, holdings, holdingsKept,
    holdingsError: book.holdingsError, holdingsAt: book.holdingsAt, holdingsServed: book.holdingsServed, session, phase, privacy, entryStyle, writes,
    journal: (
      <JournalFold open={journalOpen} onToggle={toggleJournal}
                   ready={journal.trades !== null || journal.error !== null}>
        {phone
          ? <PhoneJournal journal={journal} privacy={privacy} entryStyle={entryStyle} onCorrected={rereadJournal}
                          onDeleted={tradeDeleted} />
          : <DeskJournal journal={journal} privacy={privacy} onCorrected={rereadJournal} onDeleted={tradeDeleted} />}
      </JournalFold>
    ),
  };

  const settings = (
    <Settings
      up={up} onUp={(v) => { setUp(v); writeUp(v); }}
      entryStyle={entryStyle} onEntryStyle={(v) => { setEntryStyle(v); writeEntryStyle(v); }}
      privacy={privacy} onPrivacy={(v) => { setPrivacy(v); writePrivacy(v); }}
      choice={choice} onChoice={chooseArrangement}
      refresh={book.refresh} onRefresh={(n) => { book.setRefresh(n); writeRefresh(n); }}
      health={book.health} needs={everything}
      complete={everyHoldingValued(holdings, book.holdingsError)}
      holdingsAt={book.holdingsAt}
      references={book.references} referencesPending={book.referencesPending}
      onAddReference={(body) => book.act(() => addReference(body))}
      onRemoveReference={(id) => void book.act(() => removeReference(id))}
    />
  );

  // the picture (#300) and its text (#394), from the header's buttons and the palette alike: one
  // view of the book as it stands at the press — without the closed trades, since a journal is not
  // the book — with every column the viewer ticked and the moment it was taken
  const viewNow = (): StillProps => ({
    quotes: bookProps.quotes, monitors: bookProps.monitors, holdings: bookProps.holdings,
    holdingsError: bookProps.holdingsError, holdingsAt: bookProps.holdingsAt, holdingsServed: bookProps.holdingsServed,
    session: bookProps.session, phase: bookProps.phase, privacy: bookProps.privacy, needs: items, health: book.health, polledAt: book.polledAt,
    error: book.error, references: book.references, hidden: readHidden(), takenAt: new Date(),
  });
  const saveView = () => void save(viewNow());
  // built and written inside the press: Safari grants the clipboard only while the gesture runs
  const copyText = () => void copyView(viewNow());
  const copyViewNow = useRef(copyText);
  copyViewNow.current = copyText;
  const saveViewNow = useRef(saveView);
  saveViewNow.current = saveView;

  return (
    <MonitorActionsContext.Provider value={monitorActions}>
    <div className="nx" data-arrangement={arrangement} data-up={up}
         data-entry={entryStyle}>
      {/* held at the top while the page scrolls, on both arrangements, clear of the notch (#410) */}
      <header ref={header} className="nx-head">
        <h1>optionality</h1>
        <span className="nx-spacer" />
        <Button variant="ghost" size="sm" aria-label="save as image" disabled={shooting}
                onClick={saveView}>
          <ImageDown className={shooting ? "animate-pulse" : undefined} />
        </Button>
        <Button variant="ghost" size="sm" aria-label="copy as text" onClick={copyText}>
          <ClipboardCopy />
        </Button>
        <Button variant="ghost" size="sm" aria-label="refresh now" disabled={book.refreshing}
                onClick={() => void book.refreshNow()}>
          <RefreshCw className={book.refreshing ? "animate-spin" : undefined} />
        </Button>
        {phone ? null : (
          <Button variant="ghost" size="sm" className="nx-palette-open" aria-label={`find and act (${shortcut.shown})`}
                  aria-keyshortcuts={shortcut.aria} aria-haspopup="dialog" onClick={() => setPaletteOpen(true)}>
            <Search /><kbd aria-hidden="true">{shortcut.shown}</kbd>
          </Button>
        )}
        {/* Add and Settings on the phone too since #410, where they were tabs of a bar along the
            bottom: each opens its bottom sheet there, and the desk's panel and side sheet here */}
        <Button ref={plusButton} variant="ghost" size="sm" aria-label="add" aria-haspopup="dialog"
                onClick={() => setAdding(true)}>
          <Plus />
        </Button>
        <Button variant="ghost" size="sm" aria-label="settings" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)}>
          <Settings2 />
        </Button>
      </header>

      <main className="nx-main">
        {book.error ? (
          <div className="nx-banner" role="alert">
            {"the figures could not be refreshed — "}
            <ErrorWords raw={book.errorRaw ?? ""} again="tried again at the next poll" />
          </div>
        ) : null}
        <Freshness fetchedAt={book.health?.monitor.fetched_at ?? null} polledAt={book.polledAt}
                   sweepSeconds={book.health?.settings.sweep_seconds ?? null} />
        <NeedsLine items={items} arrangement={arrangement} entryStyle={entryStyle} onReveal={reveal} />
        {/* the market, at every hour (#371): polled in session; outside it read once with the
            holdings, and every reading says when — a figure frozen at a read would otherwise be
            taken for current (ADR 0018) */}
        <ReferenceStrip references={book.references} timeOf={session ? undefined : servedWhen} />
        {/* a close's account (#294): the holding has left the book, and its detail with it */}
        {/* one per close, newest first, each until its own Done: a second close never discards the
            first's account, nor a correction half typed into it */}
        {outcomes.map((o) => (
          <ClosedResult key={o.closed.id} outcome={o} privacy={privacy} onDone={() => dismissOutcome(o.closed.id)}
                        onCorrected={() => { rereadJournal(); void book.reload(); }}
                        served={journal.trades?.find((t) => t.id === o.closed.id) ?? null} />
        ))}
        <UnreadableHoldings rows={unreadable} onDeleted={writes.deleted} />
        {phone ? <PhoneBook {...bookProps} /> : <DeskBook {...bookProps} selection={deskSelection} />}
      </main>

      {/* the phone's two sheets over the book, one component (#410): mounted in both arrangements
          and open only on the phone, for the reason the desk's below are */}
      <PhoneSheet open={adding && phone} onClose={closeAdding} up={up} entryStyle={entryStyle}
                  title="Add" titleMore="a spread or contract" describedBy={addSaysId}>
        {phone ? addForm : null}
      </PhoneSheet>
      <PhoneSheet open={settingsOpen && phone} onClose={closeSettings} up={up} entryStyle={entryStyle}
                  title="Settings" description={SETTINGS_SAYS}>
        {phone ? settings : null}
      </PhoneSheet>
      {/* Mounted in both arrangements and only OPEN on the desk; their Back entries are the page's,
          kept across a switch of arrangement (above) */}
      <DeskSheet id={panelId} open={adding && !phone} onClose={closeAdding} finalFocus={addReturn}
                 up={up} entryStyle={entryStyle} title="Add" titleMore="a spread or contract" describedBy={addSaysId} className="data-[side=right]:sm:max-w-3xl">
        {phone ? null : addForm}
      </DeskSheet>
      <DeskSheet open={settingsOpen && !phone} onClose={closeSettings} up={up} entryStyle={entryStyle}
                 title="Settings" description={SETTINGS_SAYS}>
        {phone ? null : settings}
      </DeskSheet>
      {pictured ? (
        <div ref={stageRef} className="nx-still-stage" aria-hidden="true">
          <Still {...pictured} />
        </div>
      ) : null}
      {/* the desk's alone: the phone registers no chord and no keys (ADR 0023, #299) */}
      {phone ? null : (
        <Palette open={paletteOpen} onOpenChange={setPaletteOpen} found={found} findWhy={hold === null ? null : HOLD_WHY} actions={actions}
                 onChoose={runChosen} onChooseNow={runNow} up={up} entryStyle={entryStyle} />
      )}
      <Toaster />
    </div>
    </MonitorActionsContext.Provider>
  );
}

/** A muted or expired rule found by the palette, landed on where it is listed: the folded list
 *  opened, the rule brought into view and focused. */
function landOnMuted(id: string) {
  const folded = document.querySelector<HTMLDetailsElement>("details.nxd-muted");
  const listed = [...(folded?.querySelectorAll<HTMLElement>("li[data-ref]") ?? [])].find((li) => li.dataset.ref === id);
  if (!folded || !listed) return;
  folded.open = true;
  listed.tabIndex = -1;
  listed.scrollIntoView?.({ block: "nearest" });
  listed.focus();
}

/** What Settings says it is, on the desk's side sheet and the phone's bottom sheet alike. */
const SETTINGS_SAYS = "This screen's preferences, and where the service stands in full.";

/** The header's height, kept on the document as `--nx-head-h` while the page is drawn (#410): the
 *  header is sticky, so a row scrolled into view has to land below it (`scroll-padding-top` on the
 *  document, next.css), and the desk's column heads and inspector stick at its bottom edge. Measured
 *  rather than assumed: the safe area's top, the arrangement and the text size all move it. */
function useHeaderHeight() {
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => () => {
    observer.current?.disconnect();
    document.documentElement.style.removeProperty("--nx-head-h");
  }, []);
  return useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const keep = () => document.documentElement.style.setProperty("--nx-head-h", `${el.getBoundingClientRect().height}px`);
    keep();
    // jsdom has none, and lays nothing out to measure
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(keep);
    observer.current.observe(el);
  }, []);
}

/** What a sheet says it is: a subtitle under its title (Settings'), or, where a subtitle would only
 *  repeat the title, the id of something inside it that says it (the Add form's footer, 2026-11-16). */
type Described = { description: string; describedBy?: undefined } | { description?: undefined; describedBy: string };

/** A bottom sheet over the phone's book, closed by Back (ADR 0023): the Add form's since #293, and
 *  Settings' since #410, where Settings had been a screen in the book's place. One component, so the
 *  two open and close alike. Their Back entries are the page's (`useDismissOnBack`, one list for
 *  every sheet the page opens, #408), kept across a switch between this sheet and the desk's. */
function PhoneSheet({ open, onClose, up, entryStyle, title, titleMore, description, describedBy, children }: {
  open: boolean; onClose: () => void; up: UpColour; entryStyle: EntryStyle;
  title: string; children: React.ReactNode;
  /** the rest of the dialog's name, said to a reader only: Add's visible title is "Add", its first
   *  control saying "a spread / one contract", and its name "Add a spread or contract" (2026-11-17) */
  titleMore?: string;
} & Described) {
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="nx-tokens nxp-sheet" data-up={up} data-entry={entryStyle}
                    aria-describedby={describedBy}>
        <SheetHeader>
          <SheetTitle>{titleMore ? `${title} ` : title}{titleMore ? <span className="sr-only">{titleMore}</span> : null}</SheetTitle>
          {description !== undefined ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <div className="nxp-sheet-body">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

/** A side sheet over the desk's book: Settings', and the Add form's, which was a panel above the
 *  table until it became one like Settings'. */
function DeskSheet({ id, open, onClose, finalFocus, up, entryStyle, title, titleMore, description, describedBy, className, children }: {
  id?: string; open: boolean; onClose: () => void; finalFocus?: () => HTMLElement | null;
  up: UpColour; entryStyle: EntryStyle;
  title: string; className?: string; children: React.ReactNode;
  /** as `PhoneSheet`'s */
  titleMore?: string;
} & Described) {
  // its Back entry is held by the page (Next), across a switch of arrangement
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      {/* drawn in a portal OUTSIDE .nx, so it carries the page's colour tokens itself (next.css:
          .nx-tokens) and the two settings they depend on — without them every glyph was grey */}
      <SheetContent id={id} finalFocus={finalFocus} className={`overflow-y-auto nx-tokens ${className ?? ""}`} data-up={up} data-entry={entryStyle}
                    aria-describedby={describedBy}>
        <SheetHeader>
          <SheetTitle>{titleMore ? `${title} ` : title}{titleMore ? <span className="sr-only">{titleMore}</span> : null}</SheetTitle>
          {description !== undefined ? <SheetDescription>{description}</SheetDescription> : null}
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
function useHoldingWrites(
  valued: Holding[] | null, keptValued: Holding[] | null, reload: () => Promise<void>, rereadJournal: () => void,
) {
  const [departed, setDeparted] = useState<ReadonlySet<string>>(new Set());
  const [outcomes, setOutcomes] = useState<ClosedOutcome[]>([]);
  // a holding the service could not read (#422) is no row of the book: it has no legs and no figures.
  // It is listed apart, and named in the needs-you line
  const holdings = useMemo(
    () => (valued === null ? null : valued.filter((h) => !h.unreadable && !departed.has(h.id))),
    [valued, departed],
  );
  const unreadable = useMemo(
    () => (valued ?? []).filter((h) => h.unreadable && !departed.has(h.id)),
    [valued, departed],
  );
  // ...and the last valuation kept through a failure: never one closed or deleted here
  const holdingsKept = useMemo(
    () => (keptValued === null ? null : keptValued.filter((h) => !h.unreadable && !departed.has(h.id))),
    [keptValued, departed],
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
  return { holdings, holdingsKept, unreadable, writes, outcomes, dismissOutcome };
}

/** What the page reads, and when: by New York's session, and by nothing else on screen (#371; ADR
 *  0023 amended 2026-11-13).
 *
 *  The LINE's inputs — the watchlist, the rules and health — are polled at every hour: the
 *  needs-you line carries every alarm and every fault, and a line can only do that if what it
 *  reads keeps coming. Each is read on its own, so a Provider outage that fails `/quotes` still
 *  lets health say so and the rules' quarantines through.
 *
 *  Beyond the line, IN SESSION the poll also asks for the holdings' valuation and the References:
 *  three market-data calls per poll where the old page made two (ADR 0010), the cost of holdings
 *  leading the page; with nothing held the valuation asks the Provider nothing. OUTSIDE the
 *  session both are asked ONCE — on opening, at each edge of the session, and by a refresh — and
 *  the poll asks only for the line.
 *
 *  @param edge the session's last edge (`sessionEdge`), as a number: what the one-off read is keyed
 *  on, so ANY open or close passed — while the tab was awake, or slept through with its timers
 *  suspended and noticed when it comes back into view (`useSessionClock`) — values the book again.
 */
function useBook(session: boolean, edge: number, regular: boolean) {
  const [quotes, setQuotes] = useState<Entry[]>([]);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [references, setReferences] = useState<Reference[]>([]);
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [holdingsError, setHoldingsError] = useState<string | null>(null);
  const [holdingsAt, setHoldingsAt] = useState<string | null>(null);
  const [holdingsServed, setHoldingsServed] = useState<string | null>(null);
  // the last valuation that succeeded, kept through the failures after it for the one holding open
  // in the inspector or the sheet (`kept.ts`); the book never draws it
  const [lastValued, setLastValued] = useState<Holding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // what was thrown, as thrown: the banner's title, beside its plain words (part N)
  const [errorRaw, setErrorRaw] = useState<string | null>(null);
  const [polledAt, setPolledAt] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(15);
  const [refreshing, setRefreshing] = useState(false);
  const [pollFrom, setPollFrom] = useState(0);
  // each rule's last close (#402), and whether the last read of /quotes failed: out of the session,
  // and through a Provider outage, a watched row's value is its last close, read apart from /quotes
  // so it answers while /quotes cannot
  const [closes, setCloses] = useState<Closes>([]);
  const [quotesFailed, setQuotesFailed] = useState(false);
  // the regular session's, where every value is live: outside it — the Curb and GTH included, where
  // a row with no quote says its last close (#416) — the closes are read with every poll of the line
  const regularNow = useRef(regular);
  regularNow.current = regular;
  // ONE read at a time, and a failed one keeps the closes there were: they are stored history
  const [loadCloses] = useState(() => oneAtATime(
    // an answer that is not the list is no closes, never a crash of the page that reads it
    () => fetchCloses().then((c) => setCloses(Array.isArray(c) ? c : [])).catch(() => undefined),
  ));

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
    setQuotesFailed(q.status === "rejected");
    // the closes at every hour the value cell says them: out of the session, and while /quotes fails
    if (!regularNow.current || q.status === "rejected") void loadCloses();
    if (m.status === "fulfilled") setMonitors(m.value);
    // DISPLAY_TZ by name for every clock the page writes (part F), before "screen updated" is said
    if (h.status === "fulfilled") { setDisplayZone(h.value.settings.display_tz); setHealth(h.value); }
    const failed = [q, m, h].find((r) => r.status === "rejected");
    if (failed) {
      // the page still renders when the service is unhappy; this says the figures are stale and
      // stays up until a poll succeeds
      const why: unknown = failed.reason;
      setError(`the figures could not be refreshed — ${plainError(why, "tried again at the next poll")}`);
      setErrorRaw(rawError(why));
    } else {
      // only when everything arrived: "screen updated" is a claim about the figures
      setPolledAt(viewerClock(new Date()));
      setError(null);
      setErrorRaw(null);
    }
  }, [loadCloses]);

  // An answer lands unless a NEWER one already has. A valuation asked for by the session's last
  // poll can land after the close, which asks again, and that older answer — success or failure —
  // must not replace the newer one, or the page, which does not poll it after the close, keeps it
  // for good. Not "only
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
      setLastValued(valued);
      // the service's own stamp, as each chip reads it (#354): one clock, whatever the device's zone.
      // None where the answer carries none — nothing held — rather than the device's clock in its
      // place: the market-closed line then says no time (#371)
      setHoldingsAt(valuedAt(valued));
      setHoldingsServed(valuedStamp(valued));
      setHoldingsError(null);
    } catch (e: unknown) {
      if (mine < landed.current) return;
      landed.current = mine;
      // CLEARED, unlike the old page, which kept the rows and relied on drawing the error first: here
      // the needs-you line reads them too, and must not go on saying a Level from a valuation
      // that has since failed — nor a time it was valued at
      setHoldings(null);
      setHoldingsAt(null);
      setHoldingsServed(null);
      // what was thrown, said plainly where it is drawn, the raw one tap away (part N)
      setHoldingsError(rawError(e));
    }
  }, []);

  // A backdrop never blanks the page, and an empty list takes the strip away rather than leaving
  // figures nobody can vouch for (ADR 0018). ONE call at a time (`oneAtATime`): a source that
  // accepts and never answers costs the whole 8 s request timeout (#308), and nothing here waits
  // for it, so every poll, press and save would otherwise stack another call against it.
  const [loadReferences] = useState(() => oneAtATime(
    () => fetchReferences().catch(() => [] as Reference[]).then(setReferences),
  ));
  // a keep or drop in Settings until a read that started after it has landed: the list it shows
  // until then is from before the write, and a second press would make the same change twice
  const [referencesPending, setReferencesPending] = useState(0);

  /** `rest`: the market data beyond the line, the holdings; `references` with them unless said
   *  otherwise — the session's poll, the one valuation outside it, a refresh, and any change the
   *  owner made: a Reference kept or dropped in Settings must be seen to have been, at any hour.
   *
   *  The References are ASKED here and never awaited (#335, as the old page did since #308): what this
   *  returns settles when the line and the holdings land, so a save, a refresh or a poll finishes
   *  on its own reads and the strip catches up when its slowest source answers. Awaited, a mute
   *  said "saving…" for the whole of a silent source's 8 s. */
  const load = useCallback(
    (rest: boolean, references: boolean = rest) => {
      if (references) void loadReferences();
      return Promise.all([loadLine(), rest ? loadHoldings() : null]).then(() => undefined);
    },
    [loadLine, loadHoldings, loadReferences],
  );

  // everything once on opening and at every edge of the session: the open starts the poll of it, the
  // close is when the page values the book the last time it will without being asked, and an edge
  // slept through is one the page woke after (#371's review: keyed on `session` alone, a tab asleep
  // from one evening to the next read false at both ends and was never valued again)
  // ...and the closes then too (#402), so a spread watched on its delta has its payoff's close in the
  // session, where the poll does not read them while /quotes answers
  useEffect(() => { void load(true); void loadCloses(); }, [load, edge, loadCloses]);

  // the viewer's cadence if chosen, the service's sweep if not (prefs.readRefresh)
  useEffect(() => {
    if (health) setRefresh(readRefresh(health.settings.sweep_seconds));
  }, [health]);

  // The poll's reads, each SKIPPED by a tick while the last one it asked is still out
  // (`skipWhileOut`): with a Provider slower than the poll — OpenD's 10 s request limit against a
  // 5 s or 15 s poll — every tick otherwise stacked another /quotes and another valuation against
  // it (ADR 0010: a poll is not free). Only the poll's: a refresh, a save or an edge of the session
  // still asks afresh, for a read that started after it, and the newer answer still wins (above).
  // ...for at most two polls' worth, and never less than a minute — far past the service's own
  // bounded vendor calls (OpenD's 10 s, a Reference's 8 s): one read that never settles must not
  // stop the poll for good
  const cadence = useRef(refresh);
  cadence.current = refresh;
  const [pollLine] = useState(() => skipWhileOut(loadLine, () => givenUpAfter(cadence.current)));
  const [pollHoldings] = useState(() => skipWhileOut(loadHoldings, () => givenUpAfter(cadence.current)));

  useEffect(() => {
    const id = setInterval(() => {
      // the line at every hour; the holdings and the References only in session
      if (beingOperated(document.activeElement)) return;
      if (session) void loadReferences();
      void pollLine();
      if (session) void pollHoldings();
    }, refresh * 1000);
    return () => clearInterval(id);
  }, [refresh, session, pollFrom, loadReferences, pollLine, pollHoldings]);

  /** Everything once, from the header's refresh — the one refresh button since #410, which took the
   *  market-closed line's away: the line, the holdings' valuation, the References and the closes.
   *  Outside the session that is one valuation and one read of the References, and the poll goes on
   *  asking only for the line. */
  const refreshNow = useCallback(async () => {
    // a refresh is a fresh start: whatever the poll is still waiting on, its next tick asks again
    pollLine.reset();
    pollHoldings.reset();
    setRefreshing(true);
    try {
      await Promise.all([load(true), loadCloses()]);
    } finally {
      setRefreshing(false);
      // restarts the interval: a press just before a tick must displace it, not add a batch
      setPollFrom((n) => n + 1);
    }
  }, [load, loadCloses, pollLine, pollHoldings]);

  /** A change the service has to make, then the page as the service now tells it. */
  const act = useCallback(async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e: unknown) {
      {
        const raw = rawError(e);
        const title = plainError(e);
        // the raw text as the toast's detail, where it says more than the words (part N)
        toast.add({ title, description: raw.trim() !== title ? raw : undefined, type: "error" });
      }
      return false;
    }
    // asked here rather than by `load`, to know when it lands: a read that STARTS after the write,
    // whatever is out already (`oneAtATime`)
    setReferencesPending((n) => n + 1);
    void loadReferences().finally(() => setReferencesPending((n) => n - 1));
    await load(true, false);
    return true;
  }, [load, loadReferences]);

  /** everything again, after the add form saved */
  const reload = useCallback(() => load(true, true), [load]);

  return {
    quotes, monitors, health, references, holdings, holdingsError, holdingsAt, holdingsServed, error, errorRaw, polledAt,
    holdingsKept: holdings === null && holdingsError !== null ? lastValued : null,
    closes, quotesFailed,
    refresh, setRefresh, refreshing, refreshNow, act, loadHoldings, loadReferences,
    referencesPending: referencesPending > 0, reload,
  };
}

/** `ask`, never two at once: asked while one is out, it starts ONE more when that one settles,
 *  shared by everyone who asked meanwhile, and resolves when that one does — so a caller always
 *  gets a read that started after it asked, and answers land in the order they were asked, which
 *  is what keeps an older set from being drawn over a newer one. `ask` must not reject. */
function oneAtATime(ask: () => Promise<void>): () => Promise<void> {
  let out: Promise<void> | null = null;
  let next: Promise<void> | null = null;
  const run = (): Promise<void> => {
    if (out === null) {
      out = ask().finally(() => { out = null; });
      return out;
    }
    next ??= out.then(() => { next = null; return run(); });
    return next;
  };
  return run;
}
