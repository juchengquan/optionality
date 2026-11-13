import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

import type { Entry, Holding, Monitor } from "../../shared/api";
import { ColumnPicker } from "../../shared/ColumnPickers";
import type { Column } from "../../shared/columns";
import { shortDate } from "../../shared/format";
import { GROUPS } from "../../shared/groups";
import { readHidden, readPriceMap, writeHidden, writePriceMap } from "../../shared/prefs";
import { Chip, Money, type BookProps } from "../Book";
import type { Mode } from "../mode";
import { Glyph } from "../NeedsLine";
import { monitorName, fieldWords } from "../needs";
import { HoldingHistory } from "../History";
import { PaceExplained } from "../PaceExplained";
import { paceOutcome } from "../pace";
import { HoldingActions, type HoldingWrites } from "../HoldingActions";
import { DetailBoundary } from "../DetailBoundary";
import { HoldingPayoff, WatchedPayoff } from "../Payoff";
import { placeBook, type BookModel } from "../placement";
import { MonitorControls } from "../MonitorEdit";
import { ruleOfEntry, ruleOfMonitor } from "../edit";
import {
  ATTENTION_WORDS, attentionOf, COLUMNS, rowId, rowName, rowStrip, tableRows, type DeskColumn, type DeskRow,
} from "./columns";
import { StrikeStrip } from "../StrikeStrip";
import { joinStrips, stripOfEntry, stripOfHolding } from "../strip";
import { NOTHING_SELECTED, rowElement, useDeskKeys, type DeskSelection } from "./keys";
import { useDeskFit } from "./useDeskFit";
import { PriceMapPanel } from "./PriceMapPanel";
import { RuleFigures } from "../RuleFigures";
import { priceMapOf, spxOfBook } from "../pricemap";
import "./desk.css";

/** The desk's book, arrangement A (ADR 0023, #289): ONE dense table, holdings first and then the
 *  watchlist, each grouped by expiry, beside a NON-MODAL inspector.
 *
 *  - Which rule sits where is `placeBook`'s, shared with the phone's cards; this only draws it.
 *  - A condor held as two spreads is one bracket; a 4-leg holding is one row.
 *  - The inspector is a region beside the table, never a dialog over it: the table keeps polling
 *    and stays operable while one row is studied. What it shows is read from the CURRENT props on
 *    every render — only the selected id is kept — so it is as live as the row it describes.
 *  - The columns are fitted to the room by measurement (ADR 0008), and the viewer's column choice
 *    is `/opt`'s combo-table cookie, so a choice made there holds here.
 */
