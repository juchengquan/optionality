/** Editing, closing and deleting a holding (#294): one block, drawn in the desk's inspector and in
 *  the phone's sheet, so either arrangement can do what the other can (ADR 0023's parity).
 *
 *  What each form posts is `holding.ts`'s; this draws the forms and says what went wrong, INSIDE
 *  the form, by the button that was pressed, as the add form does. Each opens in place under the
 *  three buttons, takes the focus, and hands it back to its button on Cancel or Escape — an Escape
 *  here is the form's, never the inspector's.
 *
 *  A close's outcome is NOT drawn here. The closed holding leaves the live view at once, and this
 *  block with it, so the outcome — what it made, where its Monitors went, and the correction — is
 *  handed up (`HoldingWrites.closed`) and drawn by the page (`ClosedResult.tsx`).
 */
import { useEffect, useId, useRef, useState } from "react";

import {
  closePosition, deletePosition, fetchMonitors, patchPosition, type Closed, type Entry, type Holding,
  type Monitor,
} from "../api";
import { marketDay } from "../format";
import {
  closeBody, closeDay, editBody, editDraft, exitPrefill, fates, type CloseDraft, type EditDraft,
  type Fate, type Watching,
} from "./holding";
import { fieldWords, monitorName } from "./needs";
import "./holding.css";

/** What a close answered, for the page to say. */
export interface ClosedOutcome {
  /** the holding as it stood when it was closed */
  holding: Holding;
  closed: Closed;
  /** each Monitor's fate as the service reports it, or null where `/monitors` could not be read */
  fates: Fate[] | null;
  fatesError: string | null;
}

/** What the page does after each write: the book read again, and the holding taken off the live
 *  view at once after a close or a delete — no poll asked before the write can bring it back. */
export interface HoldingWrites {
  edited: (holding: Holding) => void;
  closed: (outcome: ClosedOutcome) => void;
  deleted: (holding: Holding) => void;
}

type Open = "edit" | "close" | "delete" | null;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The rules the page knows watch this holding: every `/monitors` row linked to it, and every
 *  enabled rule `placeBook` sat under it. */
function watchingOf(holding: Holding, monitors: Monitor[], rules: Entry[]): Watching[] {
  const ids = new Set(rules.map((r) => r.id));
  return monitors
    .filter((m) => ids.has(m.id) || m.positions.some((p) => p.id === holding.id))
    .map((m) => ({ id: m.id, name: `${monitorName(m)} · ${fieldWords(m.field, Boolean(m.legs))}` }));
}

export function HoldingActions({ holding, monitors, rules, privacy, writes, now }: {
  holding: Holding;
  /** every rule, as `/monitors` gave them */
  monitors: Monitor[];
  /** the enabled rules placed under this holding */
  rules: Entry[];
  privacy: boolean;
  writes: HoldingWrites;
  /** injected only by tests: the close's day is the New York trading day on this clock */
  now?: Date;
}) {
  const [open, setOpen] = useState<Open>(null);
  // said HERE, by the buttons, not in a toast: on the desk a toast lands over the inspector's own
  // buttons, and the next one pressed was under it
  const [saved, setSaved] = useState(false);
  const buttons = useRef<Record<Exclude<Open, null>, HTMLButtonElement | null>>({ edit: null, close: null, delete: null });
  const id = useId();
  const watching = watchingOf(holding, monitors, rules);

  const toggle = (which: Exclude<Open, null>) => { setSaved(false); setOpen((o) => (o === which ? null : which)); };
  /** back to the button that opened it */
  const cancel = () => {
    const was = open;
    setOpen(null);
    if (was) buttons.current[was]?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // the form's, not the inspector's nor the sheet's: they read defaultPrevented
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };

  return (
    <div className="nx-hold" data-holding={holding.id} onKeyDown={onKeyDown}>
      <div className="nx-hold-actions" role="group" aria-label={`change ${holding.name}`}>
        <button ref={(el) => { buttons.current.edit = el; }} type="button" aria-expanded={open === "edit"}
                aria-controls={open === "edit" ? `${id}-form` : undefined} onClick={() => toggle("edit")}>Edit</button>
        {/* closing comes before deleting: it is how a trade ends, and it keeps what deleting
            throws away (ADR 0022) */}
        <button ref={(el) => { buttons.current.close = el; }} type="button" aria-expanded={open === "close"}
                aria-controls={open === "close" ? `${id}-form` : undefined} onClick={() => toggle("close")}>Close…</button>
        <button ref={(el) => { buttons.current.delete = el; }} type="button" className="nx-hold-danger"
                aria-expanded={open === "delete"} aria-controls={open === "delete" ? `${id}-form` : undefined}
                onClick={() => toggle("delete")}>Delete…</button>
      </div>
      {/* mounted empty and filled, so a screen reader announces it */}
      <p className="nx-meta nx-hold-status" role="status">{saved ? `saved ${holding.name}` : ""}</p>
      {open === "edit" ? (
        <EditForm id={`${id}-form`} holding={holding} watching={watching.length} privacy={privacy} now={now}
                  onCancel={cancel} onSaved={() => {
                    setOpen(null); setSaved(true); buttons.current.edit?.focus(); writes.edited(holding);
                  }} />
      ) : open === "close" ? (
        <CloseForm id={`${id}-form`} holding={holding} now={now} onCancel={cancel}
                   onClosed={async (closed) => {
                     // the Monitors as the service now has them: read back, never inferred here
                     let after: Monitor[] | null = null;
                     let why: string | null = null;
                     try { after = await fetchMonitors(); } catch (e) { why = message(e); }
                     writes.closed({
                       holding, closed, fates: after ? fates(watching, after, closed.disabled_monitors) : null,
                       fatesError: why,
                     });
                   }} />
      ) : open === "delete" ? (
        <DeleteAsk id={`${id}-form`} holding={holding} watching={watching.length} onCancel={cancel}
                   onCloseInstead={() => setOpen("close")}
                   onDeleted={() => writes.deleted(holding)} />
      ) : null}
    </div>
  );
}

