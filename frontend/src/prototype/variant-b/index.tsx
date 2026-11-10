/** PROTOTYPE — throwaway. Variant B, "Glance cards": phone-first, one big card per spread, hero
 *  figures, and a bottom tab bar; on the desk the same cards become a board. Built to be read at
 *  2 a.m. on a phone in one glance — never a table. */
import { Activity, BookOpen, ChevronLeft, ChevronRight, Plus, Settings2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Alert, Book, Candidate, Holding, Need } from "../data";
import type { VariantProps } from "../types";
import { CandidateCard, ClosedEntry, ExpiryGroup, Freshness, Needs, References } from "./cards";
import { AddFlow, CandidateDetail, HoldingDetail, ReviewHolding, SettingsPanel, Sheet } from "./panels";
import { day, reevaluate, strike, usd } from "./util";
import "./vb.css";

export const name = "Glance cards";

function usePhone() {
  const q = "(max-width: 767px)";
  const [phone, set] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => set(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}

type Open = { kind: "holding" | "candidate"; id: string } | { kind: "add" } | { kind: "settings" } | null;
type Edits = Record<string, { threshold: number; direction: "above" | "below" }>;

/** the needs the book would report with the viewer's local alert edits applied */
const fix = (x: number | null) => (x === null ? "—" : x.toFixed(2));

function needsOf(candidates: Candidate[], holdings: Holding[]): Need[] {
  const out: Need[] = [];
  const name = (s: Candidate | Holding) => `${day(s.expiry)} ${s.long === null ? strike(s.short) : `${strike(s.short)}/${strike(s.long)}`} ${s.side}`;
  for (const h of holdings) {
    for (const a of h.alerts) if (a.state === "fired") out.push({ kind: "risk", text: `${name(h)} · ${a.field} ${fix(a.current)} ≥ ${fix(a.threshold)}`, refId: h.id });
    if (h.value !== null && h.value <= h.target) out.push({ kind: "target", text: `${name(h)} · ${h.value.toFixed(2)} to close, target ${h.target.toFixed(2)}`, refId: h.id });
    if (h.dte <= h.manageByDte) out.push({ kind: "manage", text: `${name(h)} · ${h.dte} DTE`, refId: h.id });
  }
  for (const c of candidates) for (const a of c.alerts) {
    if (a.state === "fired") out.push({ kind: "entry", text: `${name(c)} · ${a.field} ${fix(a.current)} ≥ ${fix(a.threshold)}`, refId: c.id });
    if (a.state === "quarantined") out.push({ kind: "fault", text: `${name(c)} · ${a.reason}`, refId: c.id });
  }
  const order = ["fault", "risk", "manage", "entry", "target"];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

function byExpiry<T extends { expiry: string }>(xs: T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(x.expiry, [...(m.get(x.expiry) ?? []), x]);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function VariantB({ book: original, mode, setMode, prefs, setPrefs }: VariantProps) {
  const phone = usePhone();
  const [open, setOpen] = useState<Open>(null);
  const [edits, setEdits] = useState<Edits>({});
  const [toast, setToast] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  // local alert edits, applied over the book so every card, chip and banner agrees
  const book: Book = useMemo(() => {
    const apply = (a: Alert) => (edits[a.id] ? reevaluate(a, edits[a.id]!.threshold, edits[a.id]!.direction) : a);
    const candidates = original.candidates.map((c) => ({ ...c, alerts: c.alerts.map(apply) }));
    const holdings = original.holdings.map((h) => ({ ...h, alerts: h.alerts.map(apply) }));
    return { ...original, candidates, holdings, needs: needsOf(candidates, holdings) };
  }, [original, edits]);

  const edit = useCallback((id: string, threshold: number, direction: "above" | "below") => {
    setEdits((e) => ({ ...e, [id]: { threshold, direction } }));
    setToast("alert updated — prototype, kept in this tab only");
  }, []);
  const close = useCallback(() => setOpen(null), []);
  const openRef = useCallback((id: string) => {
    if (book.holdings.some((h) => h.id === id)) {
      if (mode === "review") setSelected(book.holdings.findIndex((h) => h.id === id));
      setOpen({ kind: "holding", id });
    } else setOpen({ kind: "candidate", id });
  }, [book.holdings, mode]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const holdingGroups = byExpiry(book.holdings);
  const candidateGroups = byExpiry(book.candidates);

  const sheet = (() => {
    if (!open) return null;
    if (open.kind === "add") {
      return <Sheet phone={phone} title="Add a spread" onClose={close}>
        <AddFlow book={book} prefs={prefs} onDone={(m) => { setToast(m); close(); }} />
      </Sheet>;
    }
    if (open.kind === "settings") {
      return <Sheet phone={phone} title="Settings" onClose={close}><SettingsPanel prefs={prefs} setPrefs={setPrefs} /></Sheet>;
    }
    if (open.kind === "holding") {
      const h = book.holdings.find((x) => x.id === open.id)!;
      const pair = h.pairedWith ? book.holdings.find((x) => x.id === h.pairedWith) ?? null : null;
      return <Sheet phone={phone} title={<>{day(h.expiry)} · {strike(h.short)}/{strike(h.long!)} {h.side} <small className="vb-muted">×{h.contracts}</small></>} onClose={close}>
        <HoldingDetail h={h} pair={pair} book={book} prefs={prefs} onEdit={edit} />
      </Sheet>;
    }
    const c = book.candidates.find((x) => x.id === open.id)!;
    return <Sheet phone={phone} title={<>{day(c.expiry)} · {c.long === null ? strike(c.short) : `${strike(c.short)}/${strike(c.long)}`} {c.side} <small className="vb-muted">watching</small></>} onClose={close}>
      <CandidateDetail c={c} book={book} prefs={prefs} onEdit={edit} />
    </Sheet>;
  })();

  const live = (
    <>
      <Needs needs={book.needs} prefs={prefs} onOpen={openRef} compact={!phone} />
      <div className={phone ? "vb-stack" : "vb-board"}>
        <section className="vb-col-hold">
          <h2 className="vb-section">Holdings <span className="vb-muted">{book.holdings.length} spreads · {usd(book.holdings.reduce((t, h) => t + h.pnlDollars, 0), prefs)}</span></h2>
          {holdingGroups.map(([exp, hs]) => <ExpiryGroup key={exp} expiry={exp} holdings={hs} book={book} prefs={prefs} onOpen={openRef} />)}
        </section>
        <section className="vb-col-watch">
          <h2 className="vb-section">Watchlist <span className="vb-muted">entry signals · {book.candidates.length}</span></h2>
          {candidateGroups.map(([exp, cs]) => (
            <div key={exp} className="vb-watch-group">
              <h3 className="vb-watch-date">{day(exp)} <span className="vb-muted">{cs[0]!.dte} DTE</span></h3>
              {cs.map((c) => <CandidateCard key={c.id} c={c} prefs={prefs} onOpen={() => setOpen({ kind: "candidate", id: c.id })} />)}
            </div>
          ))}
        </section>
      </div>
    </>
  );

  const h = book.holdings[Math.min(selected, book.holdings.length - 1)]!;
  const signals = book.candidates.filter((c) => c.alerts.some((a) => a.state === "fired"));
  const review = phone ? (
    <>
      <Needs needs={book.needs} prefs={prefs} onOpen={openRef} dense />
      <h2 className="vb-section">Holdings <span className="vb-muted">{selected + 1} of {book.holdings.length}</span></h2>
      <Pager count={book.holdings.length} index={selected} setIndex={setSelected}>
        {book.holdings.map((x) => <div key={x.id} className="vb-page"><div className="vb-card"><ReviewHolding h={x} book={book} prefs={prefs} /></div></div>)}
      </Pager>
      <h2 className="vb-section">Journal <span className="vb-muted">closed trades</span></h2>
      {book.closed.map((c) => <ClosedEntry key={c.id} c={c} prefs={prefs} />)}
      <WatchSummary signals={signals} book={book} onOpen={(id) => setOpen({ kind: "candidate", id })} />
    </>
  ) : (
    <>
      <Needs needs={book.needs} prefs={prefs} onOpen={openRef} compact />
      <div className="vb-split">
        <aside className="vb-split-list">
          <h2 className="vb-section">Holdings</h2>
          {book.holdings.map((x, i) => (
            <button key={x.id} className={`vb-card vb-pick ${i === selected ? "on" : ""}`} onClick={() => setSelected(i)}>
              <span><span className={`vb-side vb-side-${x.side}`}>{x.side.toUpperCase()}</span> <b>{strike(x.short)}/{strike(x.long!)}</b> <span className="vb-muted">{day(x.expiry)}</span></span>
              <span className={x.pnlPoints >= 0 ? "vb-gain" : "vb-loss"}>{usd(x.pnlDollars, prefs)}</span>
              <span className={`vb-pace-pill vb-pace-${x.pace.replace(" ", "")}`}>{x.pace}</span>
            </button>
          ))}
          <h2 className="vb-section">Journal</h2>
          {book.closed.map((c) => <ClosedEntry key={c.id} c={c} prefs={prefs} />)}
          <WatchSummary signals={signals} book={book} onOpen={(id) => setOpen({ kind: "candidate", id })} />
        </aside>
        <main className="vb-card vb-split-main"><ReviewHolding h={h} book={book} prefs={prefs} /></main>
      </div>
    </>
  );

  return (
    <div className={`vb ${phone ? "vb-phone" : "vb-desk"}`} data-up={prefs.upColor} data-entry={prefs.entryStyle}>
      <header className="vb-top">
        <div className="vb-brand">
          <span className="vb-logo">◐</span> optionality
          {phone && <Freshness book={book} prefs={prefs} />}
          {!phone && (
            <div className="vb-seg vb-seg-sm vb-mode" role="tablist">
              <button className={mode === "live" ? "on" : ""} onClick={() => setMode("live")}><Activity size={15} /> Live</button>
              <button className={mode === "review" ? "on" : ""} onClick={() => setMode("review")}><BookOpen size={15} /> Review</button>
            </div>
          )}
          {!phone && (
            <span className="vb-top-actions">
              <button className="vb-btn" onClick={() => setOpen({ kind: "add" })}><Plus size={16} /> Add spread</button>
              <button className="vb-icon-btn" aria-label="settings" onClick={() => setOpen({ kind: "settings" })}><Settings2 size={20} /></button>
            </span>
          )}
        </div>
        <References book={book} prefs={prefs} withFreshness={!phone} />
      </header>

      <div className="vb-body">{mode === "live" ? live : review}</div>

      {phone && (
        <nav className="vb-tabs" aria-label="sections">
          <button className={mode === "live" && open?.kind !== "add" && open?.kind !== "settings" ? "on" : ""} onClick={() => { setOpen(null); setMode("live"); }}><Activity size={22} />Live</button>
          <button className={mode === "review" && open?.kind !== "add" && open?.kind !== "settings" ? "on" : ""} onClick={() => { setOpen(null); setMode("review"); }}><BookOpen size={22} />Review</button>
          <button className={open?.kind === "add" ? "on" : ""} onClick={() => setOpen({ kind: "add" })}><Plus size={22} />Add</button>
          <button className={open?.kind === "settings" ? "on" : ""} onClick={() => setOpen({ kind: "settings" })}><Settings2 size={22} />Settings</button>
        </nav>
      )}
      {sheet}
      {toast && <div className="vb-toast" role="status">{toast}</div>}
    </div>
  );
}

function WatchSummary({ signals, book, onOpen }: { signals: Candidate[]; book: Book; onOpen: (id: string) => void }) {
  const off = book.candidates.filter((c) => c.alerts.some((a) => a.state === "quarantined"));
  return (
    <div className="vb-card vb-watchsum">
      <h4 className="vb-h4">Watchlist today</h4>
      {signals.length === 0 && off.length === 0 && <p className="vb-muted">No entry signal fired in the last poll.</p>}
      {signals.map((c) => <button key={c.id} className="vb-link" onClick={() => onOpen(c.id)}>Entry signal · {day(c.expiry)} {strike(c.short)}/{c.long ? strike(c.long) : ""} {c.side} — {c.alerts.find((a) => a.state === "fired")!.sentence}</button>)}
      {off.map((c) => <button key={c.id} className="vb-link vb-link-fault" onClick={() => onOpen(c.id)}>Switched off · {day(c.expiry)} {strike(c.short)} {c.side}</button>)}
    </div>
  );
}

/** one holding per screen, swipe or arrows */
function Pager({ count, index, setIndex, children }: { count: number; index: number; setIndex: (i: number) => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = index * el.clientWidth;
    if (Math.abs(el.scrollLeft - target) > 4) el.scrollTo({ left: target, behavior: "smooth" });
  }, [index]);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== index) setIndex(i);
  };
  return (
    <div className="vb-pager">
      <div ref={ref} className="vb-pager-track" onScroll={onScroll}>{children}</div>
      <div className="vb-pager-nav">
        <button className="vb-icon-btn" aria-label="previous holding" disabled={index === 0} onClick={() => setIndex(index - 1)}><ChevronLeft size={22} /></button>
        <span className="vb-dots">{Array.from({ length: count }, (_, i) => <i key={i} className={i === index ? "on" : ""} />)}</span>
        <button className="vb-icon-btn" aria-label="next holding" disabled={index === count - 1} onClick={() => setIndex(index + 1)}><ChevronRight size={22} /></button>
      </div>
    </div>
  );
}
