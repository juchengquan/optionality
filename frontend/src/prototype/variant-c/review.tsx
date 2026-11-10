/** PROTOTYPE — throwaway. REVIEW: the map's axis becomes TIME. One lane per holding on a
 *  shared calendar, so every trade's burndown lines up with every other's and with "today";
 *  beside it, where SPX went against that holding's short strike. Closed trades are finished
 *  lanes. Nothing here polls: these are the daily samples plus the last live mark. */
import type { Book, Closed, Holding } from "../data";
import { Burndown, IvSpark, SpotPath } from "./charts";
import {
  dayIndex, fmtDate, fmtPct, fmtPts, fmtSigned, fmtUsd, isoOfDay, worstTone,
} from "./lib";
import { StateChip } from "./detail";

interface Props {
  book: Book;
  holdings: Holding[];
  width: number;
  phone: boolean;
  privacy: boolean;
  entryStyle: "distinct" | "same";
  today: string;
  selected: string | null;
  onSelect: (id: string) => void;
}

export function ReviewMap({ book, holdings, width, phone, privacy, entryStyle, today, selected, onSelect }: Props) {
  const opens = [...holdings.map((h) => h.opened), ...book.closed.map((c) => c.opened)];
  const ends = [...holdings.map((h) => h.expiry), ...book.closed.map((c) => c.closedOn)];
  const domain: [string, string] = [
    isoOfDay(Math.min(...opens.map(dayIndex)) - 1),
    isoOfDay(Math.max(...ends.map(dayIndex)) + 1),
  ];
  // condor pairs adjacent, then by expiry
  const order = [...holdings].sort((a, b) => a.expiry.localeCompare(b.expiry) || (a.side === "call" ? -1 : 1));
  const labelW = phone ? 0 : 220;
  // on the phone the charts sit inside a padded card: 12px a side plus the border
  const chartsW = width - labelW - (phone ? 26 : 24);
  const burnW = phone ? chartsW : Math.round(chartsW * 0.58);
  const pathW = phone ? chartsW : chartsW - burnW - 16;
  const totalOpen = holdings.reduce((s, h) => s + h.pnlDollars, 0);
  const realized = book.closed.reduce((s, c) => s + c.realizedDollars, 0);
  const theta = holdings.reduce((s, h) => s + (h.theta ?? 0) * 100 * h.contracts, 0);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <Stat k="open P&L" v={fmtUsd(totalOpen, privacy)} cls={totalOpen >= 0 ? "gain" : "loss"} />
        <Stat k="realised (closed)" v={fmtUsd(realized, privacy)} cls={realized >= 0 ? "gain" : "loss"} />
        <Stat k="θ per day, held" v={fmtUsd(theta, privacy)} cls="gain" />
        <span className="text-[12px] faint">Calendar {fmtDate(domain[0])} → {fmtDate(domain[1])} · shaded = still to come · not polling</span>
      </div>
      {!phone && (
        <div className="flex text-[11px] font-semibold uppercase tracking-wide faint" style={{ paddingLeft: labelW }}>
          <span style={{ width: burnW }}>cost to close · plan dotted · target / stop dashed</span>
          <span style={{ width: pathW, marginLeft: 16 }}>SPX against the short strike · loss side shaded</span>
        </div>
      )}
      {order.map((h) => {
        const sel = selected === h.id;
        const pnlCls = h.pnlPoints >= 0 ? "gain" : "loss";
        const tone = worstTone(h.alerts, entryStyle);
        return (
          <div key={h.id} role="button" tabIndex={0} onClick={() => onSelect(h.id)}
               onKeyDown={(e) => { if (e.key === "Enter") onSelect(h.id); }}
               className={`card cursor-pointer ${phone ? "grid gap-2 p-3" : "flex items-start gap-6 p-3"}`}
               style={{ outline: sel ? "2px solid var(--accent)" : undefined }}>
            <div style={{ width: phone ? undefined : labelW - 24 }} className="grid gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[15px] font-bold">{h.name}</span>
                <span className="text-[12px] muted">{fmtDate(h.expiry)} · {h.dte}d</span>
              </div>
              <div className="text-[12.5px] muted">{h.contracts}× {h.side} {h.short}/{h.long}{h.pairedWith ? " · condor" : ""}</div>
              <div className="num flex items-baseline gap-3">
                <span className={`text-[18px] font-bold ${pnlCls}`}>{fmtUsd(h.pnlDollars, privacy)}</span>
                <span className={`text-[13px] ${pnlCls}`}>{fmtPct(h.captured)} of max</span>
              </div>
              <div className="text-[12.5px] font-semibold" style={{ color: h.pace === "behind" ? "var(--near)" : h.pace === "ahead" ? "var(--gain)" : "var(--ink)" }}>
                {h.pace} — {fmtPts(h.value)} vs {fmtPts(h.plannedToday)} planned
              </div>
              {tone !== "neutral" && (
                <div className="flex flex-wrap gap-1">
                  {h.alerts.filter((a) => a.state !== "armed").map((a) => <StateChip key={a.id} a={a} entryStyle={entryStyle} />)}
                </div>
              )}
              <div className="flex items-center gap-2 text-[11.5px] faint">
                IV <IvSpark samples={h.samples} width={phone ? 120 : 110} height={22} />
                {fmtPts(h.samples.at(-1)!.shortIv, 1)}%
              </div>
            </div>
            <Burndown h={h} today={today} width={burnW} height={phone ? 140 : 132} domain={domain} />
            <SpotPath samples={h.samples} side={h.side} short={h.short} long={h.long!} entry={h.entry}
                      width={pathW} height={phone ? 100 : 132} domain={domain} spotToday={book.spot} today={today} />
          </div>
        );
      })}
      <h4 className="m-0 mt-2 text-[12px] font-bold uppercase tracking-wide faint">Closed — finished lanes</h4>
      {book.closed.map((c) => <ClosedLane key={c.id} c={c} domain={domain} width={width} phone={phone} privacy={privacy} labelW={labelW} burnW={burnW} pathW={pathW} />)}
    </div>
  );
}

