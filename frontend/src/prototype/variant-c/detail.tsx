/** PROTOTYPE — throwaway. What a tapped bar opens: the drawer on the desk, a bottom sheet on the
 *  phone. Every figure the map can't carry, the payoff at expiry, and the alerts — editable in
 *  place, with the sentence rewriting itself as you type. */
import { useState } from "react";

import type { Alert, Book, Candidate, Holding } from "../data";
import type { Mode } from "../types";
import { Burndown, IvSpark, Payoff, SpotPath, StrikeStrip, cushionLine } from "./charts";
import {
  edited, fmtDate, fmtDelta, fmtPct, fmtPts, fmtSigned, fmtUsd, holdingLeg, plainSentence, toneOf,
  MULT, type Spread, type Tone,
} from "./lib";

const STATE_WORD: Record<string, (a: Alert) => string> = {
  armed: () => "watching",
  near: () => "near",
  fired: (a) => (a.kind === "entry" ? "entry signal" : "ALARM"),
  quarantined: () => "switched off",
  muted: () => "muted",
};
const GLYPH: Record<Tone, string> = { neutral: "○", near: "◔", opportunity: "◎", alarm: "!", fault: "⊘", muted: "–" };

export function StateChip({ a, entryStyle }: { a: Alert; entryStyle: "distinct" | "same" }) {
  const tone = toneOf(a, entryStyle);
  return (
    <span className="chip" data-tone={tone === "neutral" ? undefined : tone}>
      <span aria-hidden>{GLYPH[tone]}</span>{STATE_WORD[a.state]!(a)}
    </span>
  );
}