function EditForm({ id, holding, watching, privacy, now, onCancel, onSaved }: {
  id: string; holding: Holding; watching: number; privacy: boolean; now?: Date;
  onCancel: () => void; onSaved: () => void;
}) {
  const [draft, setDraft] = useState<EditDraft>(() => editDraft(holding));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const change = (c: Partial<EditDraft>) => { setDraft((d) => ({ ...d, ...c })); setError(null); };
  const trading = marketDay(now);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const out = editBody(holding, draft);
    if ("error" in out) { setError(out.error); return; }
    setSaving(true);
    try {
      await patchPosition(holding.id, out.body);
      onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form id={id} className="nx-hold-form" aria-label={`edit ${holding.name}`} data-poll="hold" noValidate
          onSubmit={(e) => void save(e)}>
      <div className="nx-hold-row">
        <label className="nx-hold-field">
          <span>entry, per contract</span>
          <input ref={first} aria-label="entry, per contract" inputMode="decimal" value={draft.entry}
                 placeholder="credit +, debit −" onChange={(e) => change({ entry: e.target.value })} />
        </label>
        <label className="nx-hold-field nx-hold-count">
          <span>contracts</span>
          {/* the count is hidden under privacy, as the dollars it multiplies are (ADR 0023) */}
          <input aria-label="contracts" inputMode="numeric" value={draft.contracts} autoComplete="off"
                 className={privacy ? "nx-private" : undefined} data-private={privacy ? "" : undefined}
                 onChange={(e) => change({ contracts: e.target.value })} />
        </label>
        <label className="nx-hold-field">
          <span>opened</span>
          <input type="date" aria-label="opened" value={draft.opened} onChange={(e) => change({ opened: e.target.value })} />
          <small className="nx-meta">
            {"the New York trading day · "}
            <button type="button" className="nx-hold-link" onClick={() => change({ opened: trading })}>
              {`today's: ${trading}`}
            </button>
          </small>
        </label>
      </div>
      <p className="nx-meta">
        {"The name and the legs stay as recorded — the service does not edit them. "}
        {"A wrong name cannot be changed, and the daily samples are worth more than the name: keep it. "}
        {"Wrong legs are a different holding: delete it and add it again — which deletes its daily samples "}
        {"for good"}
        {watching > 0
          ? `; its ${watching} Monitor${watching === 1 ? " is" : "s are"} kept, and a holding added with the same contracts takes ${watching === 1 ? "it" : "them"} back.`
          : "."}
      </p>
      {error ? <p className="nx-hold-error" role="alert">{error}</p> : null}
      <div className="nx-hold-row">
        <button type="submit" className="nx-hold-primary" disabled={saving}>{saving ? "saving…" : "Save"}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function CloseForm({ id, holding, now, onCancel, onClosed }: {
  id: string; holding: Holding; now?: Date; onCancel: () => void;
  onClosed: (closed: Closed) => Promise<void>;
}) {
  const [draft, setDraft] = useState<CloseDraft>(() => ({
    exit: exitPrefill(holding.cost_to_close), closedOn: closeDay(holding.strike_date, marketDay(now)),
  }));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // a REF as well as the state: two submits in one tick both read the state from before either set
  // it, and a second close is a 409 shown over a close that succeeded
  const busy = useRef(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const change = (c: Partial<CloseDraft>) => { setDraft((d) => ({ ...d, ...c })); setError(null); };
  const expired = holding.strike_date < marketDay(now);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy.current) return;
    const out = closeBody(draft);
    if ("error" in out) { setError(out.error); return; }
    busy.current = true;
    setSaving(true);
    let closed: Closed;
    try {
      closed = await closePosition(holding.id, out.body);
    } catch (err) {
      setError(message(err));
      busy.current = false;
      setSaving(false);
      return;
    }
    await onClosed(closed);
  };

  return (
    <form id={id} className="nx-hold-form" aria-label={`close ${holding.name}`} data-poll="hold" noValidate
          onSubmit={(e) => void save(e)}>
      <p className="nx-meta">
        It leaves the live book and is kept, with its legs, Entry, Opened and daily samples. Each Monitor
        watching it is handed to an open holding that still holds its contracts, or switched off — the
        service decides which, and says so once it is closed.
      </p>
      <div className="nx-hold-row">
        <ExitField inputRef={first} value={draft.exit} onChange={(exit) => change({ exit })}
                   served={holding.cost_to_close} valuedAt={holding.fetched_at}
                   // never prefilled: blank is "unknown" (ADR 0022), and 0 is the owner's to say
                   expired={expired} />
        <DayField value={draft.closedOn} onChange={(closedOn) => change({ closedOn })} />
      </div>
      {error ? <p className="nx-hold-error" role="alert">{error}</p> : null}
      <div className="nx-hold-row">
        <button type="submit" className="nx-hold-primary" disabled={saving}>{saving ? "closing…" : "Close holding"}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** The Exit, with its sign said out loud: a sale typed positive for a long reads as a large loss. */
export function ExitField({ value, onChange, served, valuedAt, expired = false, inputRef }: {
  value: string; onChange: (v: string) => void;
  /** the Cost to close the field was prefilled from, as last valued */
  served?: number | null;
  /** when that valuation was made, as the service stamped it: in REVIEW it is the one read made on
   *  entering the mode, and in LIVE the form may have been open a while, so "now" would be untrue */
  valuedAt?: string | null;
  /** past its expiry: the Cost to close is gone, and a worthless expiry is an Exit of 0 */
  expired?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const hint = useId();
  return (
    <label className="nx-hold-field nx-hold-exit">
      <span>exit, per contract</span>
      <input ref={inputRef} aria-label="exit, per contract" aria-describedby={hint} inputMode="decimal" value={value}
             placeholder="unknown" onChange={(e) => onChange(e.target.value)} />
      <small id={hint} className="nx-meta">
        {"signed like the Cost to close: positive when closing cost you, negative when it paid you (a long sold). "}
        {served === undefined ? "" : served === null
          ? "No Cost to close was served, so it starts blank. "
          : `Starts at the Cost to close as last valued${valuedAt ? `, at ${valuedAt}` : ""}. `}
        {expired ? "Expired worthless? type 0. " : ""}
        Blank if you do not know it.
      </small>
    </label>
  );
}

export function DayField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="nx-hold-field">
      <span>closed on</span>
      <input type="date" aria-label="closed on" value={value} onChange={(e) => onChange(e.target.value)} />
      <small className="nx-meta">the New York trading day</small>
    </label>
  );
}

function DeleteAsk({ id, holding, watching, onCancel, onCloseInstead, onDeleted }: {
  id: string; holding: Holding; watching: number; onCancel: () => void; onCloseInstead: () => void;
  onDeleted: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  // the safe answer takes the focus, so Enter on arrival deletes nothing
  useEffect(() => { keep.current?.focus(); }, []);
  const remove = async () => {
    setSaving(true);
    try {
      await deletePosition(holding.id);
      onDeleted();
    } catch (err) {
      setError(message(err));
      setSaving(false);
    }
  };
  return (
    <div id={id} className="nx-hold-form nx-hold-ask" role="group" aria-label={`delete ${holding.name}?`} data-poll="hold">
      <p>
        <strong>{`Delete ${holding.name} for good?`}</strong>
        {" It is for a holding recorded by mistake. Its daily samples are deleted with it — each day's Cost "}
        {"to close, IV, vega and delta — and cannot be re-entered: no later sweep can rebuild them."}
        {watching > 0 ? " Its Monitors are kept: deleting a holding never deletes a rule." : ""}
      </p>
      <p>If this was a real trade, close it instead: closing keeps all of it.</p>
      {error ? <p className="nx-hold-error" role="alert">{error}</p> : null}
      <div className="nx-hold-row">
        <button type="button" className="nx-hold-danger" disabled={saving} onClick={() => void remove()}>
          {saving ? "deleting…" : "Delete for good"}
        </button>
        <button type="button" className="nx-hold-primary" onClick={onCloseInstead}>Close it instead</button>
        <button ref={keep} type="button" onClick={onCancel}>Keep it</button>
      </div>
    </div>
  );
}
