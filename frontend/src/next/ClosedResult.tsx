/** What a close did (#294), said once the holding has left the live view: what it made, in the
 *  service's POINTS (ADR 0022), and what became of each Monitor — handed to an open holding that
 *  still holds its contracts, or switched off as `holding-closed` — as the service reported it.
 *
 *  It also offers the correction where the mistake was just made, as the closed trades' fold
 *  does for any close later (#296, `ClosedTrade.tsx`) — the one form, `Correction`, in both. It
 *  goes by the PATCH ADR 0022 gives, and keeps every sample a delete would take.
 *
 *  Drawn by the page rather than by the inspector or the sheet that closed it, both of which go
 *  with the holding — on the desk above the table, on the phone at the top of the book.
 */
import { useEffect, useRef, useState } from "react";

import { correctClose } from "../shared/api";
import { correctionBody, exitPrefill, type CloseDraft } from "./holding";
import { madeWords } from "./journal";
import { DayField, ExitField, type ClosedOutcome } from "./HoldingActions";

/** Brings the account into view and puts the focus on it — once the sheet it was closed from has
 *  gone. On the phone the close happens in a modal sheet, which locks the page's scroll and, as it
 *  goes, puts the scroll back where it was and the focus back on the card it opened from: done
 *  any sooner, both were undone, and the account sat 600px above the screen. So it waits for the
 *  lock and every sheet to be gone, for two seconds at most. */
function sayWhenSettled(section: HTMLElement | null, heading: HTMLElement | null): () => void {
  const started = performance.now();
  let frame = 0;
  const busy = () => document.documentElement.hasAttribute("data-base-ui-scroll-locked")
    || document.querySelector('[data-slot="sheet-content"]') !== null;
  const step = () => {
    if (busy() && performance.now() - started < 2000) { frame = requestAnimationFrame(step); return; }
    section?.scrollIntoView?.({ block: "start" });
    heading?.focus({ preventScroll: true });
  };
  step();
  return () => cancelAnimationFrame(frame);
}

/** Entry and Exit as STORED — 1.225 is not 1.23 — with only a sum's float noise trimmed */
const stored = (n: number | null) => (n === null ? null : String(Number(n.toFixed(6))));

export function ClosedResult({ outcome, privacy, onDone, onCorrected, served }: {
  outcome: ClosedOutcome;
  privacy: boolean;
  onDone: () => void;
  /** the page reads the book again after a correction */
  onCorrected: () => void;
  /** this close as the closed trades' journal last read it (#296), where it has — null until the
   *  fold is first opened (#373), when the close's own answer is all there is: a correction made
   *  there is the service's word too, and this account must not go on saying the figures it replaced */
  served?: { closed_on: string; exit: number | null; realized_points: number | null } | null;
}) {
  const { holding, fates, fatesError } = outcome;
  // the close as the service now has it: its answer, then any correction's, from here or the journal
  const [now, setNow] = useState({
    closed_on: outcome.closed.closed_on, exit: outcome.closed.exit,
    realized_points: outcome.closed.realized_points,
  });
  // taken when the journal's figures CHANGE, and only then: a read the journal made before this
  // account's own correction is never adopted over it, because that read never lands (useJournal).
  // Taken in the render that brings them, as `Correction` follows its own, rather than an effect
  // after the paint.
  const seen = [served?.closed_on, served?.exit, served?.realized_points].join("|");
  const [lastSeen, setLastSeen] = useState(seen);
  if (seen !== lastSeen) {
    setLastSeen(seen);
    if (served) setNow({ closed_on: served.closed_on, exit: served.exit, realized_points: served.realized_points });
  }
  const heading = useRef<HTMLHeadingElement>(null);
  const section = useRef<HTMLElement>(null);
  useEffect(() => sayWhenSettled(section.current, heading.current), []);

  const made = now.realized_points === null
    ? "unknown — the Exit or the Entry was not recorded"
    // across the contracts held, so under privacy it would give the size away: × 100 is dollars
    : madeWords(now.realized_points, privacy);

  return (
    <section ref={section} className="nx-closed" aria-label={`closed ${holding.name}`}>
      <h2 ref={heading} tabIndex={-1}>{`Closed ${holding.name}`}</h2>
      <p>
        {`closed on ${now.closed_on ?? "—"} · entry ${stored(holding.entry) ?? "—"} → exit ${stored(now.exit) ?? "—"} · made `}
        <strong data-testid="realized">{made}</strong>
      </p>
      <p className="nx-meta">Points, Entry less Exit across the contracts held: a closed holding has no quote to give it a dollar size.</p>
      <h3>Its Monitors</h3>
      {fates === null ? (
        <p className="nx-hold-error">{`The Monitors could not be read back after the close — ${fatesError ?? "no answer"}. The Muted list says where each is.`}</p>
      ) : fates.length === 0 ? (
        <p className="nx-meta">No Monitor watched it.</p>
      ) : (
        <ul className="nx-closed-fates">
          {fates.map((f) => <li key={f.id}><span>{f.name}</span>{` — ${f.fate}`}</li>)}
        </ul>
      )}
      <Correction id={holding.id} name={holding.name} closedOn={now.closed_on ?? ""} exit={now.exit}
                  onSaved={(c) => { setNow(c); onCorrected(); }} />
      <div className="nx-hold-row">
        <button type="button" className="nx-hold-primary" onClick={onDone}>Done</button>
      </div>
    </section>
  );
}