export function DeskBook({ selection, ...props }: BookProps & {
  /** the selection, when the page owns it (#299): the palette reads it and lands on a row */
  selection?: [DeskSelection, (s: DeskSelection) => void];
}) {
  const { quotes, monitors, holdings, mode, privacy } = props;
  const placed = useMemo(() => placeBook(quotes, holdings, monitors), [quotes, holdings, monitors]);
  const rows = useMemo(() => tableRows(placed), [placed]);
  const partners = useMemo(() => new Map(placed.holdings.flatMap((g) => g.rows)
    .filter((b) => b.length === 2)
    .flatMap(([a, b]) => [[a!.holding.id, b!.holding], [b!.holding.id, a!.holding]] as [string, Holding][])),
  [placed]);

  // The cookie is `/opt`'s combo table's too, and it hides columns the desk never offers (gamma,
  // expiry…). So every change is made to the cookie as it stands NOW — another tab may have written
  // it since this one read it — and touches only the desk's own keys.
  const [hidden, setHidden] = useState(() => readHidden("combo"));
  const fit = useDeskFit(mode, rows, hidden, privacy);
  const onToggle = useCallback((_: "single" | "combo", key: string, shown: boolean) => {
    const next = readHidden("combo");
    if (shown) next.delete(key); else next.add(key);
    writeHidden("combo", next);
    setHidden(next);
  }, []);
  const onReset = useCallback(() => {
    const next = readHidden("combo");
    for (const key of DESK_KEYS) next.delete(key);
    writeHidden("combo", next);
    setHidden(next);
  }, []);

  // The selection is the table's cursor, and the inspector is open on it or not (#299): j and k
  // move it with the inspector shut, Enter opens it, Escape shuts it and keeps the place. A click,
  // the price map or the palette selects AND opens. The page may own it (`selection`), so the
  // palette can read it and land on a row; a desk drawn alone keeps its own.
  const own = useState<DeskSelection>(NOTHING_SELECTED);
  const [sel, setSel] = selection ?? own;
  const selectedRow = sel.id === null ? null : rows.find((r) => rowId(r) === sel.id) ?? null;
  const current = sel.open ? selectedRow : null;
  // a row that leaves the book takes the selection with it: kept, it reopened the inspector by
  // itself when the row came back, as on the poll after one failed valuation
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
        ? [...inspector.querySelectorAll<HTMLElement>(".nx-hold-actions button")].find((b) => b.textContent === "Close…")
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
    inspectorId,
  };
  const pickable = COLUMNS[mode].filter((c) => c.key !== "name" && (fit.offered.has(c.key) || hidden.has(c.key)));

  return (
    <div className="nx-book nxd" ref={root} data-inspecting={current ? "" : undefined}>
      {mapOpen ? <PriceMapPanel id={mapId} map={map} mode={mode} note={mapNote}
                                 selected={current ? rowId(current) : null} onSelect={pickOnMap} /> : null}
      <div className="nxd-table" ref={fit.ref} style={{ "--nxd-cols": fit.template } as React.CSSProperties}>
        <div className="nxd-head nxd-grid">
          {fit.columns.map((c) => (
            <span key={c.key} data-col={c.key} data-align={c.align}>{c.label}</span>
          ))}
        </div>

        <Holdings {...props} placed={placed} ctx={ctx} picker={
          // on the first section's line, at its end: over the header it sat on top of a label
          <>
            <button type="button" className="nxd-maptoggle" aria-expanded={mapOpen}
                    aria-controls={mapOpen ? mapId : undefined} onClick={toggleMap}>
              price map
            </button>
            <ColumnPicker table="combo" label="book" hidden={hidden} onToggle={onToggle} onReset={onReset}
                          all={pickable.map(asPickable)} />
          </>
        } />
        <Watchlist placed={placed} ctx={ctx} />
        <Muted monitors={placed.muted} />
      </div>

      {current ? <Inspector id={inspectorId} row={current} mode={mode} privacy={privacy} rows={rows} partners={partners}
                            onSelect={setSelected} onClose={close} monitors={monitors} writes={props.writes} /> : null}
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
}

/** Every key the desk draws: all it may change in the column cookie it shares with `/opt`. */
const DESK_KEYS = new Set([...COLUMNS.live, ...COLUMNS.review].map((c) => c.key));

/** `tableRows` lives with the columns (`columns.ts`); the still (#300) reads it from here. */
export { tableRows } from "./columns";

/** The picker draws a label and a key; the rest of `/opt`'s column descriptor is its table's. */
const asPickable = (c: DeskColumn): Column => ({ key: c.key, label: c.label, estimate: 0, text: () => "" });

// ---- the sections

