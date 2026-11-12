/** A holding's pace explained (#333, ADR 0011), in the desk's inspector and the phone's holding
 *  detail, in LIVE and REVIEW alike: the DTE it was opened at, the gap in words, the √T working of
 *  its On-pace, the DTE decay alone reaches the Target at, and what `/positions/{id}/vol` says of
 *  the gap — vol's part and the rest, or why it cannot split it and how many vol points would.
 *
 *  - **Every figure is the service's.** The working is the schedule's On-pace beside the served
 *    figures it came from, written out so it can be checked by eye; the split is the route's own
 *    `vol`, `rest`, `gap`, `vega` and `cover`, never a subtraction here. The split's gap is the one
 *    at the close the vol part runs to (`at`), which is why it is dated: the live gap above it is
 *    a later instant, and the three figures of the split are only one sum at one.
 *  - **Read once, when opened, and never polled**, in either mode: the split changes at most once a
 *    market day. A new valuation of the same holding asks nothing more; an answer is kept under
 *    the id it answered, so another holding's split is never shown under this one while its own is
 *    asked for (`useSamples` in History.tsx, the same guard).
 *  - **Points per contract**, like the gap itself, so privacy hides nothing here: no money and no
 *    contract count is in it.
 *  - Nothing without a schedule: no Opened, no On-pace, no gap to explain — and the route would
 *    only say so again.
 */
import { useEffect, useState } from "react";

import { fetchVol, type Holding, type Vol } from "../api";
import { DASH } from "../format";
import { paceOutcome, paceWords } from "./pace";
import "./pace.css";

export function PaceExplained({ holding }: { holding: Holding }) {
  const s = holding.schedule;
  if (!s) return null;
  const working = s.on_pace !== null && holding.entry !== null
    ? `on pace ${s.on_pace.toFixed(2)} = ${holding.entry.toFixed(2)} × √(${holding.dte} ÷ ${s.dte_at_open})`
    : null;
  return (
    <section className="nx-pace" aria-label="the pace explained">
      <p>
        {`opened at ${s.dte_at_open} DTE`}
        {s.pace_gap === null ? null : (
          <>{" · "}<strong data-outcome={paceOutcome(s.pace_gap)}>{paceWords(s.pace_gap)}</strong></>
        )}
      </p>
      {working ? <p className="nx-pace-working">{working}</p> : null}
      <dl className="nx-pace-kv">
        <div>
          <dt>target on decay alone</dt>
          <dd>{s.target_dte === null ? DASH : `${s.target_dte} DTE`}</dd>
        </div>
      </dl>
      {/* the two things the shape cannot see, named rather than implied (ADR 0011) */}
      {working ? (
        <p className="nx-pace-note">
          A shape, not a price: time value decays as √time. Assumes IV holds, and says nothing about
          where SPX is.
        </p>
      ) : null}
      <Split id={holding.id} />
    </section>
  );
}

interface VolState {
  id: string;
  vol?: Vol;
  error?: string;
}

/** The split for `id`, asked for once per id. What is kept is the last ANSWER, under the id it
 *  answered, and shown only while that is still the id asked about. */
function useVol(id: string): VolState | null {
  const [state, setState] = useState<VolState | null>(null);
  useEffect(() => {
    let live = true;
    fetchVol(id).then(
      (vol) => { if (live) setState({ id, vol }); },
      (err: unknown) => { if (live) setState({ id, error: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { live = false; };
  }, [id]);
  return state?.id === id ? state : null;
}

const DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
/** "9 Nov": a market date read in UTC, so the device's zone cannot move it. */
const dayWords = (iso: string) => DAY.format(new Date(`${iso}T00:00:00Z`));

/** "cost you" or "saved you": a vol part is POSITIVE when it hurts, the opposite of a P&L, so it
 *  is said in words and never as a sign (ADR 0011). */
const costWords = (n: number) => `${n >= 0 ? "cost" : "saved"} you ${Math.abs(n).toFixed(2)}`;

function Split({ id }: { id: string }) {
  const state = useVol(id);
  if (state === null) return <p className="nx-pace-note">reading what vol did…</p>;
  // a failed read costs the split and nothing else: the rest came with the holding
  if (state.vol === undefined) {
    return <p className="nx-pace-note">{`what vol did could not be read — ${state.error}`}</p>;
  }
  const v = state.vol;
  const vega = v.vega === null ? null : ` · net vega ${v.vega.toFixed(2)}`;
  return (
    <div className="nx-pace-split" data-split="">
      {v.at !== null && v.gap !== null ? (
        <p>
          {`at the ${dayWords(v.at)} close: `}
          <strong data-outcome={paceOutcome(v.gap)}>{paceWords(v.gap)}</strong>
        </p>
      ) : null}
      {v.reason === null && v.vol !== null ? (
        <>
          <p>
            {`vol ${costWords(v.vol)}`}
            {v.rest === null ? " · the rest cannot be said: that close has no Cost to close" : ` · the rest ${costWords(v.rest)}`}
          </p>
          <p className="nx-pace-note">
            {`over ${v.days} day${v.days === 1 ? "" : "s"} from ${dayWords(v.from!)}`}{vega}
          </p>
        </>
      ) : (
        <>
          <p className="nx-pace-why">{`vol cannot be split out: ${v.reason ?? "the service gave no reason"}`}</p>
          {v.cover === null ? null : (
            <p className="nx-pace-note">{`${v.cover.toFixed(2)} vol points would cover this gap`}{vega}</p>
          )}
        </>
      )}
    </div>
  );
}