/** A mistyped close corrected, by PATCH (ADR 0022): drawn under a close's account and under each
 *  trade in the closed trades' fold. */
export function Correction({ id, name, closedOn, exit, onSaved }: {
  id: string; name: string; closedOn: string; exit: number | null;
  onSaved: (c: { closed_on: string | null; exit: number | null; realized_points: number | null }) => void;
}) {
  const [draft, setDraft] = useState<CloseDraft>(() => ({ exit: exitPrefill(exit), closedOn }));
  // The close as the service has it is the form's ground: what it starts from and what a save is
  // measured against (`correctionBody` sends only what changed). When it changes — this form's own
  // save, or the other form's, read back — the boxes follow it, so neither form can hold an old
  // figure to send back over a newer one. The "corrected" said beside the button is kept.
  // Followed DURING the render that brings the new figures, not in an effect after it: an effect
  // runs after the paint, so for a moment the page said 0.7 beside a box still holding 1 — a window
  // a fast hand could save into, and one a loaded test runner caught.
  const [ground, setGround] = useState({ exit, closedOn });
  if (ground.exit !== exit || ground.closedOn !== closedOn) {
    setGround({ exit, closedOn });
    setDraft({ exit: exitPrefill(exit), closedOn });
  }
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // a ref, not only the state: two submits in one tick both read the state from before either set it
  const busy = useRef(false);
  const change = (c: Partial<CloseDraft>) => { setDraft((d) => ({ ...d, ...c })); setError(null); setSaved(false); };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy.current) return;
    const out = correctionBody({ exit, closed_on: closedOn }, draft);
    if ("error" in out) { setError(out.error); return; }
    busy.current = true;
    setSaving(true);
    try {
      const answer = await correctClose(id, out.body);
      onSaved({ closed_on: answer.closed_on, exit: answer.exit, realized_points: answer.realized_points });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  // Escape cancels an edit: the boxes back to the close as the service has it. Taken only when there
  // is an edit to cancel, so an Escape with nothing typed is still whatever holds this form's
  const edited = draft.exit !== exitPrefill(exit) || draft.closedOn !== closedOn;
  const cancel = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || !edited) return;
    e.preventDefault();
    setDraft({ exit: exitPrefill(exit), closedOn });
    setError(null);
  };

  return (
    <form className="nx-hold-form" aria-label={`correct the close of ${name}`} data-poll="hold" noValidate
          onSubmit={(e) => void save(e)} onKeyDown={cancel}>
      <h3>Mistyped?</h3>
      <p className="nx-meta">Correct the Exit or the day here; the holding and its samples are kept either way.</p>
      <div className="nx-hold-row">
        <ExitField value={draft.exit} onChange={(v) => change({ exit: v })} />
        <DayField value={draft.closedOn} onChange={(v) => change({ closedOn: v })} />
      </div>
      {error ? <p className="nx-hold-error" role="alert">{error}</p> : null}
      {/* mounted empty and filled, so a screen reader announces it */}
      <p className="nx-meta" role="status">{saved ? "corrected" : ""}</p>
      <div className="nx-hold-row">
        <button type="submit" disabled={saving}>{saving ? "saving…" : "Save correction"}</button>
      </div>
    </form>
  );
}
