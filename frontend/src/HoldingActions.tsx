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
  closePosition, deletePosition, editPosition, fetchDraftPayoff, fetchMonitors, type Closed, type Corrected,
  type DraftPayoff, type Entry, type Holding, type Monitor, type Payoff,
} from "./shared/api";
import { marketDay } from "./shared/format";
import {
  aboutQuantities, closeBody, closeDay, correctedLegs, correctionWords, editBody, editDraft, exitPrefill,
  fates, followersOf, legWords, type CloseDraft, type EditDraft, type Fate, type Watching,
} from "./holding";
import { MonitorControls } from "./MonitorEdit";
import { ruleOfMonitor } from "./edit";
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
  // what the last save's correction did to the rules, as the service answered it (#359)
  const [account, setAccount] = useState<Corrected | null>(null);
  const buttons = useRef<Record<Exclude<Open, null>, HTMLButtonElement | null>>({ edit: null, close: null, delete: null });
  const id = useId();
  const watching = watchingOf(holding, monitors, rules);

  const toggle = (which: Exclude<Open, null>) => {
    setSaved(false); setAccount(null); setOpen((o) => (o === which ? null : which));
  };
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
      <p className="nx-meta nx-hold-status" role="status">
        {saved ? [`saved ${holding.name}`, ...(account ? correctionWords(account) : [])].join(" · ") : ""}
      </p>
      {saved && account ? <Renames account={account} monitors={monitors} /> : null}
      {open === "edit" ? (
        <EditForm id={`${id}-form`} holding={holding} watching={watching.length} privacy={privacy} now={now}
                  monitors={monitors}
                  onCancel={cancel} onSaved={(answer) => {
                    setOpen(null); setSaved(true); setAccount(answer); buttons.current.edit?.focus();
                    writes.edited(holding);
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

/** After a correction, each rule whose legs took the new quantities, with its editor: its name was
 *  KEPT, and a derived one still spells the old quantities in every Telegram alarm (#359's review),
 *  so renaming it is offered here, where the owner is looking, rather than left to be noticed. */
function Renames({ account, monitors }: { account: Corrected; monitors: Monitor[] }) {
  const rules = account.followed_monitors.flatMap((f) => monitors.filter((m) => m.id === f.id));
  if (rules.length === 0) return null;
  return (
    <div className="nx-hold-renames" role="group" aria-label="rename the rules that followed">
      {rules.map((m) => (
        <div key={m.id}>
          <p className="nx-meta">
            {`Its alarms still call it ${m.code}. If that name spells the old quantities, rename it:`}
          </p>
          <MonitorControls rule={ruleOfMonitor(m)} served={null} />
        </div>
      ))}
    </div>
  );
}

function EditForm({ id, holding, watching, privacy, now, monitors, onCancel, onSaved }: {
  id: string; holding: Holding; watching: number; privacy: boolean; now?: Date; monitors: Monitor[];
  onCancel: () => void; onSaved: (answer: Corrected) => void;
}) {
  const [draft, setDraft] = useState<EditDraft>(() => editDraft(holding));
  // said where it belongs: a quantity's refusal beside the quantities, everything else by the buttons
  const [error, setError] = useState<{ text: string; at: "qty" | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const change = (c: Partial<EditDraft>) => { setDraft((d) => ({ ...d, ...c })); setError(null); };
  const trading = marketDay(now);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const out = editBody(holding, draft);
    if ("error" in out) { setError({ text: out.error, at: "at" in out ? out.at : null }); return; }
    setSaving(true);
    try {
      onSaved(await editPosition(holding.id, out.body));
    } catch (err) {
      // beside the quantities only when it is about them (#359): the holding gone, the network
      // down or Opened refused are said where every other refusal is
      const text = message(err);
      setError({ text, at: out.body.legs && aboutQuantities(text) ? "qty" : null });
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
      <QuantityFields holding={holding} draft={draft} error={error?.at === "qty" ? error.text : null}
                      followers={followersOf(holding, monitors)}
                      onChange={(qty) => change({ qty })} />
      <p className="nx-meta">
        {"The name, the contracts and their sides stay as recorded — the service does not edit them. "}
        {"A wrong name cannot be changed, and the daily samples are worth more than the name: keep it. "}
        {"A quantity typed wrong is corrected above. "}
        {"A wrong strike or side is a different holding: delete it and add it again — which deletes its daily samples "}
        {"for good"}
        {watching > 0
          ? `; its ${watching} Monitor${watching === 1 ? " is" : "s are"} kept, and a holding added with the same contracts takes ${watching === 1 ? "it" : "them"} back.`
          : "."}
      </p>
      {error && error.at === null ? <p className="nx-hold-error" role="alert">{error.text}</p> : null}
      <div className="nx-hold-row">
        <button type="submit" className="nx-hold-primary" disabled={saving}>{saving ? "saving…" : "Save"}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** Each leg's quantity, correctable in place (#359): a 1×3 typed where a 1×2 was meant is the same
 *  holding, and the only other remedy, a delete, takes the daily samples. What the correction
 *  changes is previewed from the service's own payoff, and what it does to the samples and the
 *  rules is said before it is saved. */
function QuantityFields({ holding, draft, error, followers, onChange }: {
  holding: Holding; draft: EditDraft; error: string | null;
  /** the rules the page expects to follow (`followersOf`); the service's answer says what did */
  followers: Monitor[];
  onChange: (qty: string[]) => void;
}) {
  const names = followers.map((m) => m.code).join(", ");
  const legs = correctedLegs(holding, draft);
  return (
    <fieldset className="nx-hold-qty" aria-label="quantity of each leg">
      <legend className="nx-meta">quantity of each leg</legend>
      <div className="nx-hold-row">
        {holding.legs.map((l, i) => (
          <label key={`${l.option_type}${l.strike}`} className="nx-hold-field nx-hold-count">
            <span>{legWords(l)}</span>
            <input aria-label={`quantity, ${legWords(l)}`} inputMode="numeric" autoComplete="off"
                   value={draft.qty[i] ?? ""}
                   onChange={(e) => onChange(draft.qty.map((q, j) => (j === i ? e.target.value : q)))} />
          </label>
        ))}
      </div>
      {error ? <p className="nx-hold-error" role="alert">{error}</p> : null}
      {legs ? (
        <>
          <QuantityChange holding={holding} corrected={legs} />
          <p className="nx-meta">
            {"Its daily samples are kept as they are: each day's Cost to close was summed with the quantities "}
            {"it had then, and its history marks the days before the correction; their IV, vega and delta are "}
            {"one contract's and stay true. "}
            {followers.length > 0
              ? `${names} ${followers.length === 1 ? "values" : "value"} the whole structure, so ${followers.length === 1 ? "it takes" : "they take"} the new quantities and ${followers.length === 1 ? "starts" : "start"} unrung; ${followers.length === 1 ? "its name stays" : "their names stay"} as recorded. `
              : "No rule values this structure as a whole, so no rule's legs change. "}
            {"Any rule on it is given the scope it then has. The Cost to close, P&L and greeks are valued with "}
            {"the new quantities from the next read."}
          </p>
        </>
      ) : null}
    </fieldset>
  );
}

const points = (p: number | null, none: string) =>
  p === null ? none : `${p > 0 ? "+" : ""}${p.toFixed(2)} pts`;

/** The payoff at expiry per contract, as recorded and as corrected, both the service's (`POST
 *  /positions/payoff`: no Provider, nothing written): what a quantity changes is its maximums and
 *  what each point of SPX beyond the strikes is worth. Asked for a moment after the typing stops. */
function QuantityChange({ holding, corrected }: { holding: Holding; corrected: Holding["legs"] }) {
  const key = JSON.stringify(corrected);
  const [shown, setShown] = useState<{ key: string; before: Payoff; after: Payoff } | { key: string; error: string } | null>(null);
  const { legs, entry } = holding;
  // by VALUE: a poll serves the holding anew, with legs equal to the last ones but not the same
  // array, and asking the payoff route again on every poll is a POST per poll for nothing
  const recorded = JSON.stringify(legs);
  useEffect(() => {
    if (entry === null) return;
    let live = true;
    const ask = setTimeout(() => {
      // the service's own legs, whose option_type it serves as text: CALL or PUT, as it stored them
      const draft = (l: string) =>
        fetchDraftPayoff({ legs: JSON.parse(l) as DraftPayoff["legs"], entry, contracts: 1 });
      Promise.all([draft(recorded), draft(key)]).then(
        ([before, after]) => { if (live) setShown({ key, before, after }); },
        (err: unknown) => { if (live) setShown({ key, error: message(err) }); },
      );
    }, 200);
    return () => { live = false; clearTimeout(ask); };
  }, [key, recorded, entry]);

  const strikes = legs.map((l) => l.strike);
  const [lo, hi] = [Math.min(...strikes), Math.max(...strikes)];
  const body = entry === null ? <p className="nx-meta">no Entry recorded, so there is no payoff to compare</p>
    : shown === null ? <p className="nx-meta">comparing…</p>
      : "error" in shown ? <p className="nx-meta">{`the payoff could not be compared — ${shown.error}`}</p>
        : (
          <dl className="nx-payoff-kv" data-updating={shown.key !== key ? "" : undefined}>
            {([
              ["max profit", (p: Payoff) => points(p.max_profit, "no ceiling")],
              ["max loss", (p: Payoff) => points(p.max_loss, "no floor")],
              [`per point below ${lo}`, (p: Payoff) => points(p.slope_below, "")],
              [`per point above ${hi}`, (p: Payoff) => points(p.slope_above, "")],
            ] as const).map(([label, say]) => (
              <div key={label}><dt>{label}</dt><dd>{`${say(shown.before)} → ${say(shown.after)}`}</dd></div>
            ))}
          </dl>
        );
  return (
    <section role="group" aria-label="what the correction changes" className="nx-hold-change">
      <p className="nx-meta">at expiry, per contract, as recorded → as corrected</p>
      {body}
    </section>
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
  /** when that valuation was made, as the service stamped it: outside the session it is the one
   *  read made on opening or at the session's edge, and in session the form may have been open a
   *  while, so "now" would be untrue */
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

/** The question a delete asks first, of a held holding here and of a closed one in the closed trades
 *  (#296, ADR 0022: the closed list carries both remedies). A closed one has no "close it instead":
 *  it is closed, and what keeps its record is not deleting it. */
export function DeleteAsk({ id, holding, watching, onCancel, onCloseInstead, onDeleted }: {
  id: string; holding: Pick<Holding, "id" | "name">; watching: number; onCancel: () => void;
  /** absent for a closed holding */
  onCloseInstead?: () => void;
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
      <p>
        {onCloseInstead
          ? "If this was a real trade, close it instead: closing keeps all of it."
          : "If this was a real trade, keep it: its record is what the closed trades show, and a mistyped close is corrected above."}
      </p>
      {error ? <p className="nx-hold-error" role="alert">{error}</p> : null}
      <div className="nx-hold-row">
        <button type="button" className="nx-hold-danger" disabled={saving} onClick={() => void remove()}>
          {saving ? "deleting…" : "Delete for good"}
        </button>
        {onCloseInstead
          ? <button type="button" className="nx-hold-primary" onClick={onCloseInstead}>Close it instead</button> : null}
        <button ref={keep} type="button" onClick={onCancel}>Keep it</button>
      </div>
    </div>
  );
}
