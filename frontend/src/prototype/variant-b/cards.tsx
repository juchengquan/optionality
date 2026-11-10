/** PROTOTYPE — throwaway. Variant B's cards: the needs banners, a holding, an expiry group, a
 *  candidate, the references bar, and the journal entry for a closed trade. */
import {
  BellRing, CalendarClock, ChevronRight, CircleCheck, PlugZap, Target, TrendingDown, TrendingUp, TriangleAlert,
} from "lucide-react";

import type { Alert, Book, Candidate, Closed, Holding, Need, Prefs } from "../data";
import { Burndown, Ring, Spark, StrikeStrip } from "./charts";
import { asOf, closedCaptured, day, delta, pct, price, pts, signed, spreadLabel, strike, usd } from "./util";

const sideTag = (side: "call" | "put") => <span className={`vb-side vb-side-${side}`}>{side === "call" ? "CALL" : "PUT"}</span>;

// ---------------------------------------------------------------------------------------------

const NEED_ICON = { fault: PlugZap, risk: BellRing, manage: CalendarClock, entry: Target, target: CircleCheck } as const;
const NEED_TITLE = { fault: "Switched off", risk: "Risk alarm", manage: "Manage-by reached", entry: "Entry signal", target: "Target reached" } as const;

/** Appears only when something needs you. Its absence is not an all-clear, so it never says one. */
export function Needs({ needs, prefs, onOpen, compact, dense }: {
  needs: Need[]; prefs: Prefs; onOpen: (id: string) => void; compact?: boolean; dense?: boolean;
}) {
  if (needs.length === 0) return null;
  return (
    <div className={`vb-needs ${compact ? "vb-needs-row" : ""} ${dense ? "vb-needs-dense" : ""}`} role="alert">
      {needs.map((n, i) => {
        const Icon = NEED_ICON[n.kind];
        const tone = n.kind === "entry" && prefs.entryStyle === "same" ? "risk" : n.kind;
        return (
          <button key={i} className={`vb-need vb-need-${tone}`} onClick={() => onOpen(n.refId)}>
            <Icon size={20} strokeWidth={2.2} aria-hidden />
            <span className="vb-need-body">
              <span className="vb-need-title">{NEED_TITLE[n.kind]}</span>
              <span className="vb-need-text">{n.text}</span>
            </span>
            <ChevronRight size={18} className="vb-need-go" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function AlertChip({ a, prefs, onClick }: { a: Alert; prefs: Prefs; onClick?: () => void }) {
  const fired = a.state === "fired";
  const tone = a.state === "quarantined" ? "fault" : fired
    ? (a.kind === "entry" && prefs.entryStyle === "distinct" ? "opp" : "alarm")
    : a.state === "near" ? "warn" : "calm";
  const Icon = a.state === "quarantined" ? PlugZap : fired ? (a.kind === "entry" ? Target : BellRing) : null;
  const op = a.direction === "above" ? "≥" : "≤";
  const now = a.current === null ? "—" : a.field.includes("Δ") ? a.current.toFixed(2) : a.current.toFixed(2);
  return (
    <button className={`vb-chip vb-chip-${tone}`} onClick={onClick} title={a.sentence}>
      {Icon && <Icon size={14} strokeWidth={2.4} aria-hidden />}
      <span>{a.field}</span>
      <b>{now}</b>
      <span className="vb-chip-th">{op} {a.field.includes("Δ") ? a.threshold.toFixed(2) : a.threshold.toFixed(2)}</span>
      {a.state === "quarantined" ? <em>off</em> : fired ? <em>{a.kind === "entry" ? "signal" : "fired"}</em> : a.state === "near" ? <em>near</em> : null}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------

function captureText(h: Holding) {
  return h.captured >= 0 ? `${Math.round(h.captured * 100)}% of max captured` : `losing ${Math.round(-h.captured * 100)}% of the credit`;
}

function paceText(h: Holding) {
  const d = Math.abs((h.value ?? 0) - h.plannedToday).toFixed(2);
  if (h.pace === "ahead") return <>Ahead of plan by <b>{d}</b> · {pts(h.value)} to close vs {pts(h.plannedToday)} planned</>;
  if (h.pace === "behind") return <>Behind plan by <b>{d}</b> · {pts(h.value)} to close vs {pts(h.plannedToday)} planned</>;
  return <>On pace · {pts(h.value)} to close vs {pts(h.plannedToday)} planned</>;
}

export function HoldingCard({ h, book, prefs, onOpen, withStrip }: {
  h: Holding; book: Book; prefs: Prefs; onOpen: () => void; withStrip: boolean;
}) {
  const gain = h.pnlPoints >= 0;
  const hot = h.alerts.some((a) => a.state === "fired" && a.kind === "risk");
  return (
    <article className={`vb-card vb-hold ${hot ? "vb-hot" : ""}`}>
      <button className="vb-card-hit" onClick={onOpen} aria-label={`open ${h.name}`} />
      <header className="vb-hold-head">
        {sideTag(h.side)}
        <span className="vb-hold-name">{strike(h.short)}/{strike(h.long!)}</span>
        <span className="vb-muted">×{h.contracts}</span>
        <span className="vb-dte">{h.dte} DTE</span>
      </header>
      <div className="vb-hero">
        <span className={`vb-hero-n ${gain ? "vb-gain" : "vb-loss"}`}>{usd(h.pnlDollars, prefs)}</span>
        <span className={`vb-hero-sub ${gain ? "vb-gain" : "vb-loss"}`}>{signed(h.pnlPoints)} pts</span>
      </div>
      <div className="vb-capture">
        <div className="vb-capture-bar">
          <span className={gain ? "vb-capture-gain" : "vb-capture-loss"} style={{ width: `${Math.min(100, Math.abs(h.captured) * 100)}%` }} />
        </div>
        <span className="vb-capture-t">{captureText(h)}</span>
      </div>
      <p className={`vb-pace vb-pace-${h.pace.replace(" ", "")}`}>{paceText(h)}</p>
      {withStrip && (
        <StrikeStrip spreads={[{ side: h.side, short: h.short, long: h.long, shortDelta: h.shortDelta, hot }]}
                     spot={book.spot} ivPct={h.shortIv} dte={h.dte} upToday={book.spotChange >= 0} />
      )}
      <div className="vb-chips">
        {h.alerts.map((a) => <AlertChip key={a.id} a={a} prefs={prefs} onClick={onOpen} />)}
      </div>
    </article>
  );
}

/** A condor's two spreads stack inside one expiry group, under ONE strip that holds both. */
export function ExpiryGroup({ expiry, holdings, book, prefs, onOpen }: {
  expiry: string; holdings: Holding[]; book: Book; prefs: Prefs; onOpen: (id: string) => void;
}) {
  const paired = holdings.length > 1;
  const total = holdings.reduce((t, h) => t + h.pnlDollars, 0);
  const dte = holdings[0]!.dte;
  const iv = Math.max(...holdings.map((h) => h.shortIv ?? 0)) || null;
  return (
    <section className="vb-group">
      <header className="vb-group-head">
        <span className="vb-group-date">{day(expiry)}</span>
        <span className="vb-muted">{dte} DTE{paired ? " · iron condor, two spreads" : ""}</span>
        {paired && <span className={`vb-group-total ${total >= 0 ? "vb-gain" : "vb-loss"}`}>{usd(total, prefs)}</span>}
      </header>
      {paired && (
        <div className="vb-card vb-group-strip">
          <StrikeStrip spreads={holdings.map((h) => ({ side: h.side, short: h.short, long: h.long, shortDelta: h.shortDelta,
                                                      hot: h.alerts.some((a) => a.state === "fired" && a.kind === "risk") }))}
                       spot={book.spot} ivPct={iv} dte={dte} upToday={book.spotChange >= 0} />
          <StripDistance holdings={holdings} spot={book.spot} />
        </div>
      )}
      <div className="vb-group-cards">
        {holdings.map((h) => <HoldingCard key={h.id} h={h} book={book} prefs={prefs} onOpen={() => onOpen(h.id)} withStrip={!paired} />)}
      </div>
    </section>
  );
}

export function StripDistance({ holdings, spot }: { holdings: Pick<Holding, "side" | "short" | "shortIv" | "dte">[]; spot: number }) {
  return (
    <div className="vb-dist">
      {holdings.map((h, i) => {
        const away = h.side === "call" ? h.short - spot : spot - h.short;
        const sd = h.shortIv ? spot * (h.shortIv / 100) * Math.sqrt(h.dte / 365) : null;
        return (
          <span key={i}>
            {h.side === "call" ? "short call" : "short put"} <b>{away >= 0 ? strike(away) : `−${strike(-away)}`} pts</b>
            {" "}· {(Math.abs(away) / spot * 100).toFixed(1)}%{sd ? ` · ${(away / sd).toFixed(1)}σ` : ""}{away < 0 ? " past it" : " away"}
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

/** the alert furthest along decides how a candidate reads at a glance */
export const lead = (c: Candidate) =>
  [...c.alerts].sort((a, b) => rank(b) - rank(a) || b.fill - a.fill)[0]!;
const rank = (a: Alert) => ({ fired: 4, quarantined: 3, near: 2, armed: 1, muted: 0 })[a.state];

export function CandidateCard({ c, prefs, onOpen }: { c: Candidate; prefs: Prefs; onOpen: () => void }) {
  const a = lead(c);
  const fired = a.state === "fired";
  const distinct = prefs.entryStyle === "distinct";
  const badge = a.state === "quarantined" ? "Switched off" : fired ? (distinct ? "Entry signal" : "Fired") : a.state === "near" ? "Near" : "Watching";
  return (
    <button className={`vb-card vb-cand ${fired ? (distinct ? "vb-cand-opp" : "vb-cand-alarm") : ""} ${a.state === "quarantined" ? "vb-cand-off" : ""}`}
            onClick={onOpen}>
      <Ring fill={a.fill} state={a.state} entryDistinct={distinct} />
      <span className="vb-cand-body">
        <span className="vb-cand-title">
          {sideTag(c.side)} <b>{c.long === null ? `${strike(c.short)} short leg` : `${strike(c.short)}/${strike(c.long)}`}</b>
        </span>
        <span className="vb-cand-sent">{a.sentence}</span>
        {c.alerts.length > 1 && <span className="vb-cand-more">+ {c.alerts.filter((x) => x !== a).map((x) => `${x.field} ${x.current === null ? "—" : x.current.toFixed(2)}/${x.threshold}`).join(" · ")}</span>}
      </span>
      <span className="vb-cand-side">
        <span className={`vb-badge vb-badge-${a.state === "quarantined" ? "fault" : fired ? (distinct ? "opp" : "alarm") : a.state}`}>
          {fired && (distinct ? <Target size={12} /> : <BellRing size={12} />)}{a.state === "quarantined" && <PlugZap size={12} />}{badge}
        </span>
        <span className="vb-cand-val">{c.long === null ? `Δ ${delta(c.shortDelta)}` : pts(c.value)}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------------------------

export function Freshness({ book, prefs }: { book: Book; prefs: Prefs }) {
  return (
    <span className="vb-fresh">
      <span className={`vb-dotlive ${book.provider.ok ? "" : "vb-dotdead"}`} />
      {asOf(book.asOf, book.displayTz)} · {book.provider.name} {book.provider.ok ? "ok" : "down"}
      {prefs.privacy && " · $ hidden"}
    </span>
  );
}

export function References({ book, prefs, withFreshness = true }: { book: Book; prefs: Prefs; withFreshness?: boolean }) {
  return (
    <div className="vb-refs">
      {/* figures first, faults after: on a phone the first line is what the eye takes */}
      {[...book.references].sort((a, b) => Number(Boolean(a.error)) - Number(Boolean(b.error))).map((r, i) => {
        const up = (r.change ?? 0) >= 0;
        return (
          <span key={i} className={`vb-ref ${r.error ? "vb-ref-err" : ""}`}>
            <span className="vb-ref-l">{r.label}<small>{r.source}</small></span>
            {r.error ? (
              <span className="vb-ref-e"><TriangleAlert size={13} aria-hidden /> {r.error}</span>
            ) : (
              <>
                <b>{price(r.figure!)}</b>
                <span className={up ? "vb-up" : "vb-down"}>
                  {up ? <TrendingUp size={13} aria-hidden /> : <TrendingDown size={13} aria-hidden />} {pct(r.change ?? 0, 2)}
                </span>
              </>
            )}
          </span>
        );
      })}
      {withFreshness && <Freshness book={book} prefs={prefs} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function ClosedEntry({ c, prefs }: { c: Closed; prefs: Prefs }) {
  const gain = c.realizedPoints >= 0;
  return (
    <article className="vb-card vb-journal">
      <header>
        {sideTag(c.side)}
        <b>{strike(c.short)}/{strike(c.long)}</b>
        <span className="vb-muted">×{c.contracts} · exp {day(c.expiry)}</span>
      </header>
      <div className="vb-journal-row">
        <span className={`vb-journal-n ${gain ? "vb-gain" : "vb-loss"}`}>{usd(c.realizedDollars, prefs)}</span>
        <span className="vb-muted">{signed(c.realizedPoints)} pts · {Math.round(closedCaptured(c) * 100)}% of max kept</span>
      </div>
      <p className="vb-journal-t">
        Sold {day(c.opened)} for {pts(c.entry)}, bought back {day(c.closedOn)} for {pts(c.exit)} — {c.samples.length} days held.
      </p>
      <Burndown h={{ entry: c.entry, target: c.entry * 0.5, stop: c.entry * 2, opened: c.opened, expiry: c.expiry,
                     manageByDte: 21, manageBy: c.closedOn, samples: c.samples, closedOn: c.closedOn }} height={120} />
    </article>
  );
}

export function IvMultiples({ h }: { h: Pick<Holding, "samples"> }) {
  const s = h.samples;
  return (
    <div className="vb-multiples">
      <div><h4>short IV</h4><Spark values={s.map((x) => x.shortIv)} labels={[day(s[0]!.date), day(s.at(-1)!.date)]} unit="%" /></div>
      <div><h4>short Δ</h4><Spark values={s.map((x) => x.shortDelta)} labels={[day(s[0]!.date), day(s.at(-1)!.date)]} digits={2} /></div>
      <div><h4>SPX close</h4><Spark values={s.map((x) => x.spot)} labels={[day(s[0]!.date), day(s.at(-1)!.date)]} digits={0} /></div>
    </div>
  );
}

export { spreadLabel };