function AlertRow({ a, entryStyle, onEdit, phone }: {
  a: Alert; entryStyle: "distinct" | "same"; onEdit: (threshold: number, dir: "above" | "below") => void; phone: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [th, setTh] = useState(String(a.threshold));
  const [dir, setDir] = useState<"above" | "below">(a.direction);
  const tone = toneOf(a, entryStyle);
  const preview = Number.isFinite(Number(th)) && th !== "" ? edited(a, Number(th), dir) : a;
  const bar = tone === "neutral" ? "var(--ink-3)" : `var(--${tone === "opportunity" ? "opp" : tone})`;
  return (
    <div className="border-t hairline py-3">
      <div className="flex items-center justify-between gap-2">
        <StateChip a={a} entryStyle={entryStyle} />
        {a.state !== "quarantined" && !editing && (
          <button className="btn" style={{ height: phone ? 44 : 30 }} onClick={() => setEditing(true)}>Edit</button>
        )}
      </div>
      {!editing ? (
        <>
          <p className="mt-1.5 text-[13.5px] leading-snug">{plainSentence(a)}</p>
          {a.state !== "quarantined" && (
            <div className="mt-2 h-1.5 rounded-full" style={{ background: "var(--panel-2)" }}>
              <div className="h-1.5 rounded-full" style={{ width: `${a.fill}%`, background: bar }} />
            </div>
          )}
        </>
      ) : (
        <div className="mt-2 grid gap-2">
          <div className="flex flex-wrap items-end gap-2">
            <span className="pb-2 text-[13px] muted">{a.kind === "entry" ? "Tell me when" : "Warn me when"} {a.field}</span>
            <select aria-label="direction" value={dir} onChange={(e) => setDir(e.target.value as "above" | "below")}>
              <option value="above">≥</option>
              <option value="below">≤</option>
            </select>
            <input aria-label="threshold" inputMode="decimal" value={th} onChange={(e) => setTh(e.target.value)} style={{ width: 96 }} />
          </div>
          <p className="text-[13px] muted">Preview: {plainSentence(preview)}</p>
          <div className="flex gap-2">
            <button className="btn" data-primary="" onClick={() => { onEdit(Number(th), dir); setEditing(false); }}>Save</button>
            <button className="btn" onClick={() => { setEditing(false); setTh(String(a.threshold)); setDir(a.direction); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return <div className="kpi"><span className="k">{k}</span><span className={`v ${cls ?? ""}`}>{v}</span></div>;
}

interface Props {
  book: Book;
  spread: Spread;
  mode: Mode;
  width: number;
  phone: boolean;
  privacy: boolean;
  entryStyle: "distinct" | "same";
  today: string;
  onEditAlert: (id: string, threshold: number, dir: "above" | "below") => void;
  onSelect: (id: string) => void;
  onToast: (t: string) => void;
}

export function Detail(p: Props) {
  return p.spread.kind === "holding" ? <HoldingDetail {...p} h={p.spread} /> : <CandidateDetail {...p} c={p.spread} />;
}

function HoldingDetail({ book, h, mode, width, phone, privacy, entryStyle, today, onEditAlert, onSelect, onToast }: Props & { h: Holding }) {
  const pair = h.pairedWith ? book.holdings.find((x) => x.id === h.pairedWith) : undefined;
  const [whole, setWhole] = useState(Boolean(pair));
  const shown = whole && pair ? [h, pair] : [h];
  const w = width - 32;
  const pnlCls = h.pnlPoints >= 0 ? "gain" : "loss";
  const paceWords = h.pace === "on pace"
    ? `on pace — ${fmtPts(h.value)} against ${fmtPts(h.plannedToday)} planned today`
    : `${h.pace} plan — ${fmtPts(h.value)} against ${fmtPts(h.plannedToday)} planned today`;
  return (
    <div className="grid gap-4 p-4">
      <header>
        <div className="text-[11px] font-semibold uppercase tracking-wide faint">held · {fmtDate(h.expiry)} · {h.dte}d</div>
        <h3 className="m-0 text-[20px] font-bold">{h.name}</h3>
        <div className="text-[13px] muted">{h.contracts}× {h.side} spread {h.short}/{h.long} · opened {fmtDate(h.opened)} for {fmtPts(h.entry)}</div>
        {pair && (
          <button className="mt-2 text-[13px] font-semibold" style={{ color: "var(--accent)", minHeight: phone ? 44 : undefined }}
                  onClick={() => onSelect(pair.id)}>
            condor with {pair.name} ({pair.side}s) →
          </button>
        )}
      </header>
      <div className="grid grid-cols-2 gap-3">
        <Kpi k="cost to close" v={`${fmtPts(h.value)} / ${fmtPts(h.entry)}`} />
        <Kpi k="P&L" v={`${fmtUsd(h.pnlDollars, privacy)} · ${fmtSigned(h.pnlPoints)}`} cls={pnlCls} />
        <Kpi k="of max captured" v={fmtPct(h.captured)} cls={pnlCls} />
        <Kpi k="short Δ / IV" v={`${fmtDelta(h.shortDelta)} / ${fmtPts(h.shortIv, 1)}%`} />
      </div>
      <p className="m-0 text-[14px] font-semibold" style={{ color: h.pace === "behind" ? "var(--near)" : h.pace === "ahead" ? "var(--gain)" : "var(--ink)" }}>
        {paceWords}
      </p>
      <section>
        <StrikeStrip width={w} spot={book.spot} iv={h.shortIv} dte={h.dte}
                     spreads={shown.map((s) => ({ id: s.id, side: s.side, short: s.short, long: s.long, shortDelta: s.shortDelta, held: true }))} />
        <p className="m-0 text-[12.5px] muted">{cushionLine(h.side, h.short, book.spot, h.shortIv, h.dte)}</p>
      </section>
      <section>
        <div className="mb-1 flex items-center justify-between">
          <h4 className="m-0 text-[13px] font-bold">Payoff at expiry</h4>
          {pair && (
            <div className="seg" role="group" aria-label="payoff scope">
              <button aria-pressed={!whole} onClick={() => setWhole(false)}>this spread</button>
              <button aria-pressed={whole} onClick={() => setWhole(true)}>whole condor</button>
            </div>
          )}
        </div>
        <Payoff width={w} spot={book.spot} privacy={privacy} legs={shown.map(holdingLeg)} />
        <p className="m-0 text-[11.5px] faint">At expiry only — no model prices the days between, so none is drawn.</p>
      </section>
      {mode === "review" && (
        <section className="grid gap-2">
          <h4 className="m-0 text-[13px] font-bold">Cost to close against the plan</h4>
          <Burndown h={h} today={today} width={w} />
          <h4 className="m-0 mt-1 text-[13px] font-bold">Where SPX was against the short {h.side}</h4>
          <SpotPath samples={h.samples} side={h.side} short={h.short} long={h.long!} entry={h.entry} width={w}
                    domain={[h.opened, today]} spotToday={book.spot} today={today} />
          <div className="flex items-center justify-between">
            <h4 className="m-0 text-[13px] font-bold">Short IV per day</h4>
            <span className="num text-[12px] muted">{fmtPts(h.samples[0]!.shortIv, 1)}% → {fmtPts(h.samples.at(-1)!.shortIv, 1)}%</span>
          </div>
          <IvSpark samples={h.samples} width={w} />
          <p className="m-0 text-[11.5px] faint">Hollow points are not the close (an evening fill), and are drawn as such.</p>
        </section>
      )}
      <section>
        <h4 className="m-0 text-[13px] font-bold">Alerts</h4>
        {h.alerts.map((a) => <AlertRow key={a.id} a={a} entryStyle={entryStyle} phone={phone} onEdit={(t, d) => onEditAlert(a.id, t, d)} />)}
      </section>
      <section className="grid grid-cols-3 gap-3 border-t hairline pt-3">
        <Kpi k="θ / day" v={privacy ? "$•••" : fmtUsd((h.theta ?? 0) * MULT * h.contracts, false)} />
        <Kpi k="vega" v={fmtPts(h.vega, 3)} />
        <Kpi k="max loss" v={fmtUsd(-((h.width ?? 0) - h.entry) * MULT * h.contracts, privacy)} cls="loss" />
      </section>
      <div className="flex gap-2">
        <button className="btn" onClick={() => onToast("prototype — not saved")}>Close holding…</button>
        <button className="btn" onClick={() => onToast("prototype — not saved")}>Edit</button>
      </div>
    </div>
  );
}

function CandidateDetail({ book, c, width, phone, privacy, entryStyle, onEditAlert, onToast }: Props & { c: Candidate }) {
  const w = width - 32;
  const quarantined = c.alerts.find((a) => a.state === "quarantined");
  return (
    <div className="grid gap-4 p-4">
      <header>
        <div className="text-[11px] font-semibold uppercase tracking-wide faint">watching · {fmtDate(c.expiry)} · {c.dte}d</div>
        <h3 className="m-0 text-[20px] font-bold">{c.name}</h3>
        <div className="text-[13px] muted">{c.long === null ? `short ${c.side} ${c.short}, watched alone` : `${c.side} spread ${c.short}/${c.long}`} · a candidate, not held</div>
      </header>
      {quarantined && (
        <div className="card p-3" style={{ borderColor: "var(--fault)", borderStyle: "dashed" }}>
          <p className="m-0 text-[13.5px] font-semibold" style={{ color: "var(--fault)" }}>⊘ Switched off, not deleted</p>
          <p className="m-0 mt-1 text-[13px] muted">{quarantined.reason}</p>
          <div className="mt-2 flex gap-2">
            <button className="btn" onClick={() => onToast("prototype — not saved")}>Check again</button>
            <button className="btn" onClick={() => onToast("prototype — not saved")}>Delete</button>
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Kpi k={c.long === null ? "option mid" : "spread value"} v={fmtPts(c.value)} />
        <Kpi k="short Δ" v={fmtDelta(c.shortDelta)} />
        <Kpi k="short IV" v={c.shortIv === null ? "—" : `${fmtPts(c.shortIv, 1)}%`} />
        <Kpi k="θ / day, 1 lot" v={c.theta === null ? "—" : privacy ? "$•••" : fmtUsd(c.theta * MULT, false)} />
      </div>
      <section>
        <StrikeStrip width={w} spot={book.spot} iv={c.shortIv} dte={c.dte}
                     spreads={[{ id: c.id, side: c.side, short: c.short, long: c.long, shortDelta: c.shortDelta, held: false }]} />
        <p className="m-0 text-[12.5px] muted">{cushionLine(c.side, c.short, book.spot, c.shortIv, c.dte)}</p>
      </section>
      {c.long !== null && c.value !== null && (
        <section>
          <h4 className="m-0 mb-1 text-[13px] font-bold">If sold now for {fmtPts(c.value)} — payoff at expiry, 1 lot</h4>
          <Payoff width={w} spot={book.spot} privacy={privacy}
                  legs={[{ side: c.side, short: c.short, width: c.width ?? 0, credit: c.value, contracts: 1 }]} />
        </section>
      )}
      <section>
        <h4 className="m-0 text-[13px] font-bold">Entry alerts</h4>
        {c.alerts.map((a) => <AlertRow key={a.id} a={a} entryStyle={entryStyle} phone={phone} onEdit={(t, d) => onEditAlert(a.id, t, d)} />)}
      </section>
    </div>
  );
}
