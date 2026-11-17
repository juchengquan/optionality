import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

import type { Entry, Holding, Monitor } from "../shared/api";
import { ColumnPicker } from "../shared/ColumnPickers";

import { Legs } from "../shared/Legs";
import { SHORT_DELTA } from "../shared/words";
import { writtenDate } from "../shared/times";
import { HoldingSections, holdingMeta, RuleSections, ruleMeta } from "../DetailSections";

import { reasonLabel } from "../shared/groups";
import { readHidden, readPriceMap, writeHidden, writePriceMap } from "../shared/prefs";
import { Money, type BookProps } from "../Book";
import { AttentionChip } from "../AttentionChip";
import { ClosedLine } from "../ClosedLine";
import { monitorName, sentence, shapeOf, shortRule, storedRuleWords } from "../needs";
import { ShortWords } from "../RuleWords";
import { costAndPace, paceOutcome } from "../pace";
import type { HoldingWrites } from "../HoldingActions";
import { DetailBoundary } from "../DetailBoundary";
import { keptHolding, STALE_WORDS } from "../kept";
import { alsoWords, drawnUnder, NOTHING, placeBook, type BookModel, type Elsewhere, type ExpiryBook, type PlacedRule } from "../placement";
import { MonitorControls } from "../MonitorEdit";
import { ruleOfEntry, ruleOfMonitor } from "../edit";
import {
  ATTENTION_WORDS, attentionOf, chipWords, COLUMNS, distanceShort, HELD, heldSpread, ownAttentionOf, RETIRED_KEYS, rowId, rowLegs,
  rowName, rowState, rowStrip, ruleOfRow, subRules, tableRows,
  type DeskColumn, type DeskRow,
} from "./columns";
import { SpxNote, StrikeStrip } from "../StrikeStrip";
import { bookSpxReasons, joinStrips, stripOfHolding } from "../strip";
import { inFold, NOTHING_SELECTED, rowElement, useDeskKeys, type DeskSelection } from "./keys";
import { useDeskFit } from "./useDeskFit";
import { PriceMapPanel } from "./PriceMapPanel";
import { priceMapOf, spxOfBook } from "../pricemap";
import "./desk.css";
import { ErrorWords } from "../shared/ErrorWords";

/** The desk's book, arrangement A (ADR 0023, #289): ONE dense table — ONE book (2026-11-17), each
 *  expiry once with its held spreads, its watched spreads and its lone contracts under it — beside a
 *  NON-MODAL inspector.
 *
 *  - Which rule sits where is `placeBook`'s, shared with the phone's cards; this only draws it.
 *  - A condor held as two spreads is one bracket; a 4-leg holding is one row.
 *  - The inspector is a region beside the table, never a dialog over it: the table keeps polling
 *    and stays operable while one row is studied. What it shows is read from the CURRENT props on
 *    every render — only the selected id is kept — so it is as live as the row it describes.
 *  - The columns are fitted to the room by measurement (ADR 0008), and the viewer's column choice
 *    is kept in the old page's combo-table cookie, so a choice made there before the swap held.
 */
