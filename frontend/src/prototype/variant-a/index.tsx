/** PROTOTYPE — throwaway. Variant A, "Desk terminal".
 *
 *  The structural idea: ONE dense grouped table (holdings, then the watchlist, each by expiry)
 *  beside a persistent, NON-MODAL inspector, driven from the keyboard (⌘K, j/k). Nothing is a
 *  card. On a phone the same table becomes a two-line list and the inspector a full-screen sheet
 *  that Back closes.
 */
import { Ban, Bell, CheckCircle2, ChevronLeft, Clock, Command, Plus, Search, Target, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Alert, Book, Candidate, Closed, Holding, Need, Prefs, Side } from "../data";
import type { Mode, VariantProps } from "../types";
import { Burndown, IvSpark, PayoffChart, StrikeStrip, sigma, type Wing } from "./charts";
import * as f from "./fmt";
import "./va.css";

export const name = "Desk terminal";

type Row =
  | { kind: "holding"; item: Holding }
  | { kind: "candidate"; item: Candidate }
  | { kind: "closed"; item: Closed };

interface Override { threshold: number; direction: "above" | "below" }

const TODAY = "2026-11-10";

// ---------------------------------------------------------------------------------------------
// small pieces

function useWide() {
  const q = "(min-width: 900px)";
  const [wide, setWide] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

const decimals = (field: string) => (field.includes("Δ") ? 3 : 2);

/** An alert as the owner last left it: local edits applied, state and sentence recomputed. */
function effective(a: Alert, o: Override | undefined): Alert {
  const threshold = o?.threshold ?? a.threshold;
  const direction = o?.direction ?? a.direction;
  const dp = decimals(a.field);
  const op = direction === "above" ? "≥" : "≤";
  if (a.state === "quarantined" || a.state === "muted" || a.current == null) {
    return { ...a, threshold, direction, sentence: `${a.field} ${op} ${threshold.toFixed(dp)}${a.current == null ? " — no figure" : ""}` };
  }
  const cur = a.current;
  const hit = direction === "above" ? cur >= threshold : cur <= threshold;
  const fill = !o ? a.fill : Math.max(0, Math.min(100, Math.round(direction === "above" ? (cur / threshold) * 100 : (threshold / cur) * 100)));
  const state = !o ? a.state : hit ? "fired" : fill >= 80 ? "near" : "armed";
  const away = Math.abs(threshold - cur).toFixed(dp);
  const sentence = hit
    ? `${a.field} ${op} ${threshold.toFixed(dp)} — now ${cur.toFixed(dp)}, crossed`
    : `${a.field} ${op} ${threshold.toFixed(dp)} — now ${cur.toFixed(dp)}, ${away} away`;
  return { ...a, threshold, direction, fill, state, sentence };
}

function StateChip({ a, prefs, quiet = false }: { a: Alert; prefs: Prefs; quiet?: boolean }) {
  const opp = a.kind === "entry" && prefs.entryStyle === "distinct";
  if (a.state === "fired") {
    return opp
      ? <span className="va-chip fired opp"><Target />entry</span>
      : <span className="va-chip fired"><Bell />fired</span>;
  }
  if (a.state === "quarantined") return <span className="va-chip quarantined"><Ban />off</span>;
  if (a.state === "muted") return <span className="va-chip muted">muted</span>;
  if (a.state === "near") return <span className="va-chip near">near</span>;
  return quiet ? null : <span className="va-chip armed">armed</span>;
}

function Bar({ a, prefs }: { a: Alert; prefs: Prefs }) {
  const opp = a.kind === "entry" && prefs.entryStyle === "distinct";
  return (
    <span className={`va-bar ${a.state} ${opp ? "opp" : ""}`} title={`${a.fill}% of the way to the threshold`}>
      <i style={{ width: `${a.state === "quarantined" ? 0 : a.fill}%` }} />
    </span>
  );
}

const NEED_ICON: Record<Need["kind"], ReactNode> = {
  risk: <Bell />, entry: <Target />, fault: <Ban />, target: <CheckCircle2 />, manage: <Clock />,
};
const NEED_WORD: Record<Need["kind"], string> = {
  risk: "alarm", entry: "entry", fault: "fault", target: "target", manage: "manage",
};

function wingsOf(row: Row, book: Book): Wing[] {
  if (row.kind === "closed") {
    const c = row.item;
    return [{ side: c.side, short: c.short, long: c.long, credit: c.entry, contracts: c.contracts, shortDelta: null }];
  }
  const it = row.item;
  const own: Wing = {
    side: it.side, short: it.short, long: it.long,
    credit: row.kind === "holding" ? row.item.entry : (it.value ?? 0),
    contracts: row.kind === "holding" ? row.item.contracts : 1, shortDelta: it.shortDelta,
  };
  if (row.kind === "holding" && row.item.pairedWith) {
    const o = book.holdings.find((h) => h.id === row.item.pairedWith);
    if (o) {
      const other: Wing = { side: o.side, short: o.short, long: o.long, credit: o.entry, contracts: o.contracts, shortDelta: o.shortDelta };
      return o.side === "put" ? [other, own] : [own, other];
    }
  }
  return [own];
}

const rowId = (r: Row) => r.item.id;
const rowName = (r: Row) => r.item.name;

// ---------------------------------------------------------------------------------------------

export function VariantA({ book, mode, setMode, prefs, setPrefs }: VariantProps) {
  const wide = useWide();
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [selected, setSelected] = useState<string | null>(() => book.needs[0]?.refId ?? book.holdings[0]?.id ?? null);
  const [palette, setPalette] = useState(false);
  const [adding, setAdding] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const sheetRef = useRef(false);

  const say = useCallback((t: string) => {
    setToast(t);
    window.setTimeout(() => setToast((cur) => (cur === t ? null : cur)), 2400);
  }, []);

  const alertsOf = useCallback((xs: Alert[]) => xs.map((a) => effective(a, overrides[a.id])), [overrides]);

  // holdings by expiry, a condor's two spreads adjacent (puts first, as they sit on the axis)
  const holdingRows: Row[] = useMemo(() => [...book.holdings]
    .sort((a, b) => a.expiry.localeCompare(b.expiry) || a.short - b.short)
    .map((item) => ({ kind: "holding", item })), [book.holdings]);
  const candidateRows: Row[] = useMemo(() => book.candidates.map((item) => ({ kind: "candidate", item })), [book.candidates]);
  const closedRows: Row[] = useMemo(() => book.closed.map((item) => ({ kind: "closed", item })), [book.closed]);
  const allRows = useMemo(() => [...holdingRows, ...candidateRows, ...(mode === "review" ? closedRows : [])],
    [holdingRows, candidateRows, closedRows, mode]);
  const current = allRows.find((r) => rowId(r) === selected) ?? null;

  // ---- phone sheet: one history entry, so Back closes it
  const openSheet = useCallback(() => {
    if (sheetRef.current) return;
    sheetRef.current = true;
    history.pushState({ vaSheet: true }, "", location.href);
    setSheet(true);
  }, []);
  const closeSheet = useCallback(() => {
    if (!sheetRef.current) return;
    history.back();
  }, []);
  useEffect(() => {
    const onPop = () => { if (sheetRef.current) { sheetRef.current = false; setSheet(false); setAdding(false); } };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const select = useCallback((id: string) => {
    setSelected(id);
    setAdding(false);
    if (!wide) openSheet();
  }, [wide, openSheet]);
  const startAdd = useCallback(() => {
    setAdding(true);
    if (!wide) openSheet();
  }, [wide, openSheet]);

  // ---- keyboard: ⌘K or / opens the palette; j/k walk the rows; a adds; Esc backs out
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); return; }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (palette) return;
      if (e.key === "/") { e.preventDefault(); setPalette(true); }
      else if (e.key === "a") { e.preventDefault(); startAdd(); }
      else if (e.key === "Escape") { setAdding(false); }
      else if (e.key === "j" || e.key === "k") {
        const i = allRows.findIndex((r) => rowId(r) === selected);
        const next = allRows[Math.max(0, Math.min(allRows.length - 1, i + (e.key === "j" ? 1 : -1)))];
        if (next) { setSelected(rowId(next)); setAdding(false); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [allRows, selected, palette, startAdd]);

  const edit = (id: string, o: Override) => { setOverrides((m) => ({ ...m, [id]: o })); say("alert updated (prototype — not saved)"); };

  const inspector = adding
    ? <AddFlow book={book} prefs={prefs} onCancel={() => (wide ? setAdding(false) : closeSheet())}
               onSave={() => { say("prototype — not saved"); if (wide) setAdding(false); else closeSheet(); }} />
    : current
      ? <Inspector row={current} book={book} mode={mode} prefs={prefs} alertsOf={alertsOf} edit={edit}
                   go={(id) => { setSelected(id); }} say={say} />
      : <div className="va-insp-in dim">Select a row (j/k) or press ⌘K.</div>;

  const cls = `va ${prefs.upColor === "red" ? "up-red" : ""} ${wide ? "desk" : "phone"}`;

  return (
    <div className={cls}>
      {wide ? (
        <header className="va-head">
          <span className="va-brand">optionality<b>›</b></span>
          <Refs book={book} />
          <Fresh book={book} />
          <span className="va-spacer" />
          <ModeTabs mode={mode} setMode={setMode} />
          <button className="va-kbd" onClick={() => setPalette(true)}><Search size={13} />Jump, add, switch<kbd>⌘K</kbd></button>
          <button className="va-iconbtn" aria-label="add a spread" onClick={startAdd}><Plus size={16} /></button>
        </header>
      ) : (
        <>
          <header className="va-head">
            <span className="va-brand">opt<b>›</b></span>
            <span className="va-spacer" />
            <ModeTabs mode={mode} setMode={setMode} />
            <button className="va-iconbtn" aria-label="search and commands" onClick={() => setPalette(true)}><Command size={18} /></button>
          </header>
          <div className="va-strip"><Refs book={book} /><Fresh book={book} /></div>
        </>
      )}

      <Needs needs={book.needs} prefs={prefs} onPick={select} />

      {wide ? (
        <div className="va-body">
          <div className="va-tablewrap" role="grid" aria-label="book">
            <Section title="Holdings" count={holdingRows.length} hint={mode === "live" ? "j/k to move · ⌘K to jump" : "since opened"} />
            <DeskRows rows={holdingRows} book={book} mode={mode} prefs={prefs} selected={selected} select={select} alertsOf={alertsOf} />
            <Section title="Watchlist" count={candidateRows.length} hint="entry signals on spreads you don't hold" />
            <DeskRows rows={candidateRows} book={book} mode={mode} prefs={prefs} selected={selected} select={select} alertsOf={alertsOf} />
            {mode === "review" && (
              <>
                <Section title="Closed" count={closedRows.length} hint="realised" />
                <DeskRows rows={closedRows} book={book} mode={mode} prefs={prefs} selected={selected} select={select} alertsOf={alertsOf} />
              </>
            )}
            <div style={{ height: 80 }} />
          </div>
          <aside className="va-insp" aria-label="inspector">{inspector}</aside>
        </div>
      ) : (
        <div className="va-list">
          <Section title="Holdings" count={holdingRows.length} />
          <PhoneRows rows={holdingRows} book={book} mode={mode} prefs={prefs} select={select} alertsOf={alertsOf} />
          <Section title="Watchlist" count={candidateRows.length} />
          <PhoneRows rows={candidateRows} book={book} mode={mode} prefs={prefs} select={select} alertsOf={alertsOf} />
          {mode === "review" && (
            <>
              <Section title="Closed" count={closedRows.length} />
              <PhoneRows rows={closedRows} book={book} mode={mode} prefs={prefs} select={select} alertsOf={alertsOf} />
            </>
          )}
        </div>
      )}

      {!wide && !sheet && (
        <button className="va-fab" aria-label="add a spread" onClick={startAdd}><Plus size={24} /></button>
      )}

      {!wide && sheet && (
        <div className="va-sheet" role="dialog" aria-label={adding ? "add a spread" : current ? rowName(current) : "detail"}>
          <div className="va-sheet-head">
            <button className="va-iconbtn" aria-label="back" onClick={closeSheet}><ChevronLeft size={22} /></button>
            <span className="t">{adding ? "Add a spread" : current ? rowName(current) : ""}</span>
          </div>
          <div className="va-sheet-body">{inspector}</div>
        </div>
      )}

      {palette && (
        <Palette rows={allRows} mode={mode} prefs={prefs} close={() => setPalette(false)}
                 run={(cmd) => {
                   setPalette(false);
                   if (cmd.type === "row") select(cmd.id);
                   else if (cmd.type === "add") startAdd();
                   else if (cmd.type === "mode") setMode(cmd.mode);
                   else if (cmd.type === "prefs") setPrefs(cmd.prefs);
                 }} />
      )}
      {toast && <div className="va-toast" role="status">{toast}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function ModeTabs({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <div className="va-tabs" role="group" aria-label="mode">
      <button aria-pressed={mode === "live"} onClick={() => setMode("live")}>LIVE</button>
      <button aria-pressed={mode === "review"} onClick={() => setMode("review")}>REVIEW</button>
    </div>
  );
}

function Refs({ book }: { book: Book }) {
  return (
    <>
      {book.references.map((r, i) => r.error ? (
        <span key={i} className="va-ref err" title={r.error}>
          <span className="lbl">{r.label}</span><span className="src">{r.source}</span>
          <span className="why">— {r.error}</span>
        </span>
      ) : (
        <span key={i} className="va-ref">
          <span className="lbl">{r.label}</span>
          <span className="num">{f.spx(r.figure)}</span>
          <span className={`num ${r.change != null && r.change >= 0 ? "up" : "down"}`}>{f.chg(r.change)}</span>
          <span className="src">{r.source}</span>
        </span>
      ))}
    </>
  );
}

function Fresh({ book }: { book: Book }) {
  const tz = book.displayTz === "Asia/Singapore" ? "SGT" : book.displayTz;
  return (
    <span className="va-fresh" title={`the last sweep; the service sweeps every ${book.sweepSeconds}s`}>
      <span className={`va-dot ${book.provider.ok ? "" : "bad"}`} />
      {book.provider.name} {book.provider.ok ? "ok" : "down"} · as of <span className="num">{f.clock(book.asOf)}</span> {tz}
    </span>
  );
}

function Needs({ needs, prefs, onPick }: { needs: Need[]; prefs: Prefs; onPick: (id: string) => void }) {
  // silence is not a verdict: with nothing to say the line is simply absent, never "all clear"
  if (needs.length === 0) return null;
  return (
    <nav className="va-needs" aria-label="needs you">
      <span className="caps">Needs you</span>
      {needs.map((n, i) => {
        const same = n.kind === "entry" && prefs.entryStyle === "same";
        return (
          <button key={i} className={`va-need ${n.kind} ${same ? "same" : ""}`} onClick={() => onPick(n.refId)}>
            {same ? <Bell /> : NEED_ICON[n.kind]}
            <span><b style={{ fontWeight: 700, textTransform: "uppercase", fontSize: "0.85em", letterSpacing: "0.05em" }}>{NEED_WORD[n.kind]}</b> {n.text}</span>
          </button>
        );
      })}
    </nav>
  );
}

function Section({ title, count, hint }: { title: string; count: number; hint?: string }) {
  return (
    <div className="va-section">
      <h2>{title}</h2><span className="count">{count}</span>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// the desk table

const COLS = {
  holdLive: "minmax(96px,1fr) 86px 28px 46px 46px 64px 46px 96px minmax(270px,2.8fr)",
  holdReview: "minmax(96px,1fr) 86px 58px 64px 86px minmax(150px,1.4fr) 56px minmax(240px,2.2fr)",
  cand: "minmax(130px,1.2fr) 92px 52px 50px 52px 120px minmax(260px,2.6fr)",
  candReview: "minmax(130px,1.2fr) 92px 52px 50px 52px minmax(260px,2.6fr)",
  closed: "minmax(110px,1.1fr) 92px 120px 52px 52px 74px 80px 50px",
};

function groupBy<T>(xs: T[], key: (x: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return [...m.entries()];
}

const expiryOf = (r: Row) => r.item.expiry;

function DeskRows({ rows, book, mode, prefs, selected, select, alertsOf }: {
  rows: Row[]; book: Book; mode: Mode; prefs: Prefs; selected: string | null; select: (id: string) => void;
  alertsOf: (xs: Alert[]) => Alert[];
}) {
  if (rows.length === 0) return <div className="va-grp">nothing here</div>;
  const kind = rows[0]!.kind;
  const tpl = kind === "holding" ? (mode === "live" ? COLS.holdLive : COLS.holdReview)
    : kind === "candidate" ? (mode === "live" ? COLS.cand : COLS.candReview) : COLS.closed;
  const head = kind === "holding"
    ? mode === "live"
      ? ["spread", "strikes", "qty", "entry", "cost", "p&l", "Δ", "spx · strikes", "alerts"]
      : ["spread", "strikes", "p&l pts", "p&l", "captured", "pace vs plan", "→ manage", "alerts"]
    : kind === "candidate"
      ? mode === "live" ? ["spread", "strikes", "value", "Δ", "iv", "spx · strikes", "entry signals"]
        : ["spread", "strikes", "value", "Δ", "iv", "entry signals"]
      : ["spread", "strikes", "held", "entry", "exit", "realised", "realised $", "days"];
  const right = new Set(kind === "holding"
    ? mode === "live" ? [2, 3, 4, 5, 6] : [2, 3, 4, 6]
    : kind === "candidate" ? [2, 3, 4] : [3, 4, 5, 6, 7]);

  return (
    <div>
      <div className="va-colhead" style={{ gridTemplateColumns: tpl }}>
        {head.map((h, i) => <span key={h} className={right.has(i) ? "r" : ""}>{h}</span>)}
      </div>
      {groupBy(rows, expiryOf).map(([exp, rs]) => (
        <div key={exp} role="rowgroup">
          <div className="va-grp">{f.mmmdd(exp)} <span className="num">{rs[0]!.kind === "closed" ? "expired/closed" : `${(rs[0]!.item as Holding).dte} DTE`}</span></div>
          {rs.map((r, i) => {
            const next = rs[i + 1], prev = rs[i - 1];
            const pairTop = r.kind === "holding" && next?.kind === "holding" && r.item.pairedWith === next.item.id;
            const pairBot = r.kind === "holding" && prev?.kind === "holding" && r.item.pairedWith === prev.item.id;
            return (
              <div key={rowId(r)} role="row" aria-selected={selected === rowId(r)} tabIndex={-1}
                   className={`va-row ${r.kind === "candidate" && r.item.alerts.every((a) => a.state === "quarantined") ? "off" : ""}`}
                   style={{ gridTemplateColumns: tpl }} onClick={() => select(rowId(r))}>
                {pairTop && <span className="va-bracket top" title="recorded as one condor" />}
                {pairBot && <span className="va-bracket bot" title="recorded as one condor" />}
                <DeskCells r={r} book={book} mode={mode} prefs={prefs} alertsOf={alertsOf} />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

const ABBR: Record<string, string> = { "cost to close": "cost", "short Δ": "Δ", "spread value": "value" };

function AlertsInline({ alerts, prefs, wordy }: { alerts: Alert[]; prefs: Prefs; wordy: boolean }) {
  return (
    <span className="va-alerts">
      {alerts.map((a) => (
        <span key={a.id} className="va-al" title={a.sentence}>
          <StateChip a={a} prefs={prefs} quiet />
          {/* a fired chip already says how far along it is */}
          {a.state !== "quarantined" && a.state !== "fired" && <Bar a={a} prefs={prefs} />}
          <span className={wordy ? "" : "dim"} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {wordy ? a.sentence : `${ABBR[a.field] ?? a.field} ${a.direction === "above" ? "≥" : "≤"} ${a.threshold.toFixed(decimals(a.field))}`}
          </span>
        </span>
      ))}
    </span>
  );
}

function DeskCells({ r, book, mode, prefs, alertsOf }: { r: Row; book: Book; mode: Mode; prefs: Prefs; alertsOf: (xs: Alert[]) => Alert[] }) {
  if (r.kind === "closed") {
    const c = r.item;
    const held = Math.round((Date.parse(c.closedOn) - Date.parse(c.opened)) / 86400000);
    return (
      <>
        <span className="name">{c.name}</span>
        <span className="strikes">{f.strikes(c.side, c.short, c.long)}</span>
        <span className="num dim">{f.md(c.opened)} → {f.md(c.closedOn)}</span>
        <span className="num r">{f.pts(c.entry)}</span>
        <span className="num r">{f.pts(c.exit)}</span>
        <span className={`num r ${f.gainClass(c.realizedPoints)}`}>{f.signedPts(c.realizedPoints)}</span>
        <span className={`num r ${f.gainClass(c.realizedDollars)}`}>{f.usd(c.realizedDollars, prefs)}</span>
        <span className="num r dim">{held}</span>
      </>
    );
  }
  const it = r.item;
  const alerts = alertsOf(it.alerts);
  const sd = sigma(book.spot, it.shortIv, it.dte);
  const strip = <StrikeStrip compact spot={book.spot} sd={sd}
    wings={[{ side: it.side, short: it.short, long: it.long, credit: 0, contracts: 1, shortDelta: it.shortDelta }]} />;
  if (r.kind === "holding") {
    const h = r.item;
    if (mode === "live") {
      return (
        <>
          <span className="name">{h.name}</span>
          <span className="strikes">{f.strikes(h.side, h.short, h.long)}</span>
          <span className="num r dim">×{h.contracts}</span>
          <span className="num r dim">{f.pts(h.entry)}</span>
          <span className="num r">{f.pts(h.value)}</span>
          <span className={`num r ${f.gainClass(h.pnlDollars)}`}>{f.usd(h.pnlDollars, prefs)}</span>
          <span className="num r">{f.delta(h.shortDelta)}</span>
          {strip}
          <AlertsInline alerts={alerts} prefs={prefs} wordy={false} />
        </>
      );
    }
    const diff = (h.value ?? 0) - h.plannedToday;
    return (
      <>
        <span className="name">{h.name}</span>
        <span className="strikes">{f.strikes(h.side, h.short, h.long)}</span>
        <span className={`num r ${f.gainClass(h.pnlPoints)}`}>{f.signedPts(h.pnlPoints)}</span>
        <span className={`num r ${f.gainClass(h.pnlDollars)}`}>{f.usd(h.pnlDollars, prefs)}</span>
        <span className="r" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span className="va-bar" style={{ width: 36 }}><i style={{ width: `${Math.max(0, Math.min(100, h.captured * 100))}%`, background: h.captured >= 0 ? "var(--up)" : "var(--down)" }} /></span>
          <span className={`num ${f.gainClass(h.captured)}`}>{f.pct(h.captured)}</span>
        </span>
        <span className={`va-pace ${h.pace === "behind" ? "behind" : h.pace === "ahead" ? "ahead" : ""}`}>
          {h.pace}{h.pace !== "on pace" && <span className="num dim"> · {Math.abs(diff).toFixed(2)} {diff > 0 ? "over" : "under"} plan</span>}
        </span>
        <span className="num r dim">{h.dte - h.manageByDte}d</span>
        <AlertsInline alerts={alerts} prefs={prefs} wordy={false} />
      </>
    );
  }
  const c = r.item;
  return (
    <>
      <span className="name">{c.name}</span>
      <span className="strikes">{f.strikes(c.side, c.short, c.long)}</span>
      <span className="num r">{f.pts(c.value)}</span>
      <span className="num r">{f.delta(c.shortDelta)}</span>
      <span className="num r dim">{f.iv(c.shortIv)}</span>
      {mode === "live" && strip}
      <AlertsInline alerts={alerts} prefs={prefs} wordy={alerts.length === 1} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// the phone list: the same groups, two lines a row

function PhoneRows({ rows, book, mode, prefs, select, alertsOf }: {
  rows: Row[]; book: Book; mode: Mode; prefs: Prefs; select: (id: string) => void; alertsOf: (xs: Alert[]) => Alert[];
}) {
  return (
    <>
      {groupBy(rows, expiryOf).map(([exp, rs]) => (
        <div key={exp}>
          <div className="va-grp">{f.mmmdd(exp)} <span className="num">{rs[0]!.kind === "closed" ? "" : `${(rs[0]!.item as Holding).dte} DTE`}</span></div>
          {rs.map((r, i) => {
            const next = rs[i + 1], prev = rs[i - 1];
            const pairTop = r.kind === "holding" && next?.kind === "holding" && r.item.pairedWith === next.item.id;
            const pairBot = r.kind === "holding" && prev?.kind === "holding" && r.item.pairedWith === prev.item.id;
            return (
              <button key={rowId(r)} className={`va-prow ${r.kind === "candidate" && r.item.alerts.every((a) => a.state === "quarantined") ? "off" : ""}`}
                      onClick={() => select(rowId(r))}>
                {pairTop && <span className="va-bracket top" />}
                {pairBot && <span className="va-bracket bot" />}
                <PhoneCells r={r} book={book} mode={mode} prefs={prefs} alertsOf={alertsOf} />
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
}

function PhoneCells({ r, mode, prefs, alertsOf }: { r: Row; book: Book; mode: Mode; prefs: Prefs; alertsOf: (xs: Alert[]) => Alert[] }) {
  if (r.kind === "closed") {
    const c = r.item;
    return (
      <>
        <span className="l1"><span className="name">{c.name}</span><span className="strikes">{f.strikes(c.side, c.short, c.long)}</span></span>
        <span className={`big ${f.gainClass(c.realizedDollars)}`}>{f.usd(c.realizedDollars, prefs)}</span>
        <span className="l2"><span className="num">{f.pts(c.entry)} → {f.pts(c.exit)}</span><span>closed {f.md(c.closedOn)}</span></span>
      </>
    );
  }
  const alerts = alertsOf(r.item.alerts);
  const worst = alerts.find((a) => a.state === "fired") ?? alerts.find((a) => a.state === "quarantined") ?? alerts.find((a) => a.state === "near") ?? alerts[0];
  if (r.kind === "holding") {
    const h = r.item;
    return (
      <>
        <span className="l1"><span className="name">{h.name}</span><span className="strikes">{f.strikes(h.side, h.short, h.long)} ×{h.contracts}</span></span>
        <span className={`big ${f.gainClass(h.pnlDollars)}`}>{mode === "live" ? f.usd(h.pnlDollars, prefs) : f.pct(h.captured)}</span>
        <span className="l2">
          {mode === "live"
            ? <><span className="num">cost {f.pts(h.value)}</span><span className="num">Δ {f.delta(h.shortDelta)}</span></>
            : <><span className={`va-pace ${h.pace === "behind" ? "behind" : h.pace === "ahead" ? "ahead" : ""}`}>{h.pace}</span><span className="num">{h.dte - h.manageByDte}d → manage</span></>}
          {worst && <><StateChip a={worst} prefs={prefs} quiet />{worst.state !== "quarantined" && <Bar a={worst} prefs={prefs} />}</>}
        </span>
      </>
    );
  }
  const c = r.item;
  return (
    <>
      <span className="l1"><span className="name">{c.name}</span><span className="strikes">{f.strikes(c.side, c.short, c.long)}</span></span>
      <span className="big">{f.pts(c.value)}</span>
      <span className="l2">
        {worst && <><StateChip a={worst} prefs={prefs} quiet />{worst.state !== "quarantined" && <Bar a={worst} prefs={prefs} />}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{worst.state === "quarantined" ? worst.reason : worst.sentence}</span></>}
      </span>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// the inspector: the same content in the desk pane and the phone sheet

function KV({ items }: { items: [string, ReactNode, string?][] }) {
  return (
    <div className="va-kv">
      {items.map(([k, v, c]) => <div key={k}><div className="k">{k}</div><div className={`v ${c ?? ""}`}>{v}</div></div>)}
    </div>
  );
}

function AlertEditor({ a, prefs, edit }: { a: Alert; prefs: Prefs; edit: (id: string, o: Override) => void }) {
  const [open, setOpen] = useState(false);
  const [thr, setThr] = useState(String(a.threshold));
  const [dir, setDir] = useState(a.direction);
  return (
    <div className="va-alrow">
      <StateChip a={a} prefs={prefs} />
      <div className="sent">
        {open ? (
          <form className="va-edit" onSubmit={(e) => { e.preventDefault(); const n = Number(thr); if (Number.isFinite(n)) { edit(a.id, { threshold: n, direction: dir }); setOpen(false); } }}>
            <span className="dim">{a.field}</span>
            <select aria-label="direction" value={dir} onChange={(e) => setDir(e.target.value as "above" | "below")}>
              <option value="above">≥</option><option value="below">≤</option>
            </select>
            <input aria-label="threshold" inputMode="decimal" value={thr} autoFocus onChange={(e) => setThr(e.target.value)} />
            <button className="va-btn primary" type="submit">set</button>
            <button className="va-btn" type="button" onClick={() => setOpen(false)}>cancel</button>
          </form>
        ) : (
          <>
            <div>{a.sentence}</div>
            {a.reason && <div className="reason">{a.reason}</div>}
            {a.state !== "quarantined" && <div style={{ marginTop: 4 }}><Bar a={a} prefs={prefs} /></div>}
          </>
        )}
      </div>
      {!open && (
        <button className="va-link" onClick={() => { setThr(String(a.threshold)); setDir(a.direction); setOpen(true); }}>
          {a.state === "quarantined" ? "fix" : "edit"}
        </button>
      )}
    </div>
  );
}

function Inspector({ row, book, mode, prefs, alertsOf, edit, go, say }: {
  row: Row; book: Book; mode: Mode; prefs: Prefs; alertsOf: (xs: Alert[]) => Alert[];
  edit: (id: string, o: Override) => void; go: (id: string) => void; say: (t: string) => void;
}) {
  const wings = wingsOf(row, book);
  const dollars = !prefs.privacy;
  if (row.kind === "closed") {
    const c = row.item;
    return (
      <div className="va-insp-in">
        <div>
          <h3>{c.name}</h3>
          <div className="sub">{f.mmmdd(c.expiry)} · {c.side} spread {c.short}/{c.long} · ×{c.contracts} · closed {f.md(c.closedOn)}</div>
        </div>
        <KV items={[
          ["entry", f.pts(c.entry)], ["exit", f.pts(c.exit)], ["realised", f.signedPts(c.realizedPoints), f.gainClass(c.realizedPoints)],
          ["realised $", f.usd(c.realizedDollars, prefs), f.gainClass(c.realizedDollars)], ["opened", f.md(c.opened)],
          ["held", `${Math.round((Date.parse(c.closedOn) - Date.parse(c.opened)) / 86400000)} days`],
        ]} />
        <div className="va-block">
          <span className="caps">Cost to close over the trade</span>
          <Burndown samples={c.samples} entry={c.entry} target={c.entry * 0.5} stop={c.entry * 2}
                    manageBy={c.closedOn} expiry={c.expiry} exitOn={{ date: c.closedOn, value: c.exit }} />
          <BurnLegend exit />
        </div>
        <div className="va-block"><span className="caps">Short IV by day</span><IvSpark samples={c.samples} /></div>
      </div>
    );
  }
  const it = row.item;
  const alerts = alertsOf(it.alerts);
  const sd = sigma(book.spot, it.shortIv, it.dte);
  const paired = row.kind === "holding" && row.item.pairedWith ? book.holdings.find((h) => h.id === row.item.pairedWith) : undefined;

  return (
    <div className="va-insp-in">
      <div>
        <h3>{it.name}</h3>
        <div className="sub">
          {f.mmmdd(it.expiry)} · {it.dte} DTE · {it.side} {it.long == null ? "short leg" : `spread ${it.short}/${it.long}`}
          {row.kind === "holding" && ` · ×${row.item.contracts} · opened ${f.md(row.item.opened)}`}
          {row.kind === "candidate" && " · watch only"}
        </div>
        {paired && <button className="pair va-link" onClick={() => go(paired.id)}>condor with {paired.name} →</button>}
      </div>

      {row.kind === "holding" ? (
        <KV items={[
          ["cost to close", f.pts(row.item.value)], ["entry", f.pts(row.item.entry)],
          ["p&l", f.usd(row.item.pnlDollars, prefs), f.gainClass(row.item.pnlDollars)],
          ["captured", f.pct(row.item.captured), f.gainClass(row.item.captured)],
          ["Δ short", f.delta(row.item.shortDelta)], ["iv short", f.iv(row.item.shortIv)],
          ["pace", row.item.pace, row.item.pace === "behind" ? "loss" : row.item.pace === "ahead" ? "gain" : ""],
          ["plan today", f.pts(row.item.plannedToday)], ["manage-by", `${f.md(row.item.manageBy)} · ${row.item.dte - row.item.manageByDte}d`],
          ["target", f.pts(row.item.target)], ["stop", f.pts(row.item.stop)], ["θ / day", f.pts(row.item.theta)],
        ]} />
      ) : (
        <KV items={[
          ["value", f.pts(it.value)], ["Δ short", f.delta(it.shortDelta)], ["iv short", f.iv(it.shortIv)],
          ["θ / day", f.pts(it.theta)], ["vega", f.pts(it.vega)], ["width", it.width == null ? "—" : String(it.width)],
        ]} />
      )}

      <div className="va-block">
        <span className="caps">Where SPX is · {paired ? "the condor" : "this spread"}{sd ? <> · ±1<span style={{ textTransform: "none" }}>σ</span> to expiry shaded</> : ""}</span>
        <StrikeStrip wings={wings} spot={book.spot} sd={sd} />
      </div>

      {mode === "review" && row.kind === "holding" && (
        <>
          <div className="va-block">
            <span className="caps">Cost to close against the plan</span>
            <Burndown samples={row.item.samples} entry={row.item.entry} target={row.item.target} stop={row.item.stop}
                      manageBy={row.item.manageBy} expiry={row.item.expiry}
                      live={row.item.value == null ? undefined : { date: TODAY, value: row.item.value }} />
            <BurnLegend />
          </div>
          <div className="va-block"><span className="caps">Short IV by day</span><IvSpark samples={row.item.samples} /></div>
        </>
      )}

      <div className="va-block">
        <span className="caps">{row.kind === "holding" ? "Alerts · risk" : "Alerts · entry signals"}</span>
        {alerts.map((a) => <AlertEditor key={a.id} a={a} prefs={prefs} edit={edit} />)}
      </div>

      {it.long != null && (row.kind === "holding" || it.value != null) && (
        <div className="va-block">
          <span className="caps">Payoff at expiry{row.kind === "candidate" ? ` · if sold now at ${f.pts(it.value)}` : paired ? " · both spreads" : ""}</span>
          <PayoffChart wings={wings} spot={book.spot} dollars={dollars} />
          <div className="va-legend"><span>expiry only — no model price before then</span><span>dot: today at expiry prices</span></div>
        </div>
      )}

      {mode === "live" && row.kind === "holding" && (
        <div className="va-block" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="va-btn" onClick={() => say("prototype — close flow not built here")}>Close holding…</button>
          <button className="va-btn" onClick={() => say("prototype — not saved")}>Add an alert</button>
        </div>
      )}
    </div>
  );
}

function BurnLegend({ exit = false }: { exit?: boolean }) {
  return (
    <div className="va-legend">
      <span>● close</span><span>◌ not a close (evening fill)</span>
      {exit ? <span>■ exit</span> : <span>◇ live now</span>}<span>┈ plan (√ decay to target by manage-by)</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// add a spread: one draft, its default alerts pre-filled, a live payoff to catch sign mistakes

function AddFlow({ book, prefs, onCancel, onSave }: { book: Book; prefs: Prefs; onCancel: () => void; onSave: () => void }) {
  const [into, setInto] = useState<"holding" | "watch">("holding");
  const [expiry, setExpiry] = useState("2026-12-18");
  const [side, setSide] = useState<Side>("put");
  const [short, setShort] = useState("7150");
  const [long, setLong] = useState("7100");
  const [qty, setQty] = useState("1");
  const [entry, setEntry] = useState("1.50");
  const k = Number(short), l = Number(long), c = Number(entry), n = Math.max(1, Number(qty) || 1);
  const wrongSide = side === "put" ? l >= k : l <= k;
  const ok = Number.isFinite(k) && Number.isFinite(l) && Number.isFinite(c) && c > 0 && !wrongSide;
  const [defs, setDefs] = useState({ stopOn: true, deltaOn: true, delta: "0.30", valueOn: true, value: "", entryDeltaOn: true, entryDelta: "0.15" });
  const stop = (c * 2).toFixed(2);
  const expiries = [...new Set([...book.candidates, ...book.holdings].map((x) => x.expiry))].sort();

  return (
    <form className="va-insp-in" onSubmit={(e) => { e.preventDefault(); if (ok) onSave(); }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h3 className="va-addtitle" style={{ flex: 1 }}>Add a spread</h3>
        <div className="va-seg" role="group" aria-label="add to">
          <button type="button" aria-pressed={into === "holding"} onClick={() => setInto("holding")}>I hold it</button>
          <button type="button" aria-pressed={into === "watch"} onClick={() => setInto("watch")}>Watch it</button>
        </div>
      </div>
      <div className="va-form">
        <label>expiry
          <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            {expiries.map((x) => <option key={x} value={x}>{f.mmmdd(x)}</option>)}
          </select>
        </label>
        <label>side
          <select value={side} onChange={(e) => { const s = e.target.value as Side; setSide(s); if (s === "call") { setShort("7700"); setLong("7750"); } else { setShort("7150"); setLong("7100"); } }}>
            <option value="put">put spread</option><option value="call">call spread</option>
          </select>
        </label>
        {into === "holding" && <label>contracts<input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} /></label>}
        <label>short strike<input inputMode="decimal" value={short} onChange={(e) => setShort(e.target.value)} /></label>
        <label>long strike
          <input inputMode="decimal" value={long} aria-invalid={wrongSide} onChange={(e) => setLong(e.target.value)}
                 style={wrongSide ? { borderColor: "var(--alarm)" } : undefined} />
        </label>
        <label>{into === "holding" ? "entry credit" : "credit now"}<input inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} /></label>
      </div>
      {wrongSide && <div style={{ color: "var(--alarm)", fontSize: 12 }}>
        A {side} spread's long strike sits {side === "put" ? "below" : "above"} its short — swap them, or change the side.</div>}

      <div className="va-block">
        <span className="caps">{into === "holding" ? "Risk alerts it will start with" : "Entry signals it will start with"}</span>
        {into === "holding" ? (
          <>
            <div className="va-def">
              <label className="va-check"><input type="checkbox" checked={defs.stopOn} onChange={(e) => setDefs({ ...defs, stopOn: e.target.checked })} aria-label="stop alert" /></label>
              <span>cost to close ≥ <b className="num">{Number.isFinite(c) ? stop : "—"}</b> <span className="dim">(2× entry: the stop)</span></span><Bell size={14} />
            </div>
            <div className="va-def">
              <label className="va-check"><input type="checkbox" checked={defs.deltaOn} onChange={(e) => setDefs({ ...defs, deltaOn: e.target.checked })} aria-label="delta alert" /></label>
              <span className="va-edit">short Δ ≥ <input inputMode="decimal" value={defs.delta} onChange={(e) => setDefs({ ...defs, delta: e.target.value })} aria-label="delta threshold" /></span><Bell size={14} />
            </div>
          </>
        ) : (
          <>
            <div className="va-def">
              <label className="va-check"><input type="checkbox" checked={defs.valueOn} onChange={(e) => setDefs({ ...defs, valueOn: e.target.checked })} aria-label="value signal" /></label>
              <span className="va-edit">spread value ≥ <input inputMode="decimal" placeholder={(c * 1.5).toFixed(2)} value={defs.value} onChange={(e) => setDefs({ ...defs, value: e.target.value })} aria-label="value threshold" /></span><Target size={14} />
            </div>
            <div className="va-def">
              <label className="va-check"><input type="checkbox" checked={defs.entryDeltaOn} onChange={(e) => setDefs({ ...defs, entryDeltaOn: e.target.checked })} aria-label="delta signal" /></label>
              <span className="va-edit">short Δ ≥ <input inputMode="decimal" value={defs.entryDelta} onChange={(e) => setDefs({ ...defs, entryDelta: e.target.value })} aria-label="delta signal threshold" /></span><Target size={14} />
            </div>
          </>
        )}
      </div>

      {ok && (
        <div className="va-block">
          <span className="caps">Payoff at expiry · {f.strikes(side, k, l)} {into === "holding" ? `×${n}` : ""} at {c.toFixed(2)}</span>
          <PayoffChart wings={[{ side, short: k, long: l, credit: c, contracts: into === "holding" ? n : 1, shortDelta: null }]}
                       spot={book.spot} dollars={!prefs.privacy} />
          <div className="va-legend">
            <span>max profit {(c).toFixed(2)}</span><span>max loss {(Math.abs(k - l) - c).toFixed(2)}</span>
            <span>breakeven {(side === "put" ? k - c : k + c).toFixed(2)}</span>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button className="va-btn primary" type="submit" disabled={!ok} style={!ok ? { opacity: 0.5 } : undefined}>
          {into === "holding" ? "Record holding + alerts" : "Watch spread + signals"}
        </button>
        <button className="va-btn" type="button" onClick={onCancel}><X size={14} />cancel</button>
      </div>
      <div className="faint" style={{ fontSize: 11 }}>One save creates the {into === "holding" ? "holding and its alerts" : "watch and its signals"} together. Esc cancels.</div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// ⌘K

type Cmd =
  | { type: "row"; id: string; label: string; group: string }
  | { type: "add"; label: string; group: string }
  | { type: "mode"; mode: Mode; label: string; group: string }
  | { type: "prefs"; prefs: Prefs; label: string; group: string };

function Palette({ rows, mode, prefs, close, run }: { rows: Row[]; mode: Mode; prefs: Prefs; close: () => void; run: (c: Cmd) => void }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const all: Cmd[] = [
    { type: "add", label: "Add a spread…", group: "action" },
    { type: "mode", mode: mode === "live" ? "review" : "live", label: `Switch to ${mode === "live" ? "REVIEW" : "LIVE"}`, group: "mode" },
    ...rows.map((r): Cmd => ({ type: "row", id: rowId(r), label: `${rowName(r)}  ${r.kind === "closed" ? f.strikes(r.item.side, r.item.short, r.item.long) : f.strikes(r.item.side, r.item.short, r.item.long)}`, group: r.kind })),
    { type: "prefs", prefs: { ...prefs, upColor: prefs.upColor === "green" ? "red" : "green" }, label: `Up colour: ${prefs.upColor === "green" ? "red" : "green"}`, group: "setting" },
    { type: "prefs", prefs: { ...prefs, entryStyle: prefs.entryStyle === "distinct" ? "same" : "distinct" }, label: `Entry signals look ${prefs.entryStyle === "distinct" ? "like alarms" : "like opportunities"}`, group: "setting" },
    { type: "prefs", prefs: { ...prefs, privacy: !prefs.privacy }, label: prefs.privacy ? "Show $ amounts" : "Hide $ amounts", group: "setting" },
  ];
  const shown = all.filter((c) => c.label.toLowerCase().includes(q.trim().toLowerCase()));
  const cur = Math.min(i, Math.max(0, shown.length - 1));
  return (
    <div className="va-scrim" onClick={close}>
      <div className="va-pal" role="dialog" aria-label="commands" onClick={(e) => e.stopPropagation()}>
        <input autoFocus placeholder="Jump to a spread, add, switch mode…" value={q}
               onChange={(e) => { setQ(e.target.value); setI(0); }}
               onKeyDown={(e) => {
                 if (e.key === "ArrowDown") { e.preventDefault(); setI(Math.min(cur + 1, shown.length - 1)); }
                 else if (e.key === "ArrowUp") { e.preventDefault(); setI(Math.max(cur - 1, 0)); }
                 else if (e.key === "Enter") { const c = shown[cur]; if (c) run(c); }
                 else if (e.key === "Escape") close();
               }} />
        <ul role="listbox">
          {shown.map((c, k) => (
            <li key={`${c.group}-${c.label}`} role="option" aria-selected={k === cur} onMouseEnter={() => setI(k)} onClick={() => run(c)}>
              <span className={c.type === "row" ? "num" : ""}>{c.label}</span><span className="grp">{c.group}</span>
            </li>
          ))}
          {shown.length === 0 && <li className="faint">nothing matches</li>}
        </ul>
      </div>
    </div>
  );
}
