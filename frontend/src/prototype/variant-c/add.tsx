/** PROTOTYPE — throwaway. "Add a spread": one draft that becomes a holding WITH its two usual
 *  alerts, or a watched candidate with its entry alerts — previewed live on the same price
 *  strip and payoff the rest of the variant uses, so a sign or strike mistake shows before it
 *  is saved. Saves nothing. */
import { useState } from "react";

import type { Book, Side } from "../data";
import { Payoff, StrikeStrip } from "./charts";
import { fmtDate } from "./lib";

export function AddSpread({ book, width, phone, privacy, onDone, onToast }: {
  book: Book; width: number; phone: boolean; privacy: boolean; onDone: () => void; onToast: (t: string) => void;
}) {
  const expiries = [...new Set([...book.holdings, ...book.candidates].map((s) => s.expiry))].sort();
  const [dest, setDest] = useState<"holding" | "watch">("holding");
  const [expiry, setExpiry] = useState(expiries.at(-1) ?? "2026-12-31");
  const [side, setSide] = useState<Side>("put");
  const [short, setShort] = useState("7200");
  const [long, setLong] = useState("7150");
  const [contracts, setContracts] = useState("2");
  const [entry, setEntry] = useState("1.25");
  const [valueAlert, setValueAlert] = useState("2.00");
  const [deltaAlert, setDeltaAlert] = useState(dest === "holding" ? "0.30" : "0.15");
  const [stopOn, setStopOn] = useState(true);
  const [deltaOn, setDeltaOn] = useState(true);

  const s = Number(short), l = Number(long), e = Number(entry), n = Number(contracts);
  const width_ = Math.abs(l - s);
  const wrongSide = side === "call" ? l <= s : l >= s;
  const problems: string[] = [];
  if (!Number.isFinite(s) || s <= 0) problems.push("Short strike must be a number.");
  if (wrongSide) problems.push(`For a ${side} spread the long strike goes ${side === "call" ? "ABOVE" : "BELOW"} the short — ${side === "call" ? `try ${s + 50}` : `try ${s - 50}`}.`);
  if (dest === "holding" && !(e > 0 && e < width_)) problems.push(`Entry credit must be between 0 and the width (${width_}).`);
  const credit = dest === "holding" ? e : Number(valueAlert);
  const stop = (e * 2).toFixed(2);
  const sameExpiry = [...book.holdings, ...book.candidates].filter((x) => x.expiry === expiry);
  const dte = Math.round((Date.parse(`${expiry}T12:00:00Z`) - Date.now()) / 86400000);
  const iv = sameExpiry.find((x) => x.shortIv !== null)?.shortIv ?? null;
  const w = width - 32;

  const flip = (next: Side) => {
    setSide(next);
    // keep the width, move the long wing to the right side of the short one
    setLong(String(next === "call" ? s + (width_ || 50) : s - (width_ || 50)));
  };

  return (
    <div className="grid gap-4 p-4">
      <header>
        <h3 className="m-0 text-[20px] font-bold">Add a spread</h3>
        <p className="m-0 text-[13px] muted">One draft: the spread and the alerts that watch it, saved together.</p>
      </header>
      <div className="seg" role="group" aria-label="what is this">
        <button aria-pressed={dest === "holding"} onClick={() => { setDest("holding"); setDeltaAlert("0.30"); }}>I hold it</button>
        <button aria-pressed={dest === "watch"} onClick={() => { setDest("watch"); setDeltaAlert("0.15"); }}>Watch for entry</button>
      </div>
      <div className={`grid gap-3 ${phone ? "grid-cols-2" : "grid-cols-3"}`}>
        <label className="field">Expiry
          <select value={expiry} onChange={(ev) => setExpiry(ev.target.value)}>
            {[...expiries, "2027-01-15"].map((x) => <option key={x} value={x}>{fmtDate(x)} {x.slice(0, 4)}</option>)}
          </select>
        </label>
        <div className="field" role="group" aria-label="side">Side
          <div className="seg">
            <button aria-pressed={side === "put"} onClick={() => flip("put")}>put</button>
            <button aria-pressed={side === "call"} onClick={() => flip("call")}>call</button>
          </div>
        </div>
        <label className="field">Short strike<input inputMode="numeric" value={short} onChange={(ev) => setShort(ev.target.value)} /></label>
        <label className="field">Long strike<input inputMode="numeric" value={long} onChange={(ev) => setLong(ev.target.value)} /></label>
        {dest === "holding" && <label className="field">Contracts<input inputMode="numeric" value={contracts} onChange={(ev) => setContracts(ev.target.value)} /></label>}
        {dest === "holding" && <label className="field">Entry credit<input inputMode="decimal" value={entry} onChange={(ev) => setEntry(ev.target.value)} /></label>}
      </div>
      {problems.length > 0 && (
        <ul className="m-0 grid gap-1 pl-0 text-[13px]" style={{ listStyle: "none", color: "var(--near)" }}>
          {problems.map((p) => <li key={p}>▲ {p}</li>)}
        </ul>
      )}
      <section className="grid gap-1">
        <h4 className="m-0 text-[13px] font-bold">On the map — {fmtDate(expiry)}</h4>
        <StrikeStrip width={w} spot={book.spot} iv={iv} dte={Math.max(1, dte)}
                     spreads={[
                       ...sameExpiry.map((x) => ({ id: x.id, side: x.side, short: x.short, long: x.long, shortDelta: x.shortDelta, held: x.kind === "holding" })),
                       ...(wrongSide ? [] : [{ id: "draft", side, short: s, long: l, shortDelta: null, held: dest === "holding" }]),
                     ]} />
      </section>
      {!wrongSide && credit > 0 && (
        <section>
          <h4 className="m-0 mb-1 text-[13px] font-bold">{dest === "holding" ? "Payoff at expiry" : `If sold for ${credit.toFixed(2)} — payoff at expiry, 1 lot`}</h4>
          <Payoff width={w} spot={book.spot} privacy={privacy} height={150}
                  legs={[{ side, short: s, width: width_, credit, contracts: dest === "holding" ? n || 1 : 1 }]} />
        </section>
      )}
      <section className="grid gap-2">
        <h4 className="m-0 text-[13px] font-bold">{dest === "holding" ? "Its alerts (risk)" : "Its entry alerts"}</h4>
        {dest === "holding" ? (
          <>
            <Toggle on={stopOn} set={setStopOn}>Warn me when cost to close ≥ <b className="num">{stop}</b> (2× entry)</Toggle>
            <Toggle on={deltaOn} set={setDeltaOn}>Warn me when short Δ ≥ <input aria-label="delta threshold" className="num" value={deltaAlert} onChange={(ev) => setDeltaAlert(ev.target.value)} style={{ width: 72 }} /></Toggle>
          </>
        ) : (
          <>
            <Toggle on={stopOn} set={setStopOn}>Tell me when spread value ≥ <input aria-label="value threshold" className="num" value={valueAlert} onChange={(ev) => setValueAlert(ev.target.value)} style={{ width: 80 }} /></Toggle>
            <Toggle on={deltaOn} set={setDeltaOn}>Tell me when short Δ ≥ <input aria-label="delta threshold" className="num" value={deltaAlert} onChange={(ev) => setDeltaAlert(ev.target.value)} style={{ width: 72 }} /></Toggle>
          </>
        )}
      </section>
      <div className="flex gap-2">
        <button className="btn" data-primary="" disabled={problems.length > 0} style={{ opacity: problems.length ? 0.5 : 1 }}
                onClick={() => { onToast("prototype — not saved"); onDone(); }}>
          {dest === "holding" ? "Save holding + 2 alerts" : "Watch it"}
        </button>
        <button className="btn" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function Toggle({ on, set, children }: { on: boolean; set: (b: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="flex min-h-11 items-center gap-3 rounded-lg border hairline px-3 py-1.5 text-[13.5px]" style={{ opacity: on ? 1 : 0.55 }}>
      <input type="checkbox" checked={on} onChange={(ev) => set(ev.target.checked)} style={{ width: 20, height: 20 }} />
      <span className="flex flex-wrap items-center gap-1.5">{children}</span>
    </label>
  );
}