export function DeskBook({ selection, ...props }: BookProps & {
  /** the selection, when the page owns it (#299): the palette reads it and lands on a row */
  selection?: [DeskSelection, (s: DeskSelection) => void];
}) {
  const { quotes, monitors, holdings, session, privacy } = props;
  const placed = useMemo(() => placeBook(quotes, holdings, monitors), [quotes, holdings, monitors]);
  const rows = useMemo(() => tableRows(placed), [placed]);
  const partners = useMemo(() => new Map(placed.book.flatMap((g) => g.held)
    .filter((b) => b.length === 2)
    .flatMap(([a, b]) => [[a!.holding.id, b!.holding], [b!.holding.id, a!.holding]] as [string, Holding][])),
  [placed]);

  // The cookie was the old page's combo table's too, and it hides columns the desk never offers
  // (gamma, expiry…). So every change is made to the cookie as it stands NOW — another tab may have
  // written it since this one read it — and touches only the desk's own keys.
  const [hidden, setHidden] = useState(() => readHidden());
  const fit = useDeskFit(rows, hidden, privacy, session);
  const onToggle = useCallback((key: string, shown: boolean) => {
    const next = readHidden();
    if (shown) next.delete(key); else next.add(key);
    writeHidden(next);
    setHidden(next);
  }, []);
  const onReset = useCallback(() => {
    const next = readHidden();
    for (const key of DESK_KEYS) next.delete(key);
    writeHidden(next);
    setHidden(next);
  }, []);

  // The selection is the table's cursor, and the inspector is open on it or not (#299): j and k
  // move it with the inspector shut, Enter opens it, Escape shuts it and keeps the place. A click,
  // the price map or the palette selects AND opens. The page may own it (`selection`), so the
  // palette can read it and land on a row; a desk drawn alone keeps its own.
  const own = useState<DeskSelection>(NOTHING_SELECTED);
  const [sel, setSel] = selection ?? own;
  const liveRow = sel.id === null ? null : rows.find((r) => rowId(r) === sel.id) ?? null;
  // a holding out of the book only because a valuation failed stays selected, on its last valued
  // figures, with whatever was typed into its forms (`kept.ts`)
  const kept = liveRow ? null : keptHolding(sel.id, quotes, holdings, props.holdingsKept, monitors);
  const selectedRow: DeskRow | null = liveRow ?? (kept ? { kind: "holding", ...kept } : null);
  const current = sel.open ? selectedRow : null;
  // a row that leaves the book otherwise takes the selection with it: kept, it reopened the
  // inspector by itself when the row came back
  useEffect(() => { if (sel.id !== null && !selectedRow) setSel(NOTHING_SELECTED); }, [sel.id, selectedRow, setSel]);
  const setSelected = useCallback((id: string) => setSel({ id, open: true }), [setSel]);

  // closing by hand hands the focus back to the row's button, which the close button took with it
  const root = useRef<HTMLDivElement>(null);
  const returnTo = useRef<string | null>(null);
  const selNow = useRef(sel);
  selNow.current = sel;
  const close = useCallback(() => {
    returnTo.current = selNow.current.id;
    setSel({ id: selNow.current.id, open: false });
  }, [setSel]);
  useEffect(() => {
    if (current || returnTo.current === null) return;
    const id = returnTo.current;
    returnTo.current = null;
    rowElement(root.current, id)?.querySelector<HTMLElement>(".nxd-name")?.focus();
  }, [current]);

  // Escape is the inspector's only when nothing else took it: not one a popover or a dialog
  // handled, and not one pressed inside a surface drawn outside the desk (Settings is a portal)
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target;
      if (t instanceof Node && t !== document && t !== document.body && !root.current?.contains(t)) return;
      // nor one pressed in the closed trades' fold (#373), which is in the book but not the table
      if (inFold(t)) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [current, close]);

  const ids = useMemo(() => rows.map(rowId), [rows]);
  useDeskKeys({ ids, selection: sel, setSelection: setSel, desk: root });

  // the palette's landing (#299): the row brought into view, then the inspector's heading focused,
  // or the selected Monitor's editor or the selected holding's close form opened in it
  const request = sel.request;
  useEffect(() => {
    if (!request) return;
    rowElement(root.current, sel.id)?.scrollIntoView?.({ block: "nearest" });
    const inspector = root.current?.querySelector<HTMLElement>(".nxd-inspector");
    if (!inspector) return;
    const button = request.then === "edit"
      // the selected rule's own controls come first in its inspector, before any rule under it
      ? inspector.querySelector<HTMLElement>(".nx-mon-actions button")
      : request.then === "close"
        ? [...inspector.querySelectorAll<HTMLElement>(".nx-hold-actions button")].find((b) => b.textContent === "close…")
        : null;
    if (button) {
      if (button.getAttribute("aria-expanded") !== "true") button.click();
      // already open: the focus goes where the form put it when it opened — its first box — rather
      // than staying on the page behind the palette that just closed
      else formOf(button)?.querySelector<HTMLElement>("input")?.focus();
    } else {
      inspector.querySelector<HTMLElement>("h3")?.focus();
    }
    // the request is spent: a later render must not run it again (it runs once per request)
    setSel({ id: sel.id, open: sel.open });
  }, [request?.n]);

  // the price map (#298): a panel over the table and the inspector, sharing their ONE selection
  const [mapOpen, setMapOpen] = useState(readPriceMap);
  const toggleMap = useCallback(() => setMapOpen((was) => { writePriceMap(!was); return !was; }), []);
  const map = useMemo(() => priceMapOf(placed, spxOfBook(quotes, holdings)), [placed, quotes, holdings]);
  const mapId = useId();
  // the held spreads are missing while the holdings are not valued: said, never left to be noticed
  const mapNote = holdings !== null ? null : props.holdingsError !== null
    ? "holdings could not be valued — only watched spreads are drawn"
    : "holdings not valued yet — only watched spreads are drawn";
  /** A spread picked on the map is the row picked in the table: selected, and brought into view. */
  const pickOnMap = useCallback((id: string) => {
    setSelected(id);
    rowElement(root.current, id)?.scrollIntoView?.({ block: "nearest" });
  }, [setSelected]);

  const inspectorId = useId();
  const ctx: Ctx = {
    columns: fit.columns, privacy, selected: current ? rowId(current) : null, cursor: sel.id, select: setSelected,
    inspectorId, session,
  };
  const pickable = COLUMNS.filter((c) => c.key !== "name" && (fit.offered.has(c.key) || hidden.has(c.key)));

  return (
    <div className="nx-book nxd" ref={root} data-inspecting={current ? "" : undefined}>
      {mapOpen ? <PriceMapPanel id={mapId} map={map} session={session} note={mapNote}
                                 selected={current ? rowId(current) : null} onSelect={pickOnMap} /> : null}
      <div className="nxd-table" ref={fit.ref} style={{ "--nxd-cols": fit.template } as React.CSSProperties}>
        <div className="nxd-head nxd-grid">
          {fit.columns.map((c) => (
            <span key={c.key} data-col={c.key} data-align={c.align} data-greek={GREEK.test(c.label) ? "" : undefined}>{c.label}</span>
          ))}
        </div>

        <OneBook {...props} placed={placed} ctx={ctx} picker={
          // on the first section's line, at its end: over the header it sat on top of a label
          <>
            <button type="button" className="nxd-maptoggle" aria-expanded={mapOpen}
                    aria-controls={mapOpen ? mapId : undefined} onClick={toggleMap}>
              price map
            </button>
            <ColumnPicker label="book" hidden={hidden} onToggle={onToggle} onReset={onReset}
                          all={pickable} />
          </>
        } />
        <Muted monitors={placed.muted} />
      </div>

      {current ? <Inspector id={inspectorId} row={current} session={session} privacy={privacy} rows={rows} partners={partners}
                            onSelect={setSelected} onClose={close} quotes={quotes} monitors={monitors} writes={props.writes}
                            stale={kept !== null} /> : null}
      {/* the closed trades' fold (#373): the last thing in the book, across the whole width */}
      {props.journal}
    </div>
  );
}

