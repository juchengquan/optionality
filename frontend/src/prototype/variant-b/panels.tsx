/** PROTOTYPE — throwaway. Variant B's sheets: a holding, a candidate, the add flow, settings,
 *  and one holding's review page. A bottom sheet on the phone, a centred panel on the desk. */
import { BookOpen, Check, Pencil, Plus, Target, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { Alert, Book, Candidate, Holding, Prefs, Side } from "../data";
import { AlertChip, IvMultiples, lead, StripDistance } from "./cards";
import { Burndown, Payoff, StrikeStrip } from "./charts";
import { alertHistory, breakeven, day, delta, pts, signed, strike, usd } from "./util";

export function Sheet({ phone, title, onClose, children }: {
  phone: boolean; title: React.ReactNode; onClose: () => void; children: React.ReactNode;
}) {
  // Back closes the sheet on a phone, as the real dashboard's detail sheet does
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="vb-scrim" onClick={onClose}>
      <div className={phone ? "vb-sheet" : "vb-panel"} role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
        {phone && <div className="vb-grab" aria-hidden />}
        <header className="vb-sheet-head">
          <h3>{title}</h3>
          <button className="vb-icon-btn" aria-label="close" onClick={onClose}><X size={20} /></button>
        </header>
        <div className="vb-sheet-body">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

/** One alert, editable in place: threshold and direction, with the sentence re-read live. */
export function AlertEditor({ a, prefs, onSave }: { a: Alert; prefs: Prefs; onSave: (threshold: number, direction: "above" | "below") => void }) {
  const [editing, setEditing] = useState(false);
  const [th, setTh] = useState(String(a.threshold));
  const [dir, setDir] = useState(a.direction);
  const n = Number(th);
  const ok = th.trim() !== "" && Number.isFinite(n) && n > 0;
  return (
    <div className={`vb-alert-row vb-alert-${a.state}`}>
      <div className="vb-alert-top">
        <AlertChip a={a} prefs={prefs} />
        {a.state !== "quarantined" && !editing && (
          <button className="vb-text-btn" onClick={() => setEditing(true)}><Pencil size={14} /> edit</button>
        )}
      </div>
      <p className="vb-alert-sent">{a.sentence}</p>
      {a.reason && <p className="vb-alert-reason">{a.reason}</p>}
      {editing && (
        <div className="vb-alert-edit">
          <label>when {a.field}
            <select value={dir} onChange={(e) => setDir(e.target.value as "above" | "below")}>
              <option value="above">rises to ≥</option>
              <option value="below">falls to ≤</option>
            </select>
          </label>
          <label>threshold
            <input inputMode="decimal" value={th} onChange={(e) => setTh(e.target.value)} aria-invalid={!ok} />
          </label>
          {a.current !== null && <button className="vb-text-btn" onClick={() => setTh(String(a.current))}>set from now ({a.current})</button>}
          {!ok && <p className="vb-err">A threshold is a number above zero.</p>}
          <p className="vb-preview">Preview: alert when {a.field} {dir === "above" ? "≥" : "≤"} {ok ? n : "…"}
            {a.current !== null && ok ? ` — now ${a.current}, ${Math.abs(n - a.current).toFixed(a.field.includes("Δ") ? 3 : 2)} away` : ""}</p>
          <div className="vb-actions">
            <button className="vb-btn vb-btn-ghost" onClick={() => { setEditing(false); setTh(String(a.threshold)); setDir(a.direction); }}>cancel</button>
            <button className="vb-btn" disabled={!ok} onClick={() => { onSave(n, dir); setEditing(false); }}><Check size={16} /> save</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function HoldingDetail({ h, pair, book, prefs, onEdit }: {
  h: Holding; pair: Holding | null; book: Book; prefs: Prefs; onEdit: (id: string, t: number, d: "above" | "below") => void;
}) {
  const spreads = [h, ...(pair ? [pair] : [])];
  return (
    <div className="vb-detail">
      <div className="vb-detail-hero">
        <span className={`vb-hero-n ${h.pnlPoints >= 0 ? "vb-gain" : "vb-loss"}`}>{usd(h.pnlDollars, prefs)}</span>
        <span className="vb-muted">{signed(h.pnlPoints)} pts · sold {pts(h.entry)} · {pts(h.value)} to close · ×{h.contracts}</span>
      </div>
      <StrikeStrip spreads={spreads.map((s) => ({ side: s.side, short: s.short, long: s.long, shortDelta: s.shortDelta }))}
                   spot={book.spot} ivPct={h.shortIv} dte={h.dte} upToday={book.spotChange >= 0} />
      <StripDistance holdings={spreads} spot={book.spot} />
      <h4 className="vb-h4">Payoff at expiry{pair ? " — the whole condor" : ""}</h4>
      <Payoff spreads={spreads.map((s) => ({ side: s.side, short: s.short, long: s.long!, entry: s.entry, contracts: s.contracts, value: s.value }))}
              spot={book.spot} prefs={prefs} />
      <h4 className="vb-h4">Alerts on this spread</h4>
      {h.alerts.map((a) => <AlertEditor key={a.id} a={a} prefs={prefs} onSave={(t, d) => onEdit(a.id, t, d)} />)}
      <dl className="vb-facts">
        <div><dt>short Δ</dt><dd>{delta(h.shortDelta)}</dd></div>
        <div><dt>short IV</dt><dd>{pts(h.shortIv, 1)}%</dd></div>
        <div><dt>θ / day</dt><dd>{pts(h.theta, 3)}</dd></div>
        <div><dt>vega</dt><dd>{pts(h.vega, 3)}</dd></div>
        <div><dt>target</dt><dd>{pts(h.target)}</dd></div>
        <div><dt>stop</dt><dd>{pts(h.stop)}</dd></div>
        <div><dt>manage by</dt><dd>{day(h.manageBy)}</dd></div>
        <div><dt>opened</dt><dd>{day(h.opened)}</dd></div>
      </dl>
    </div>
  );
}

export function CandidateDetail({ c, book, prefs, onEdit }: {
  c: Candidate; book: Book; prefs: Prefs; onEdit: (id: string, t: number, d: "above" | "below") => void;
}) {
  const a = lead(c);
  return (
    <div className="vb-detail">
      {a.state === "fired" && (
        <p className={`vb-callout ${prefs.entryStyle === "distinct" ? "vb-callout-opp" : "vb-callout-alarm"}`}>
          <Target size={18} /> {a.field} has reached your entry level — this spread is worth selling now if the rest checks out.
        </p>
      )}
      <StrikeStrip spreads={[{ side: c.side, short: c.short, long: c.long, shortDelta: c.shortDelta }]}
                   spot={book.spot} ivPct={c.shortIv} dte={c.dte} upToday={book.spotChange >= 0} />
      <StripDistance holdings={[{ side: c.side, short: c.short, shortIv: c.shortIv, dte: c.dte }]} spot={book.spot} />
      {c.long !== null && c.value !== null && (
        <>
          <h4 className="vb-h4">If you sold it now for {pts(c.value)} (×1)</h4>
          <Payoff spreads={[{ side: c.side, short: c.short, long: c.long, entry: c.value, contracts: 1 }]} spot={book.spot} prefs={prefs} height={150} />
          <p className="vb-muted vb-small">Breakeven {strike(breakeven(c.side, c.short, c.value))} · max loss {pts(c.width! - c.value)} pts</p>
        </>
      )}
      <h4 className="vb-h4">Entry alerts</h4>
      {c.alerts.map((x) => <AlertEditor key={x.id} a={x} prefs={prefs} onSave={(t, d) => onEdit(x.id, t, d)} />)}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

/** One holding's review: the burndown is the hero, then the vol and the path, then the history. */
export function ReviewHolding({ h, book, prefs }: { h: Holding; book: Book; prefs: Prefs }) {
  return (
    <div className="vb-review">
      <header className="vb-review-head">
        <span className={`vb-side vb-side-${h.side}`}>{h.side.toUpperCase()}</span>
        <b>{strike(h.short)}/{strike(h.long!)}</b>
        <span className="vb-muted">×{h.contracts} · exp {day(h.expiry)} · {h.dte} DTE</span>
      </header>
      <div className="vb-review-hero">
        <div>
          <span className={`vb-hero-n ${h.pnlPoints >= 0 ? "vb-gain" : "vb-loss"}`}>{usd(h.pnlDollars, prefs)}</span>
          <span className="vb-muted">unrealised · {signed(h.pnlPoints)} pts</span>
        </div>
        <div className={`vb-pace-pill vb-pace-${h.pace.replace(" ", "")}`}>{h.pace}</div>
      </div>
      <Burndown h={{ ...h, live: h.value }} height={230} />
      <IvMultiples h={h} />
      <h4 className="vb-h4">What happened</h4>
      <ul className="vb-history">
        {alertHistory(h).map((t, i) => <li key={i}>{t}</li>)}
      </ul>
      <p className="vb-muted vb-small">Read from the daily samples — the service keeps no alarm log yet.</p>
      <h4 className="vb-h4">Payoff at expiry</h4>
      <Payoff spreads={[{ side: h.side, short: h.short, long: h.long!, entry: h.entry, contracts: h.contracts, value: h.value }]}
              spot={book.spot} prefs={prefs} height={140} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

/** The add flow: one draft creates the spread AND its usual alerts. Nothing is saved. */
export function AddFlow({ book, prefs, onDone }: { book: Book; prefs: Prefs; onDone: (msg: string) => void }) {
  const expiries = [...new Set([...book.candidates, ...book.holdings].map((s) => s.expiry))].sort();
  const [as, setAs] = useState<"holding" | "watch">("holding");
  const [expiry, setExpiry] = useState(expiries[1] ?? expiries[0]!);
  const [side, setSide] = useState<Side>("put");
  const [short, setShort] = useState("7100");
  const [long, setLong] = useState("7050");
  const [contracts, setContracts] = useState(2);
  const [entry, setEntry] = useState("1.40");
  const [deltaAt, setDeltaAt] = useState(as === "holding" ? "0.30" : "0.15");
  const [valueAt, setValueAt] = useState("3.00");

  const k = Number(short), l = Number(long), e = Number(entry);
  const errors: string[] = [];
  if (!Number.isFinite(k) || k <= 0) errors.push("Short strike must be a number.");
  if (!Number.isFinite(l) || l <= 0) errors.push("Long strike must be a number.");
  if (side === "put" && l >= k) errors.push("A put credit spread buys the LOWER strike: long must be below short.");
  if (side === "call" && l <= k) errors.push("A call credit spread buys the HIGHER strike: long must be above short.");
  if (as === "holding" && !(e > 0 && e < Math.abs(k - l))) errors.push(`Credit must be between 0 and the width (${Math.abs(k - l) || "?"}).`);
  const valid = errors.length === 0;
  const stop = valid ? (e * 2).toFixed(2) : "—";

  return (
    <div className="vb-add">
      <div className="vb-seg" role="tablist">
        <button className={as === "holding" ? "on" : ""} onClick={() => { setAs("holding"); setDeltaAt("0.30"); }}>I sold it</button>
        <button className={as === "watch" ? "on" : ""} onClick={() => { setAs("watch"); setDeltaAt("0.15"); }}>Watch for entry</button>
      </div>
      <div className="vb-form">
        <label>Expiry
          <select value={expiry} onChange={(x) => setExpiry(x.target.value)}>
            {expiries.map((d) => <option key={d} value={d}>{day(d)} ({d})</option>)}
          </select>
        </label>
        <div className="vb-seg vb-seg-sm">
          <button className={side === "put" ? "on" : ""} onClick={() => { setSide("put"); setShort("7100"); setLong("7050"); }}>Put spread</button>
          <button className={side === "call" ? "on" : ""} onClick={() => { setSide("call"); setShort("7800"); setLong("7850"); }}>Call spread</button>
        </div>
        <div className="vb-form-2">
          <label>Short (sold)<input inputMode="numeric" value={short} onChange={(x) => setShort(x.target.value)} /></label>
          <label>Long (bought)<input inputMode="numeric" value={long} onChange={(x) => setLong(x.target.value)} /></label>
        </div>
        {as === "holding" ? (
          <div className="vb-form-2">
            <label>Contracts
              <span className="vb-stepper">
                <button onClick={() => setContracts(Math.max(1, contracts - 1))} aria-label="fewer">−</button>
                <b>{contracts}</b>
                <button onClick={() => setContracts(contracts + 1)} aria-label="more">+</button>
              </span>
            </label>
            <label>Credit received<input inputMode="decimal" value={entry} onChange={(x) => setEntry(x.target.value)} /></label>
          </div>
        ) : null}
      </div>

      <h4 className="vb-h4">Alerts created with it</h4>
      <div className="vb-prefill">
        {as === "holding" ? (
          <>
            <label className="vb-prefill-row"><span>Stop: cost to close ≥</span><b>{stop}</b><small>2× the credit</small></label>
            <label className="vb-prefill-row"><span>Short Δ ≥</span><input inputMode="decimal" value={deltaAt} onChange={(x) => setDeltaAt(x.target.value)} /></label>
          </>
        ) : (
          <>
            <label className="vb-prefill-row"><span>Entry: spread value ≥</span><input inputMode="decimal" value={valueAt} onChange={(x) => setValueAt(x.target.value)} /></label>
            <label className="vb-prefill-row"><span>Entry: short Δ ≥</span><input inputMode="decimal" value={deltaAt} onChange={(x) => setDeltaAt(x.target.value)} /></label>
          </>
        )}
      </div>

      {valid ? (
        <>
          <h4 className="vb-h4">Payoff at expiry{as === "watch" ? ` if sold for ${Number(valueAt).toFixed(2)}` : ""}</h4>
          <Payoff spreads={[{ side, short: k, long: l, entry: as === "holding" ? e : Number(valueAt), contracts: as === "holding" ? contracts : 1 }]}
                  spot={book.spot} prefs={prefs} height={150} />
        </>
      ) : (
        <ul className="vb-errs">{errors.map((x) => <li key={x}>{x}</li>)}</ul>
      )}
      <div className="vb-actions vb-actions-sticky">
        <button className="vb-btn vb-btn-wide" disabled={!valid}
                onClick={() => onDone(`prototype — not saved (${day(expiry)} ${strike(k)}/${strike(l)} ${side}${as === "holding" ? ` ×${contracts}, 2 alerts` : ", 2 entry alerts"})`)}>
          <Plus size={18} /> {as === "holding" ? "Record holding + 2 alerts" : "Watch + 2 entry alerts"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function SettingsPanel({ prefs, setPrefs }: { prefs: Prefs; setPrefs: (p: Prefs) => void }) {
  const row = (label: string, hint: string, a: string, b: string, isA: boolean, set: (v: boolean) => void) => (
    <div className="vb-set-row">
      <div><b>{label}</b><small>{hint}</small></div>
      <div className="vb-seg vb-seg-sm">
        <button className={isA ? "on" : ""} onClick={() => set(true)}>{a}</button>
        <button className={!isA ? "on" : ""} onClick={() => set(false)}>{b}</button>
      </div>
    </div>
  );
  return (
    <div className="vb-settings">
      {row("Up colour", "Prices and P&L. Alarms, warnings and faults never change colour.", "Green up", "Red up",
           prefs.upColor === "green", (v) => setPrefs({ ...prefs, upColor: v ? "green" : "red" }))}
      {row("Entry signals", "A fired watchlist alert is good news; show it apart from risk alarms?", "Distinct", "Same as alarms",
           prefs.entryStyle === "distinct", (v) => setPrefs({ ...prefs, entryStyle: v ? "distinct" : "same" }))}
      {row("Privacy", "Hide dollar amounts; keep %, Δ and DTE.", "Show $", "Hide $",
           !prefs.privacy, (v) => setPrefs({ ...prefs, privacy: !v }))}
      <p className="vb-muted vb-small"><BookOpen size={14} /> Live or Review follows the clock in Singapore (Live 22:30–05:00); switch any time.</p>
    </div>
  );
}