function Holdings({ placed, holdings, holdingsError, holdingsAt, mode, ctx, picker }: BookProps & {
  placed: BookModel; ctx: Ctx; picker: React.ReactNode;
}) {
  return (
    <section aria-labelledby="nxd-holdings">
      <div className="nxd-section">
        <h2 id="nxd-holdings">Holdings</h2>
        <span className="nxd-picker">{picker}</span>
      </div>
      {holdingsError !== null
        ? <p className="nx-meta nxd-note">{`the holdings could not be valued — ${holdingsError}`}</p> : null}
      {holdings === null && holdingsError === null ? <p className="nx-meta nxd-note">valuing…</p> : null}
      {holdings !== null && holdings.length === 0 ? <p className="nx-meta nxd-note">nothing held</p> : null}
      {mode === "review" && holdings !== null && holdingsAt
        ? <p className="nx-meta nxd-note">{`valued at ${holdingsAt}`}</p> : null}
      {placed.holdings.map(({ expiry, rows }) => (
        <div key={expiry} className="nxd-expiry">
          <h3 className="nxd-group">{`${shortDate(expiry)} · ${rows[0]![0]!.holding.dte} DTE`}</h3>
          <ul>
            {rows.map((bracket) => (
              <li key={bracket.map((p) => p.holding.id).join("+")}
                  data-bracket={bracket.length === 2 ? "condor" : undefined}>
                <ul>
                  {bracket.map(({ holding, rules }, i) => {
                    // drawn in pieces on the rows it passes, so it runs from the first holding's
                    // row to the second's whatever rules sit under either
                    const paired = bracket.length === 2;
                    return (
                      <li key={holding.id}>
                        <Row row={{ kind: "holding", holding, rules }} ctx={ctx}
                             bracket={paired ? (i === 0 ? "top" : "bottom") : undefined} />
                        {rules.map((e) => <Row key={e.id} row={{ kind: "rule", entry: e, nested: true }} ctx={ctx}
                                               bracket={paired && i === 0 ? "through" : undefined} />)}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {placed.unplaced.length > 0 ? (
        <div className="nxd-expiry" data-testid="unplaced">
          <h3 className="nxd-group">rules on held contracts</h3>
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
    </section>
  );
}

function Watchlist({ placed, ctx }: { placed: BookModel; ctx: Ctx }) {
  const empty = placed.watchlist.length === 0 && placed.quarantined.length === 0;
  return (
    <section aria-labelledby="nxd-watchlist">
      <div className="nxd-section"><h2 id="nxd-watchlist">Watchlist</h2></div>
      {empty ? <p className="nx-meta nxd-note">nothing watched</p> : null}
      {placed.watchlist.map(({ expiry, items }) => (
        <div key={expiry} className="nxd-expiry">
          <h3 className="nxd-group">{`${shortDate(expiry)} · ${items[0]!.entry.dte} DTE`}</h3>
          <ul>
            {items.map(({ entry, under, overlap }) => (
              <li key={entry.id}>
                <Row row={{ kind: "rule", entry, nested: false, overlap }} ctx={ctx} />
                <OverlapNote overlap={overlap} />
                {under.map((e) => <Row key={e.id} row={{ kind: "rule", entry: e, nested: true }} ctx={ctx} />)}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {placed.quarantined.length > 0 ? (
        <div className="nxd-quarantined">
          {/* a fault, so never collapsed: nothing watches what these watched (ADR 0023) */}
          <h3 className="nxd-group">quarantined — switched off by the service</h3>
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

/** What a spread in the watchlist shares with a holding it only partly overlaps (#346), under its
 *  row: names and contracts only, so privacy has nothing to hide in it. */
export function OverlapNote({ overlap }: { overlap: string | null | undefined }) {
  return overlap ? <p className="nx-meta nxd-overlap" data-overlap="">{overlap}</p> : null;
}

/** Muted by hand, expired, or off with their holding: not news, so folded away, as `/opt`'s muted
 *  tables are — with `/opt`'s words for why each is off. */
function Muted({ monitors }: { monitors: Monitor[] }) {
  if (monitors.length === 0) return null;
  const reason = (m: Monitor) =>
    GROUPS.find(([r]) => r === (m.disabled_reason ?? null))?.[1] ?? "Reason not recorded";
  return (
    <details className="nxd-muted">
      <summary>{`Muted and expired · ${monitors.length}`}</summary>
      <ul>
        {monitors.map((m) => (
          <li key={m.id} data-ref={m.id}>
            <span className="nxd-name">{monitorName(m)}</span>
            <span>{`${fieldWords(m.field, Boolean(m.legs))} ${m.direction === "below" ? "≤" : "≥"} ${m.threshold}`}</span>
            <span className="nx-meta">{reason(m)}</span>
            <MonitorControls rule={ruleOfMonitor(m)} served={null} />
          </li>
        ))}
      </ul>
    </details>
  );
}

// ---- a row

/** The state a row is drawn in, which the row's tint and its chip answer to. */
function stateOf(row: DeskRow): string {
  const a = attentionOf(row);
  return a ?? "calm";
}

function Row({ row, ctx, bracket }: { row: DeskRow; ctx: Ctx; bracket?: "top" | "through" | "bottom" }) {
  const id = rowId(row);
  const shown = new Set(ctx.columns.map((c) => c.key));
  const isRule = row.kind === "rule";
  // the fill bar sits beside the sentence, and falls back to the name when the sentence drops
  const barIn = shown.has("alarm") ? "alarm" : "name";
  return (
    <div className="nxd-row nxd-grid" data-ref={id} data-kind={row.kind} data-state={stateOf(row)}
         data-nested={isRule && row.nested ? "" : undefined}
         data-selected={ctx.selected === id ? "" : undefined}
         data-cursor={ctx.cursor === id ? "" : undefined}
         onClick={() => ctx.select(id)}>
      {bracket ? <span className="nxd-bracket" data-part={bracket} aria-hidden="true" /> : null}
      {ctx.columns.map((c) => (
        <span key={c.key} data-col={c.key} data-align={c.align}>
          {c.key === "name" ? <NameCell row={row} ctx={ctx} /> : <Cell row={row} column={c} privacy={ctx.privacy} />}
          {barIn === c.key && row.kind === "rule" ? <Fill entry={row.entry} /> : null}
        </span>
      ))}
    </div>
  );
}

function NameCell({ row, ctx }: { row: DeskRow; ctx: Ctx }) {
  const a = attentionOf(row);
  return (
    <>
      <button type="button" className="nxd-name" aria-expanded={ctx.selected === rowId(row)}
              aria-controls={ctx.selected === rowId(row) ? ctx.inspectorId : undefined}
              onClick={(e) => { e.stopPropagation(); ctx.select(rowId(row)); }}>
        {rowName(row)}
      </button>
      {a ? <AttentionChip kind={a} /> : null}
    </>
  );
}

/** A rule's state is the attention family's chip (Book.tsx's `Chip`); a holding's Level and its
 *  Manage-by are drawn as the needs-you line draws them, with their kinds' glyphs. */
export function AttentionChip({ kind }: { kind: NonNullable<ReturnType<typeof attentionOf>> }) {
  if (kind === "fault" || kind === "entry" || kind === "alarm") return <Chip state={kind} />;
  return (
    <span className="nx-chip" data-kind={kind}>
      <Glyph kind={kind} />{ATTENTION_WORDS[kind]}
    </span>
  );
}

/** One figure. The visually hidden label says which figure it is to a reader that does not see
 *  the header above it — the rows are a grid of spans, not a `<table>`. */
export function Cell({ row, column, privacy }: { row: DeskRow; column: DeskColumn; privacy: boolean }) {
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
  const label = column.key === "value" && row.kind === "holding" ? "cost to close" : column.label;
  if (column.key === "pnl" && row.kind === "holding") {
    return <><span className="sr-only">{`${label} `}</span><span className="nxd-v"><Money value={row.holding.pnl} privacy={privacy} /></span></>;
  }
  // positive is BEHIND the plan: costing more to close than it should by now
  const outcome = column.key === "pace_gap" && row.kind === "holding" ? paceOutcome(row.holding.schedule?.pace_gap) : undefined;
  return (
    <>
      <span className="sr-only">{`${label} `}</span>
      <span className="nxd-v" data-outcome={outcome}>{text}</span>
    </>
  );
}

/** How far the watched figure has come toward its threshold, as the service measured it. */
export function Fill({ entry }: { entry: Entry }) {
  if (entry.fill === null || entry.error) return null;
  const fill = Math.max(0, Math.min(100, entry.fill));
  return (
    <span className="nxd-fill" data-fill={String(entry.fill)} role="meter" aria-valuenow={fill}
          aria-valuemin={0} aria-valuemax={100} aria-label="toward its threshold">
      <i style={{ width: `${fill}%` }} />
    </span>
  );
}

// ---- the inspector

function Inspector({ id, row, mode, privacy, rows, partners, onSelect, onClose, monitors, writes }: {
  id: string; row: DeskRow; mode: Mode; privacy: boolean; rows: DeskRow[]; partners: Map<string, Holding>;
  onSelect: (id: string) => void; onClose: () => void; monitors: Monitor[]; writes?: HoldingWrites;
}) {
  const name = rowName(row);
  // the focus follows what was opened, so a keyboard reader lands on it
  const heading = useRef<HTMLHeadingElement>(null);
  const subject = rowId(row);
  useEffect(() => { heading.current?.focus(); }, [subject]);
  return (
    <aside id={id} className="nxd-inspector" aria-label={`inspector: ${name}`}>
      <div className="nxd-insp-head">
        <h3 ref={heading} tabIndex={-1}>{name}</h3>
        <button type="button" className="nxd-close" aria-label="close the inspector" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>
      {/* the heading and its close stay outside: a detail that cannot be drawn can still be shut */}
      <DetailBoundary key={subject} what={row.kind === "holding" ? "holding" : "rule"}>
        {row.kind === "holding" ? <HoldingDetail row={row} mode={mode} privacy={privacy} partners={partners} onSelect={onSelect} />
          : row.kind === "rule" ? <RuleDetail entry={row.entry} rows={rows} overlap={row.overlap ?? null} />
            : <QuarantinedDetail row={row} />}
        <p className="nx-meta nxd-note">{mode === "live" ? "live: updates with every poll" : "as last valued"}</p>
        {/* edit, close or delete (#294): keyed by the holding, so a form left open on one is not
            carried to the next row selected */}
        {row.kind === "holding" && writes ? (
          <HoldingActions key={row.holding.id} holding={row.holding} monitors={monitors} rules={row.rules}
                          privacy={privacy} writes={writes} />
        ) : null}
      </DetailBoundary>
    </aside>
  );
}

/** Every column's figure for this row, in both modes, whether the table drew it or not. */
function Figures({ row, privacy, extra = [] }: { row: DeskRow; privacy: boolean; extra?: [string, React.ReactNode][] }) {
  const seen = new Set<string>();
  const items: [string, React.ReactNode][] = [];
  for (const c of [...COLUMNS.live, ...COLUMNS.review]) {
    // the strip is drawn whole beneath, with its words
    if (c.key === "name" || c.key === "alarm" || c.key === "legs" || c.key === "strip" || seen.has(c.key)) continue;
    seen.add(c.key);
    const text = c.text(row, privacy);
    if (text === "") continue;
    const label = c.key === "value" && row.kind === "holding" ? "cost to close"
      : c.key === "delta" && row.kind === "holding" ? "short leg Δ" : c.label;
    items.push([label, c.key === "pnl" && row.kind === "holding"
      ? <Money value={row.holding.pnl} privacy={privacy} /> : text]);
  }
  items.push(...extra);
  return (
    <dl className="nxd-kv">
      {items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

function HoldingDetail({ row, mode, privacy, partners, onSelect }: {
  row: Extract<DeskRow, { kind: "holding" }>; mode: Mode; privacy: boolean; partners: Map<string, Holding>;
  onSelect: (id: string) => void;
}) {
  const h: Holding = row.holding;
  const s = h.schedule;
  const g = h.greeks;
  const greek = (k: string, places: number) => (g[k] === null || g[k] === undefined ? "—" : g[k]!.toFixed(places));
  const extra: [string, React.ReactNode][] = [
    ["entry", h.entry === null ? "—" : h.entry.toFixed(2)],
    // privacy hides the count too: contracts × points × the contract size is the money it hides
    ["contracts", privacy ? "×•••" : `×${h.contracts}`],
    ["position Δ", greek("option_delta", 3)],
    ["position γ", greek("option_gamma", 4)],
    ["position θ", greek("option_theta", 2)],
    ["position vega", greek("option_vega", 2)],
  ];
  if (s) {
    extra.push(["target", s.target === null ? "—" : s.target.toFixed(2)]);
    extra.push(["stop", s.stop === null ? "—" : s.stop.toFixed(2)]);
  }
  // the condor's other spread, when placement bracketed the two
  const partner = partners.get(h.id) ?? null;
  return (
    <>
      <p className="nx-meta">
        {`${h.strike_date} · ${h.dte} DTE${h.opened_at ? ` · opened ${h.opened_at}` : " · Opened not recorded"}`}
      </p>
      {partner ? (
        <button type="button" className="nxd-link" onClick={() => onSelect(partner.id)}>
          {`condor with ${partner.name} →`}
        </button>
      ) : null}
      <Legs legs={h.legs.map((l) => `${l.side} ${l.option_type} ${l.strike}`)} />
      <InspectorStrip holding={h} partner={partner} />
      {/* REVIEW's charts (ADR 0023, #295): the recorded days, read once when opened */}
      {mode === "review" ? <HoldingHistory holding={h} privacy={privacy} /> : null}
      <HoldingPayoff holding={h} privacy={privacy} />
      <Figures row={row} privacy={privacy} extra={extra} />
      <PaceExplained holding={h} />
      <Monitors entries={row.rules} />
    </>
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

function RuleDetail({ entry, rows, overlap }: { entry: Entry; rows: DeskRow[]; overlap: string | null }) {
  const under = rows.filter((r): r is Extract<DeskRow, { kind: "rule" }> =>
    r.kind === "rule" && r.nested && !r.entry.legs && r.entry.in_combos.includes(entry.id) && !r.entry.held);
  return (
    <>
      {/* a combo drawn in the watchlist because it names a contract its holding does not hold is a
          watched spread here too (#346): its note says what it shares, in place of "on something
          held", and its payoff is drawn at its current value */}
      <p className="nx-meta">
        {`${entry.strike_date} · ${entry.dte} DTE`
          + (overlap ? "" : ` · ${entry.held ? "on something held" : "watch only"}`)}
      </p>
      {overlap ? <p className="nx-meta" data-overlap="">{overlap}</p> : null}
      {entry.legs ? <Legs legs={entry.legs.map((l) => `${l.sign < 0 ? "short" : "long"} ${l.option_type} ${l.strike}`)} /> : null}
      {entry.legs ? <StrikeStrip strip={stripOfEntry(entry)!} /> : null}
      {entry.legs && (!entry.held || overlap) ? <WatchedPayoff entry={entry} /> : null}
      {/* every figure of its contract or combo, the reason beside each dash (#332) */}
      <RuleFigures entry={entry} className="nxd-kv" />
      {entry.error ? <p className="nxd-why">{entry.error}</p> : null}
      <Monitors entries={[entry, ...under.map((r) => r.entry)]} />
    </>
  );
}

function QuarantinedDetail({ row }: { row: Extract<DeskRow, { kind: "quarantined" }> }) {
  const m = row.monitor;
  const text = COLUMNS.live.find((c) => c.key === "alarm")!.text(row, false);
  return (
    <>
      <p className="nx-meta">{`${m.strike_date} · ${m.code}`}</p>
      <div className="nxd-monitor" data-state="fault">
        <AttentionChip kind="fault" />
        <span>{text}</span>
      </div>
      <p className="nx-meta">Nothing watches what this rule watched until it is fixed or removed.</p>
      <MonitorControls rule={ruleOfMonitor(m)} served={null} />
    </>
  );
}

function Legs({ legs }: { legs: string[] }) {
  return (
    <ul className="nxd-legs" aria-label="legs">
      {legs.map((l, i) => <li key={`${i}:${l}`}>{l}</li>)}
    </ul>
  );
}

function Monitors({ entries }: { entries: Entry[] }) {
  if (entries.length === 0) return <p className="nx-meta">No Monitors on it.</p>;
  return (
    <div className="nxd-monitors">
      <h4>Monitors</h4>
      <ul>
        {entries.map((e) => {
          const row: DeskRow = { kind: "rule", entry: e, nested: false };
          const a = attentionOf(row);
          return (
            <li key={e.id} className="nxd-monitor" data-state={a ?? "calm"}>
              {a ? <AttentionChip kind={a} /> : null}
              <span>{COLUMNS.live.find((c) => c.key === "alarm")!.text(row, false)}</span>
              <Fill entry={e} />
              <MonitorControls rule={ruleOfEntry(e)} served={e} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