/** The form a button in the inspector opened: the Monitor's editor beside its controls, or the
 *  holding's form under its three buttons. */
function formOf(button: HTMLElement): HTMLFormElement | null {
  return button.closest(".nx-mon, .nx-hold")?.querySelector("form") ?? null;
}

interface Ctx {
  columns: DeskColumn[];
  privacy: boolean;
  selected: string | null;
  /** the row j and k are on, whether or not the inspector is open on it */
  cursor: string | null;
  select: (id: string) => void;
  inspectorId: string;
  /** a holding's chip says, outside the session, which valuation it is from (#354, #371) */
  session: boolean;
}

/** Every key the desk draws, and the ones it drew before #372: all it may change in the column
 *  cookie (`readHidden`). A retired key hides nothing, since no column has it, and reset clears it. */
const DESK_KEYS = new Set([...COLUMNS.map((c) => c.key), ...RETIRED_KEYS]);

/** A Greek letter, which a label carrying one is never set in capitals for (desk.css). */
const GREEK = /[\u0370-\u03ff]/;

/** The rule's sentence, as its column says it. */
const ALARM_COLUMN = COLUMNS.find((c) => c.key === "alarm")!;

// ---- the sections

/** The book in two sections (the owner, 2026-11-17): Spreads, then Contracts, each by expiry, its
 *  held rows first. What the book says before its rows — the session line, SPX's reason, a
 *  valuation's failure or that it is under way, and that there is nothing at all — is said once,
 *  above them. */