function Stat({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <span className="grid">
      <span className="text-[11px] font-semibold uppercase tracking-wide faint">{k}</span>
      <span className={`num text-[20px] font-bold ${cls ?? ""}`}>{v}</span>
    </span>
  );
}

function ClosedLane({ c, domain, phone, privacy, labelW, burnW, pathW }: {
  c: Closed; domain: [string, string]; width: number; phone: boolean; privacy: boolean; labelW: number; burnW: number; pathW: number;
}) {
  const L = 40, R = 10, T = 10, B = 20, H = phone ? 110 : 100;
  const d0 = dayIndex(domain[0]), d1 = dayIndex(domain[1]);
  const X = (iso: string) => L + ((dayIndex(iso) - d0) / Math.max(1, d1 - d0)) * (burnW - L - R);
  const top = Math.max(c.entry, ...c.samples.map((s) => s.cost)) * 1.15;
  const Y = (v: number) => T + ((top - v) / top) * (H - T - B);
  const cls = c.realizedPoints >= 0 ? "gain" : "loss";
  return (
    <div className={`card ${phone ? "grid gap-2 p-3" : "flex items-start gap-6 p-3"}`} style={{ opacity: 0.85 }}>
      <div style={{ width: phone ? undefined : labelW - 24 }} className="grid gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[15px] font-bold">{c.name}</span>
          <span className="text-[12px] muted">closed {fmtDate(c.closedOn)}</span>
        </div>
        <div className="text-[12.5px] muted">{c.contracts}× {c.side} {c.short}/{c.long} · in {fmtPts(c.entry)} out {fmtPts(c.exit)}</div>
        <div className="num flex items-baseline gap-3">
          <span className={`text-[18px] font-bold ${cls}`}>{fmtUsd(c.realizedDollars, privacy)}</span>
          <span className={`text-[13px] ${cls}`}>{fmtSigned(c.realizedPoints)} pts · {fmtPct(c.realizedPoints / c.entry)} of max</span>
        </div>
      </div>
      <svg width={burnW} height={H} role="img" aria-label={`${c.name}: cost to close until it was closed`}>
        <line x1={L} x2={burnW - R} y1={Y(c.entry)} y2={Y(c.entry)} stroke="var(--rule)" />
        <text x={L - 4} y={Y(c.entry) + 3} textAnchor="end" fontSize={10} fill="var(--ink-3)">{c.entry.toFixed(2)}</text>
        {c.samples.map((s) => <circle key={s.date} cx={X(s.date)} cy={Y(s.cost)} r={2.6} fill={s.atClose ? "var(--ink-2)" : "var(--bg)"} stroke={s.atClose ? "none" : "var(--near)"} />)}
        <line x1={X(c.closedOn)} x2={X(c.closedOn)} y1={T} y2={H - B} stroke="var(--ink-2)" />
        <circle cx={X(c.closedOn)} cy={Y(c.exit)} r={5} fill={`var(--${cls})`} stroke="var(--bg)" strokeWidth={2} />
        <text x={X(c.closedOn) + 7} y={Y(c.exit) + 4} fontSize={10.5} fontWeight={700} fill={`var(--${cls})`}>closed {c.exit.toFixed(2)}</text>
      </svg>
      <SpotPath samples={c.samples} side={c.side} short={c.short} long={c.long} entry={c.entry} width={pathW} height={phone ? 90 : 100} domain={domain} />
    </div>
  );
}
