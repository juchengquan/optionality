/** PROTOTYPE — throwaway. Variant C, "Price map".
 *
 *  The structural idea: the whole book drawn against ONE SPX price axis, so "where is the market
 *  against every short strike I hold or watch" is one look, not a scan down a table. LIVE is the
 *  map (price across on the desk, a vertical ladder on the phone); REVIEW turns the axis into TIME
 *  (one lane per holding on a shared calendar). Everything else hangs off a tapped bar: a drawer
 *  docked on the desk, a bottom sheet on the phone. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Alert, Book, Candidate, Holding, Need } from "../data";
import type { VariantProps } from "../types";
import { AddSpread } from "./add";
import { Detail, StateChip } from "./detail";
import { PriceMap } from "./map";
import { ReviewMap } from "./review";
import {
  edited, fmtAsOf, fmtDate, fmtDelta, fmtPct, fmtPts, fmtPx, fmtSignedPct, fmtUsd, lanesOf,
  marketToday, plainSentence, worstTone, type Spread,
} from "./lib";
import "./vc.css";

export const name = "Price map";

type Edits = Record<string, { threshold: number; direction: "above" | "below" }>;

function applyEdits<T extends { alerts: Alert[] }>(s: T, edits: Edits): T {
  if (!s.alerts.some((a) => edits[a.id])) return s;
  return { ...s, alerts: s.alerts.map((a) => (edits[a.id] ? edited(a, edits[a.id]!.threshold, edits[a.id]!.direction) : a)) };
}

/** the "needs you" list, re-derived after local edits (same rules as data.ts) */
function needsOf(candidates: Candidate[], holdings: Holding[]): Need[] {
  const out: Need[] = [];
  for (const h of holdings) {
    for (const a of h.alerts) if (a.state === "fired") out.push({ kind: "risk", text: `${h.name} ${a.field} ${a.current} ≥ ${a.threshold}`, refId: h.id });
    if (h.value !== null && h.value <= h.target) out.push({ kind: "target", text: `${h.name} at target`, refId: h.id });
    if (h.dte <= h.manageByDte) out.push({ kind: "manage", text: `${h.name} at its manage-by`, refId: h.id });
  }
  for (const c of candidates) {
    for (const a of c.alerts) {
      if (a.state === "fired") out.push({ kind: "entry", text: `${c.name} ${a.field} ${a.current} ≥ ${a.threshold}`, refId: c.id });
      if (a.state === "quarantined") out.push({ kind: "fault", text: `${c.name} switched off — a figure never arrived`, refId: c.id });
    }
  }
  const order = ["fault", "risk", "manage", "entry", "target"];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

function useWidth(ref: React.RefObject<HTMLElement | null>) {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([e]) => setW(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export function VariantC({ book: raw, mode, setMode, prefs, setPrefs }: VariantProps) {
  const root = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const rootW = useWidth(root);
  const mainW = useWidth(main);
  // measured, not a breakpoint guess: a phone is whatever is too narrow for the docked drawer
  const phone = rootW > 0 && rootW < 760;

  const [edits, setEdits] = useState<Edits>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);

  const book: Book = useMemo(() => {
    const candidates = raw.candidates.map((c) => applyEdits(c, edits));
    const holdings = raw.holdings.map((h) => applyEdits(h, edits));
    return { ...raw, candidates, holdings, needs: needsOf(candidates, holdings) };
  }, [raw, edits]);
  const lanes = useMemo(() => lanesOf(book, book.holdings, book.candidates), [book]);
  const today = marketToday(book);
  const all: Spread[] = [...book.holdings, ...book.candidates];
  const sel = all.find((s) => s.id === selected) ?? null;
  const drawerOpen = Boolean(sel) || adding;

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  // the phone's Back closes the sheet (as the real app's useDismissOnBack does)
  useEffect(() => {
    if (!phone || !drawerOpen) return;
    history.pushState({ vcSheet: true }, "", location.href);
    const onPop = () => { setSelected(null); setAdding(false); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [phone, drawerOpen]);
  const close = () => {
    if (phone && history.state?.vcSheet) history.back();
    else { setSelected(null); setAdding(false); }
  };
  const select = (id: string) => { setAdding(false); setSelected(id); };

  const drawerW = phone ? rootW : 440;
  const panel = adding ? (
    <AddSpread book={book} width={drawerW} phone={phone} privacy={prefs.privacy} onDone={close} onToast={setToast} />
  ) : sel ? (
    <Detail key={sel.id} book={book} spread={sel} mode={mode} width={drawerW} phone={phone} privacy={prefs.privacy}
            entryStyle={prefs.entryStyle} today={today} onSelect={select} onToast={setToast}
            onEditAlert={(id, threshold, direction) => setEdits((e) => ({ ...e, [id]: { threshold, direction } }))} />
  ) : null;

  return (
    <div ref={root} className="vc" data-up={prefs.upColor} data-entry={prefs.entryStyle} data-phone={phone ? "" : undefined}>
      <Header book={book} mode={mode} setMode={setMode} phone={phone} onAdd={() => { setSelected(null); setAdding(true); }}
              onSettings={() => setSettings((s) => !s)} />
      {settings && (
        <div className={`card mx-4 mb-3 grid gap-2 p-3 ${phone ? "" : "max-w-xl"}`}>
          <Pref label="Up is" value={prefs.upColor === "green" ? "green (US)" : "red (moomoo option)"}
                onClick={() => setPrefs({ ...prefs, upColor: prefs.upColor === "green" ? "red" : "green" })} />
          <Pref label="Entry signals" value={prefs.entryStyle === "distinct" ? "their own style ◎" : "same as alarms !"}
                onClick={() => setPrefs({ ...prefs, entryStyle: prefs.entryStyle === "distinct" ? "same" : "distinct" })} />
          <Pref label="Privacy" value={prefs.privacy ? "dollar amounts hidden" : "showing dollars"}
                onClick={() => setPrefs({ ...prefs, privacy: !prefs.privacy })} />
        </div>
      )}
      <NeedsLine needs={book.needs} entryStyle={prefs.entryStyle} onSelect={select} phone={phone} />

      <div className="flex items-start" style={{ paddingBottom: 96 }}>
        <div ref={main} className="min-w-0 flex-1 px-4">
          {mainW > 0 && (mode === "live" ? (
            <>
              <PriceMap book={book} lanes={lanes} width={mainW} phone={phone} selected={selected} onSelect={select} entryStyle={prefs.entryStyle} />
              <Legend phone={phone} />
              <Figures book={book} lanes={lanes} phone={phone} privacy={prefs.privacy} entryStyle={prefs.entryStyle} selected={selected} onSelect={select} />
            </>
          ) : (
            <ReviewMap book={book} holdings={book.holdings} width={mainW} phone={phone} privacy={prefs.privacy}
                       entryStyle={prefs.entryStyle} today={today} selected={selected} onSelect={select} />
          ))}
        </div>
        {!phone && drawerOpen && (
          <aside className="drawer sticky top-0 max-h-dvh shrink-0 overflow-y-auto" style={{ width: drawerW }}>
            <div className="flex justify-end p-2 pb-0">
              <button className="btn" aria-label="close panel" onClick={close}>Close ✕</button>
            </div>
            {panel}
          </aside>
        )}
      </div>

      {phone && drawerOpen && (
        <>
          <div className="sheet-backdrop" onClick={close} />
          <div className="sheet" role="dialog" aria-modal="true">
            <div className="flex items-center justify-between pr-2">
              <div className="grab" />
              <button className="btn" aria-label="close sheet" onClick={close} style={{ position: "absolute", right: 10, top: 8 }}>✕</button>
            </div>
            {panel}
          </div>
        </>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function Pref({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex min-h-11 items-center justify-between gap-3 rounded-lg px-2 text-left hover:bg-[var(--panel-2)]">
      <span className="text-[13px] muted">{label}</span><span className="text-[14px] font-semibold">{value}</span>
    </button>
  );
}

// ---- header: the market, the freshness, the mode --------------------------------------------------

function Header({ book, mode, setMode, phone, onAdd, onSettings }: {
  book: Book; mode: "live" | "review"; setMode: (m: "live" | "review") => void; phone: boolean; onAdd: () => void; onSettings: () => void;
}) {
  const up = book.spotChange >= 0;
  const refs = book.references.filter((r) => !(r.label === "SPX" && r.source === "yahoo"));
  const seg = (
    <div className="seg" role="group" aria-label="mode">
      <button aria-pressed={mode === "live"} onClick={() => setMode("live")}>Live</button>
      <button aria-pressed={mode === "review"} onClick={() => setMode("review")}>Review</button>
    </div>
  );
  const fresh = (
    <span className="num text-[12px] muted">
      as of {fmtAsOf(book)} · <span style={{ color: book.provider.ok ? "var(--ink-2)" : "var(--alarm)" }}>{book.provider.name} {book.provider.ok ? "ok" : "DOWN"}</span>
      {mode === "live" ? ` · every ${book.sweepSeconds}s` : " · review: not polling"}
    </span>
  );
  return (
    <header className={`px-4 ${phone ? "pt-3 pb-2" : "pt-4 pb-3"}`}>
      <div className="flex items-center gap-3">
        <span className="text-[15px] font-extrabold tracking-tight">optionality</span>
        {!phone && seg}
        <span className="flex-1" />
        <button className="btn" aria-label="settings" onClick={onSettings}>⚙</button>
        <button className="btn nowrap" data-primary="" onClick={onAdd}>{phone ? "+ Add" : "+ Add spread"}</button>
      </div>
      {phone && <div className="mt-2 [&_.seg]:flex [&_.seg]:w-full [&_.seg_button]:flex-1">{seg}</div>}
      <div className={`mt-2 flex ${phone ? "flex-col gap-0.5" : "flex-wrap items-baseline gap-x-5 gap-y-1"}`}>
        <span className="num flex items-baseline gap-2">
          <span className="text-[13px] font-semibold muted">SPX</span>
          <span className="text-[26px] font-extrabold tracking-tight">{fmtPx(book.spot)}</span>
          <span className={`text-[15px] font-bold ${up ? "up" : "down"}`}>{up ? "▲" : "▼"} {fmtSignedPct(book.spotChange)}</span>
        </span>
        <span className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-[13px]">
          {refs.map((r) => r.error
            ? <span key={`${r.label}-${r.source}`} className="faint" title={r.error}>{r.label} ({r.source}): <i>{r.error}</i></span>
            : <span key={`${r.label}-${r.source}`} className="num">{r.label} <b>{fmtPts(r.figure)}</b> <span className={(r.change ?? 0) >= 0 ? "up" : "down"}>{fmtSignedPct(r.change ?? 0)}</span></span>)}
        </span>
        {fresh}
      </div>
    </header>
  );
}

// ---- needs you: present only when something does --------------------------------------------------

const NEED_TONE: Record<Need["kind"], string> = { fault: "fault", risk: "alarm", manage: "manage", entry: "opportunity", target: "target" };
const NEED_GLYPH: Record<Need["kind"], string> = { fault: "⊘", risk: "!", manage: "◷", entry: "◎", target: "✓" };

function NeedsLine({ needs, entryStyle, onSelect, phone }: {
  needs: Need[]; entryStyle: "distinct" | "same"; onSelect: (id: string) => void; phone: boolean;
}) {
  if (needs.length === 0) return null; // silence is not a verdict, so it says nothing
  return (
    // on the phone ONE scrolling line, so the map is not pushed below the fold by four chips
    <div className={`mx-4 mb-3 flex items-center gap-2 rounded-xl px-3 py-2 ${phone ? "overflow-x-auto" : "flex-wrap"}`}
         style={{ background: "var(--panel)", border: "1px solid var(--rule)", scrollbarWidth: "none" }}>
      <span className="text-[11px] font-bold uppercase tracking-wide faint">Needs you</span>
      {needs.map((n, i) => {
        const tone = n.kind === "entry" && entryStyle === "same" ? "alarm" : NEED_TONE[n.kind];
        return (
          <button key={i} className="chip" data-tone={tone} onClick={() => onSelect(n.refId)}
                  style={{ minHeight: phone ? 44 : undefined, flexShrink: 0, textAlign: "left" }}>
            <span aria-hidden>{n.kind === "entry" && entryStyle === "same" ? "!" : NEED_GLYPH[n.kind]}</span>
            <span>{n.kind === "entry" ? "entry · " : ""}{n.text}</span>
          </button>
        );
      })}
    </div>
  );
}

function Legend({ phone }: { phone: boolean }) {
  return (
    <p className={`mt-2 mb-4 text-[11.5px] leading-relaxed faint ${phone ? "" : "max-w-4xl"}`}>
      <b>Filled</b> = held · <b>outlined</b> = watching · Δ sits on the short strike · ◎ entry signal · ! alarm · ◔ near ·
      ⊘ switched off · ▲ breakeven at expiry · shaded band = ±1σ to that expiry from one IV in the lane, so approximate.
      Thresholds on a spread's value or a Δ have no price of their own; their progress is the thin line under each bar.
    </p>
  );
}

// ---- the figures the map can't carry ----------------------------------------------------------------

function Figures({ book, lanes, phone, privacy, entryStyle, selected, onSelect }: {
  book: Book; lanes: ReturnType<typeof lanesOf>; phone: boolean; privacy: boolean; entryStyle: "distinct" | "same";
  selected: string | null; onSelect: (id: string) => void;
}) {
  return (
    <section className="grid gap-4">
      {lanes.map((l) => (
        <div key={l.expiry}>
          <h4 className="m-0 mb-1 text-[12px] font-bold uppercase tracking-wide faint">{fmtDate(l.expiry)} · {l.dte}d</h4>
          <div className="card overflow-hidden">
            {!phone && (
              <div className="grid gap-x-3 px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-wide faint"
                   style={{ gridTemplateColumns: COLS, borderBottom: "1px solid var(--rule)" }}>
                <span>spread</span><span /><span>strikes</span><span>short Δ</span><span>P&L · alerts</span><span className="justify-self-end">value</span>
              </div>
            )}
            {[...l.holdings, ...l.candidates].map((s, i) => (
              <Row key={s.id} s={s} first={i === 0} phone={phone} privacy={privacy} entryStyle={entryStyle}
                   selected={selected === s.id} onSelect={onSelect} spot={book.spot} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

const COLS = "190px 64px 130px 80px 1fr auto";

function Row({ s, first, phone, privacy, entryStyle, selected, onSelect }: {
  s: Spread; first: boolean; phone: boolean; privacy: boolean; entryStyle: "distinct" | "same"; selected: boolean;
  onSelect: (id: string) => void; spot: number;
}) {
  const tone = worstTone(s.alerts, entryStyle);
  const loud = s.alerts.find((a) => a.state !== "armed") ?? s.alerts[0];
  const held = s.kind === "holding";
  const strikes = s.long === null ? `${s.short}` : `${s.short}/${s.long}`;
  return (
    <button onClick={() => onSelect(s.id)}
            className={`grid w-full items-center gap-x-3 px-3 text-left ${first ? "" : "border-t hairline"}`}
            style={{
              gridTemplateColumns: phone ? "1fr auto" : COLS,
              minHeight: phone ? 56 : 40, paddingBlock: phone ? 8 : 4,
              background: selected ? "var(--panel-2)" : undefined,
              boxShadow: tone === "alarm" ? "inset 3px 0 0 var(--alarm)" : tone === "opportunity" ? "inset 3px 0 0 var(--opp)" : tone === "fault" ? "inset 3px 0 0 var(--fault)" : undefined,
            }}>
      <span className="min-w-0">
        <span className="block truncate text-[14px] font-semibold">{s.name}</span>
        {phone && <span className="num block text-[12px] muted">{held ? "held" : "watching"} · {s.side} {strikes} · Δ {fmtDelta(s.shortDelta)}{held ? ` · ${fmtPct((s as Holding).captured)} of max` : ""}</span>}
      </span>
      {!phone && <span className="text-[12px] muted">{held ? "held" : "watching"}</span>}
      {!phone && <span className="num nowrap text-[13px]">{s.side} {strikes}</span>}
      {!phone && <span className="num text-[13px]">Δ {fmtDelta(s.shortDelta)}</span>}
      {!phone && (
        <span className="num min-w-0 truncate text-[13px] muted">
          {held
            ? <><span className={(s as Holding).pnlPoints >= 0 ? "gain" : "loss"}>{fmtUsd((s as Holding).pnlDollars, privacy)}</span> · {fmtPct((s as Holding).captured)} of max · {(s as Holding).pace}</>
            : loud && plainSentence(loud)}
        </span>
      )}
      <span className="flex items-center gap-3 justify-self-end">
        {loud && tone !== "neutral" && <StateChip a={loud} entryStyle={entryStyle} />}
        {!(phone && tone !== "neutral") && <span className="num text-[13px] muted">{fmtPts(s.value)}</span>}
      </span>
    </button>
  );
}