function OneBook({ placed, quotes, holdings, holdingsError, holdingsAt, holdingsServed, session, phase, ctx, picker }: BookProps & {
  placed: BookModel; ctx: Ctx; picker: React.ReactNode;
}) {
  const empty = placed.book.length === 0 && placed.unplaced.length === 0 && placed.quarantined.length === 0;
  return (
    <section aria-labelledby="nxd-book">
      <div className="nxd-section">
        {/* the book is the page: its heading is for a reader, as the sections' were */}
        <h2 id="nxd-book" className="sr-only">Book</h2>
        <span className="nxd-picker">{picker}</span>
      </div>
      {holdingsError !== null
        ? <div className="nx-meta nxd-note">{"the holdings could not be valued — "}<ErrorWords raw={holdingsError} again="refresh to try again" /></div> : null}
      {holdings === null && holdingsError === null ? <p className="nx-meta nxd-note">valuing…</p> : null}
      {/* one line for an empty book, whichever half is missing (2026-11-17) */}
      {holdings !== null && empty ? <p className="nx-meta nxd-note">{NOTHING}</p> : null}
      {/* outside the session (#371): when the service valued what is drawn; the header's refresh
          values it again (#410). In the Curb and GTH, that the quotes are live and thin (#416) */}
      {(phase ?? (session ? "regular" : "closed")) !== "regular"
        ? <ClosedLine at={holdings !== null ? holdingsAt : null} served={holdingsServed} holdings={holdings}
                      phase={phase ?? "closed"} className="nx-meta nxd-note" /> : null}
      {/* why SPX is not current, once for the book: its rows' strips draw the hollow dot (2026-11-17) */}
      <SpxNote reasons={bookSpxReasons(holdings, quotes)} className="nx-meta nxd-note" />
      {placed.sections.map((s) => (
        <section key={s.kind} className="nxd-part" data-section={s.kind} aria-labelledby={`nxd-part-${s.kind}`}>
          <h2 id={`nxd-part-${s.kind}`} className="nxd-part-head">{s.title}</h2>
          {s.expiries.map((g) => <Expiry key={g.expiry} g={g} ctx={ctx} />)}
        </section>
      ))}
      {placed.unplaced.length > 0 ? (
        <div className="nxd-expiry" data-testid="unplaced">
          <h3 className="nxd-group">Rules on held contracts</h3>
          <p className="nx-meta nxd-note">
            {holdings === null
              ? "the holdings are not valued, so the rules about them are listed on their own"
              : "each watches a held contract that no single holding owns, as on a roll day"}
          </p>
          <ul>
            {placed.unplaced.map((e) => (
              <li key={e.id}><Row row={{ kind: "rule", entry: e, nested: false }} ctx={ctx} /></li>
            ))}
          </ul>
        </div>
      ) : null}
      {placed.quarantined.length > 0 ? (
        <div className="nxd-quarantined">
          {/* a fault, so never collapsed: nothing watches what these watched (ADR 0023) */}
          <h3 className="nxd-group">Quarantined — switched off by the service</h3>
          <ul>
            {placed.quarantined.map((m) => (
              <li key={m.id}><Row row={{ kind: "quarantined", monitor: m }} ctx={ctx} /></li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** One expiry of a section: its heading, its held rows (a condor's two spreads bracketed), then its
 *  watched spreads or its lone contracts, whichever section it is in. */
function Expiry({ g, ctx }: { g: ExpiryBook; ctx: Ctx }) {
  return (
    <div className="nxd-expiry" data-expiry={g.expiry}>
      <h3 className="nxd-group">{`${writtenDate(g.expiry)} · ${g.dte} DTE`}</h3>
      <ul>
        {g.held.map((bracket) => (
          <li key={bracket.map((p) => p.holding.id).join("+")}
              data-bracket={bracket.length === 2 ? "condor" : undefined}>
            <ul>
              {bracket.map((placed, i) => {
                const { holding, rules, legRules } = placed;
                // drawn in pieces on the rows it passes, so it runs from the first holding's
                // row to the second's whatever rules sit under either
                const paired = bracket.length === 2;
                return (
                  <li key={holding.id}>
                    <Row row={{ kind: "holding", holding, rules, legRules }} ctx={ctx}
                         bracket={paired ? (i === 0 ? "top" : "bottom") : undefined} />
                    {/* its own rule is on its row: only the others are rows under it */}
                    {subRules(placed).map((e) => <Row key={e.id} row={{ kind: "rule", entry: e, nested: true }} ctx={ctx}
                                                      bracket={paired && i === 0 ? "through" : undefined} />)}
                    <AlsoNotes elsewhere={placed.elsewhere} />
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
        {[...g.spreads, ...g.contracts].map((item) => <Watched key={item.entry.id} item={item} ctx={ctx} />)}
      </ul>
    </div>
  );
}

/** A watched spread or contract and the leg rules under it. A spread that partly overlaps a holding
 *  (#346) says what it shares in its inspector, not under its row: with spreads and contracts in
 *  sections of their own the line was noise (the owner, 2026-11-17). */
function Watched({ item: { entry, under, overlap, elsewhere }, ctx }: { item: PlacedRule; ctx: Ctx }) {
  return (
    <li>
      <Row row={{ kind: "rule", entry, nested: false, overlap }} ctx={ctx} />
      {drawnUnder(under, elsewhere).map((e) => <Row key={e.id} row={{ kind: "rule", entry: e, nested: true }} ctx={ctx} />)}
      <AlsoNotes elsewhere={elsewhere} />
    </li>
  );
}

/** A rule met again under a second place (the owner, 2026-11-17): a quiet note naming where its
 *  row is, never a second row — nothing here is selected, focused or led to by a banner. */
function AlsoNotes({ elsewhere }: { elsewhere: Elsewhere[] | undefined }) {
  if (!elsewhere?.length) return null;
  return <>{elsewhere.map((e) => <p key={e.entry.id} className="nx-meta nxd-also" data-also="">{alsoWords(e)}</p>)}</>;
}


/** Muted by hand, expired, or off with their holding: not news, so folded away, as the old page's
 *  muted tables were — with its words for why each is off. */
function Muted({ monitors }: { monitors: Monitor[] }) {
  if (monitors.length === 0) return null;
  const reason = (m: Monitor) => reasonLabel(m.disabled_reason);
  return (
    <details className="nxd-muted">
      <summary>{`Muted and expired · ${monitors.length}`}</summary>
      <ul>
        {monitors.map((m) => (
          <li key={m.id} data-ref={m.id}>
            <span className="nxd-name">{monitorName(m)}</span>
            <span><ShortWords short={shortRule(shapeOf(m))}
                              full={storedRuleWords(m.field, Boolean(m.legs), m.compare, m.direction, m.threshold)} /></span>
            <span className="nx-meta">{reason(m)}</span>
            <MonitorControls rule={ruleOfMonitor(m)} served={null} expiredSaid={m.disabled_reason === "expired"} />
          </li>
        ))}
      </ul>
    </details>
  );
}

// ---- a row

/** The state a row is drawn in, which the row's tint and its chip answer to: for a holding, the
 *  more serious of its Level's and its own rule's (`rowState`, 2026-11-17). */
const stateOf = rowState;

function Row({ row, ctx, bracket }: { row: DeskRow; ctx: Ctx; bracket?: "top" | "through" | "bottom" }) {
  const id = rowId(row);
  const isRule = row.kind === "rule";
  return (
    <div className="nxd-row nxd-grid" data-ref={id} data-kind={row.kind} data-state={stateOf(row)}
         data-nested={isRule && row.nested ? "" : undefined}
         data-selected={ctx.selected === id ? "" : undefined}
         data-cursor={ctx.cursor === id ? "" : undefined}
         onClick={() => ctx.select(id)}>
      {bracket ? <span className="nxd-bracket" data-part={bracket} aria-hidden="true" /> : null}
      {ctx.columns.map((c) => (
        <span key={c.key} data-col={c.key} data-align={c.align}>
          {c.key === "name" ? <NameCell row={row} ctx={ctx} distance={!ctx.columns.some((k) => k.key === "alarm")} />
            : <Cell row={row} column={c} privacy={ctx.privacy} />}
        </span>
      ))}
    </div>
  );
}

/** @param distance the rule's column has dropped: a rule row draws its arrowed distance here, the
 *  short text its line draws ("↑3.60"), and a reader hears it with the rule, in its sentence
 *  (the owner, 2026-11-17, where the fill bar fell back before) */
function NameCell({ row, ctx, distance }: { row: DeskRow; ctx: Ctx; distance: boolean }) {
  const a = attentionOf(row);
  const own = ownAttentionOf(row);
  const short = distance ? distanceShort(row) : "";
  const rule = ruleOfRow(row);
  return (
    <>
      <button type="button" className="nxd-name" aria-expanded={ctx.selected === rowId(row)}
              aria-controls={ctx.selected === rowId(row) ? ctx.inspectorId : undefined}
              onClick={(e) => { e.stopPropagation(); ctx.select(rowId(row)); }}>
        {rowName(row)}
        {/* what tells a holding from a watch in the one book, heard in its name (2026-11-17) */}
        {row.kind === "holding" ? <>{" "}<span className="nx-held" data-held="">{HELD}</span></> : null}
      </button>
      {a ? <AttentionChip kind={a} words={chipWords(row, ctx.session)} /> : null}
      {/* a holding's own rule, ringing or at fault, on the row that now draws it */}
      {own ? <AttentionChip kind={own} words={ATTENTION_WORDS[own]} /> : null}
      {short && rule ? (
        <span className="nxd-distance" data-distance="">
          <span className="sr-only">{` rule ${sentence(rule)}`}</span>
          <span aria-hidden="true" title={sentence(rule)}>{short}</span>
        </span>
      ) : null}
    </>
  );
}


/** One figure. The visually hidden label says which figure it is to a reader that does not see
 *  the header above it — the rows are a grid of spans, not a `<table>`. */
function Cell({ row, column, privacy }: { row: DeskRow; column: DeskColumn; privacy: boolean }) {
  const text = column.text(row, privacy);
  if (text === "") return null;
  const strip = column.key === "strip" ? rowStrip(row) : null;
  if (strip) {
    // the reason there is no price goes with the dash: to a pointer, and to a reader
    const why = strip.spx === null ? strip.reason ?? undefined : undefined;
    return (
      <>
        <span className="sr-only">{`${column.label} `}</span>
        <StrikeStrip strip={strip} compact />
        <span className="nxd-v" title={why}>{text}</span>
        {why ? <span className="sr-only">{` ${why}`}</span> : null}
      </>
    );
  }
  // a held spread's rule says its cost to close in this column too (2026-11-16), and is read so
  const label = column.key === "value" && (row.kind === "holding" || (row.kind === "rule" && heldSpread(row))) ? "cost to close"
    : column.key === "delta" && row.kind === "holding" ? SHORT_DELTA : column.label;
  if (column.key === "legs") {
    return <><span className="sr-only">{`${label} `}</span><span className="nxd-v"><Legs legs={rowLegs(row)} /></span></>;
  }
  if (column.key === "pnl" && row.kind === "holding") {
    return <><span className="sr-only">{`${label} `}</span><span className="nxd-v"><Money value={row.holding.pnl} privacy={privacy} /></span></>;
  }
  // a holding's value: its Cost to close and its pace gap in one field (2026-11-16), the gap in its
  // outcome's colour, the two said in words to a pointer and a reader
  if (column.key === "value" && row.kind === "holding") {
    const v = costAndPace(row.holding);
    const said = `${label} ${v.words}`;
    return (
      <>
        <span className="sr-only">{said}</span>
        <span className="nxd-v" title={said} aria-hidden="true">
          {v.cost}
          {v.gap !== null
            ? <>{" "}<span className="nxd-gap" data-outcome={paceOutcome(row.holding.schedule?.pace_gap)}>{v.gap}</span></>
            : null}
        </span>
      </>
    );
  }
  const outcome = outcomeOf(row, column);
  // a compact cell (the pace gap's sign, #379) is read out as its words, and shows them to a pointer
  const words = column.words?.(row, privacy);
  if (words !== undefined && words !== text) {
    return (
      <>
        <span className="sr-only">{`${label} ${words}`}</span>
        <span className="nxd-v" data-outcome={outcome} title={words} aria-hidden="true">{text}</span>
      </>
    );
  }
  return (
    <>
      <span className="sr-only">{`${label} `}</span>
      <span className="nxd-v" data-outcome={outcome}>{text}</span>
    </>
  );
}

/** A cell's outcome colour: the pace gap's, where positive is BEHIND the plan — costing more to
 *  close than it should by now — and the table and the inspector draw it alike. */
function outcomeOf(row: DeskRow, column: DeskColumn): "loss" | "gain" | undefined {
  return column.key === "pace_gap" && row.kind === "holding" ? paceOutcome(row.holding.schedule?.pace_gap) : undefined;
}

// ---- the inspector

function Inspector({ id, row, session, privacy, rows, partners, onSelect, onClose, quotes, monitors, writes, stale = false }: {
  id: string; row: DeskRow; session: boolean; privacy: boolean; rows: DeskRow[]; partners: Map<string, Holding>;
  onSelect: (id: string) => void; onClose: () => void; quotes: Entry[]; monitors: Monitor[]; writes?: HoldingWrites;
  /** drawn from the last valuation that succeeded, the ones since having failed (`kept.ts`) */
  stale?: boolean;
}) {
  const name = rowName(row);
  // the focus follows what was opened, so a keyboard reader lands on it
  const heading = useRef<HTMLHeadingElement>(null);
  const subject = rowId(row);
  useEffect(() => { heading.current?.focus(); }, [subject]);
  return (
    <aside id={id} className="nxd-inspector" aria-label={`inspector: ${name}`} data-stale={stale ? "" : undefined}>
      <div className="nxd-insp-head">
        <h3 ref={heading} tabIndex={-1}>{name}</h3>
        <button type="button" className="nxd-close" aria-label="close the inspector" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>
      {stale ? <p className="nx-meta nxd-stale" role="status">{STALE_WORDS}</p> : null}
      {/* the heading and its close stay outside: a detail that cannot be drawn can still be shut */}
      <DetailBoundary key={subject} what={row.kind === "holding" ? "holding" : "rule"}>
        {/* the meta line, and by the session (#371) whether what is shown updates with the poll */}
        <p className="nx-meta">
          {row.kind === "holding" ? holdingMeta(row.holding) : row.kind === "rule" ? ruleMeta(row.entry)
            : `${writtenDate(row.monitor.strike_date)} · ${row.monitor.code}`}
        </p>
        <p className="nx-meta nxd-note">{session && !stale ? "live: updates with every poll" : "as last valued"}</p>
        {/* the one order the phone's sheet draws too (part J, `sections.ts`) */}
        {/* stale, its Level says which valuation it is from, as outside the session */}
        {row.kind === "holding" ? <HoldingDetail row={row} session={session && !stale} privacy={privacy} partners={partners}
                                                 onSelect={onSelect} quotes={quotes} monitors={monitors} writes={writes} />
          : row.kind === "rule" ? <RuleDetail entry={row.entry} rows={rows} overlap={row.overlap ?? null}
                                              session={session} />
            : <QuarantinedDetail row={row} />}
      </DetailBoundary>
    </aside>
  );
}

function HoldingDetail({ row, session, privacy, partners, onSelect, quotes, monitors, writes }: {
  row: Extract<DeskRow, { kind: "holding" }>; session: boolean; privacy: boolean; partners: Map<string, Holding>;
  onSelect: (id: string) => void; quotes: Entry[]; monitors: Monitor[]; writes?: HoldingWrites;
}) {
  const h: Holding = row.holding;
  // the condor's other spread, when placement bracketed the two
  const partner = partners.get(h.id) ?? null;
  return (
    <HoldingSections surface="desk" holding={h} rules={row.rules} quotes={quotes} monitors={monitors}
                     privacy={privacy} session={session} writes={writes}
                     strip={<InspectorStrip holding={h} partner={partner} />}
                     ruleLine={(e) => <RuleItem key={e.id} entry={e} />}
                     extra={partner ? (
                       <button type="button" className="nxd-link" onClick={() => onSelect(partner.id)}>
                         {`condor with ${partner.name} →`}
                       </button>
                     ) : null} />
  );
}

/** A holding's strike strip, its bracketed partner's strikes on the same scale; none for a holding
 *  with no short leg. */
function InspectorStrip({ holding, partner }: { holding: Holding; partner: Holding | null }) {
  const own = stripOfHolding(holding);
  const other = partner ? stripOfHolding(partner) : null;
  const strip = own && other ? joinStrips(own, other) : own;
  return strip ? <StrikeStrip strip={strip} /> : null;
}

function RuleDetail({ entry, rows, overlap, session }: {
  entry: Entry; rows: DeskRow[]; overlap: string | null; session: boolean;
}) {
  const under = rows.filter((r): r is Extract<DeskRow, { kind: "rule" }> =>
    r.kind === "rule" && r.nested && !r.entry.legs && r.entry.in_combos.includes(entry.id) && !r.entry.held);
  return (
    <RuleSections surface="desk" entry={entry} under={under.map((r) => r.entry)} overlap={overlap}
                  session={session}
                  ruleLine={(e, own) => <RuleItem key={e.id} entry={e} own={own} />} />
  );
}

function QuarantinedDetail({ row }: { row: Extract<DeskRow, { kind: "quarantined" }> }) {
  const m = row.monitor;
  const text = ALARM_COLUMN.text(row, false);
  const words = ALARM_COLUMN.words!(row, false);
  return (
    <>
      <div className="nxd-monitor" data-state="fault">
        <AttentionChip kind="fault" />
        <span><ShortWords short={text} full={words} /></span>
      </div>
      <p className="nx-meta">Nothing watches what this rule watched until it is fixed or removed.</p>
      <MonitorControls rule={ruleOfMonitor(m)} served={null} />
    </>
  );
}

/** A rule in the inspector's Rules section: its chip, its short form (the sentence to a pointer and
 *  a reader), how far it has come, and its controls. */
function RuleItem({ entry, own = false }: {
  entry: Entry;
  /** the rule the inspector is OF: its chip is the level section's, said once (review of #420) */
  own?: boolean;
}) {
  const row: DeskRow = { kind: "rule", entry, nested: false };
  const a = attentionOf(row);
  return (
    <li className="nxd-monitor" data-state={a ?? "calm"}>
      {a && !own ? <AttentionChip kind={a} /> : null}
      <span><ShortWords short={ALARM_COLUMN.text(row, false)} full={ALARM_COLUMN.words!(row, false)} /></span>
      <MonitorControls rule={ruleOfEntry(entry)} served={entry} />
    </li>
  );
}
