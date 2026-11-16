/** Adding a spread in one step, with its Monitors and a payoff preview (#293, ADR 0023): a panel
 *  on the desk, and the phone's Add tab opening it as a bottom sheet. The same form in both, so
 *  either can do what the other can (ADR 0023's parity).
 *
 *  What a save posts is `add.ts`'s; this draws the draft and says what went wrong. A refusal — the
 *  draft's own, or the service's — is said INSIDE the form, by the button that was pressed: the old
 *  form's toast was drawn underneath it, and a refused form looked like nothing had happened.
 *
 *  The same place adds ONE contract (#331): a choice above the form, and `AddContract.tsx` in the
 *  spread form's stead. Each draft is kept here, so switching back and forth loses neither.
 *
 *  "Record as held" (#408) opens it with a draft already made from a watch rule (`initial`): the
 *  spread or the contract as "I hold it", where the owner types Opened, the Entry and the count —
 *  so the focus goes to the Entry rather than the expiry, which is already there.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Plus, X } from "lucide-react";

import { addSpreads, type Added, type Monitor, type Payoff } from "./shared/api";
import { Button } from "@/components/ui/button";
import { marketDay } from "./shared/format";
import { SideSign } from "./shared/Legs";
import {
  ALL_OR_NONE, addLeg, addSpread, deltaEnabled, isCreditStop, derivedName, deltaShown, flipSide, MAX_LEGS, MIN_LEGS, newDraft, previewOf,
  removeLeg, removeSpread, replaces, saveWords, setLeg, setSpread, spreadsBody, stopWarning, takenOver, valueChange,
  valueChoosable, valueDirectionChange, valueDirectionShown, valueEnabled, valueHint, valueShown,
  type AddDraft, type HeldLegs, type Preset, type SpreadDraft,
} from "./add";
import { TakeOver } from "./TakeOver";
import { AddContract } from "./AddContract";
import { HoldOrWatch } from "./HoldOrWatch";
import { newContract, type ContractDraft } from "./contract";

/** A draft the form opens with instead of a fresh one: "Record as held" from a watch rule (#408). */
export type AddInitial =
  /** `taken`: every holding's name on record, closed ones too, which this spread's may not be */
  | { kind: "spread"; draft: AddDraft; taken: string[] }
  | { kind: "contract"; draft: ContractDraft };
import { DraftPreview } from "./Payoff";
import { DirectionPair, type Direction } from "./DirectionPair";
import { fieldWords } from "./needs";
import "./add.css";
import { plainError } from "./shared/errors";

type Props = {
  privacy: boolean;
  /** every rule, as `/monitors` gave them: what a held spread will replace is read from these */
  monitors: Monitor[];
  /** the open holdings, as valued, or null where they are not: what a held save takes over besides
   *  what it replaces is read against them (#408) */
  holdings: HeldLegs[] | null;
  /** SPX's derived price from the book's last batch, for the preview's marker, or null */
  spx: number | null;
  spxReason: string | null;
  onSaved: (added: Added) => void;
  onCancel: () => void;
  /** take the focus on opening: the desk's panel does; the phone's sheet moves it itself */
  autoFocus?: boolean;
  /** injected only by tests: Opened starts as the New York trading day on this clock */
  now?: Date;
  /** a draft to open with, prefilled from a watch rule (#408) */
  initial?: AddInitial;
  /** the id the footer carries, which describes the sheet it is drawn in (2026-11-16) */
  footerId?: string;
};

/** What to add — a spread, or one contract — and the form for it. */
export function AddSpread(props: Props) {
  const [kind, setKind] = useState<"spread" | "contract">(props.initial?.kind ?? "spread");
  // the focus goes into the form when it opens, and stays on the choice when the choice is changed
  const [chosen, setChosen] = useState(false);
  const choose = (k: "spread" | "contract") => { setKind(k); setChosen(true); };
  const [spread, setSpreadDraft] = useState<AddDraft>(
    () => (props.initial?.kind === "spread" ? props.initial.draft : newDraft(marketDay(props.now))));
  const [contract, setContract] = useState<ContractDraft>(
    () => (props.initial?.kind === "contract" ? props.initial.draft : newContract(marketDay(props.now))));
  const prefilled = props.initial !== undefined;
  // one save in flight for the whole place, not per form: switching form mid-save would otherwise
  // mount a fresh save button that sends the same thing again (review of #340)
  const [saving, setSaving] = useState(false);
  return (
    <div className="nx-add-what">
      <div className="nx-seg" role="group" aria-label="what to add">
        <button type="button" aria-pressed={kind === "spread"} disabled={saving} onClick={() => choose("spread")}>a spread</button>
        <button type="button" aria-pressed={kind === "contract"} disabled={saving} onClick={() => choose("contract")}>one contract</button>
      </div>
      {kind === "spread"
        ? <SpreadForm {...props} autoFocus={props.autoFocus && !chosen} draft={spread} setDraft={setSpreadDraft}
                      saving={saving} setSaving={setSaving} prefilled={prefilled} />
        : <AddContract privacy={props.privacy} monitors={props.monitors} holdings={props.holdings} spx={props.spx} spxReason={props.spxReason}
                       onSaved={props.onSaved} onCancel={props.onCancel} today={marketDay(props.now)} footerId={props.footerId}
                       autoFocus={props.autoFocus && !chosen} prefilled={prefilled}
                       draft={contract} setDraft={setContract} saving={saving} setSaving={setSaving} />}
    </div>
  );
}

function SpreadForm({
  privacy, monitors, holdings, spx, spxReason, onSaved, onCancel, autoFocus, draft, setDraft, saving, setSaving, prefilled,
  initial, footerId,
}: Props & {
  draft: AddDraft; setDraft: (d: AddDraft) => void; saving: boolean; setSaving: (s: boolean) => void;
  /** opened from a watch rule: the focus goes to the Entry, the expiry being there already */
  prefilled: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const change = (next: AddDraft) => { setDraft(next); setError(null); };
  const expiry = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    if (prefilled) form.current?.querySelector<HTMLInputElement>('input[aria-label="spread 1 entry"]')?.focus();
    else expiry.current?.focus();
    // on opening only
  }, [autoFocus]);
  const replacing = replaces(draft, monitors);
  const taking = takenOver(draft, monitors, holdings);
  const taken = initial?.kind === "spread" ? initial.taken : [];

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const out = spreadsBody(draft);
    if ("error" in out) { setError(out.error); return; }
    if (saving) return;
    setSaving(true);
    try {
      onSaved(await addSpreads(out.body));
    } catch (err: unknown) {
      setError(plainError(err));
    } finally {
      setSaving(false);
    }
  };

  const held = draft.held;
  return (
    <form ref={form} className="nx-add" aria-label="add a spread" onSubmit={(e) => void save(e)} data-poll="hold" noValidate>
      <div className="nx-add-row">
        <HoldOrWatch held={held} onHeld={(h) => change({ ...draft, held: h })} />
      </div>
      <div className="nx-add-row">
        <label className="nx-add-field">
          <span>expiry</span>
          <input ref={expiry} type="date" aria-label="expiry" value={draft.expiry}
                 onChange={(e) => change({ ...draft, expiry: e.target.value })} />
        </label>
        {held ? (
          <label className="nx-add-field">
            <span>opened</span>
            <input type="date" aria-label="opened" value={draft.opened}
                   onChange={(e) => change({ ...draft, opened: e.target.value })} />
            <small className="nx-meta">the New York trading day</small>
          </label>
        ) : null}
      </div>

      {draft.spreads.map((s, i) => (
        <SpreadFields key={s.key} index={i} spread={s} draft={draft} privacy={privacy} id={id}
                      replacing={replacing[i] ?? []} taking={taking === null ? null : taking[i] ?? []} taken={taken}
                      spx={spx} spxReason={spxReason} onChange={change}
                      onRemove={draft.spreads.length > 1 ? () => change(removeSpread(draft, s.key)) : null} />
      ))}

      <div className="nx-add-row nx-add-more" role="group" aria-label="add another">
        {(["put", "call", "condor"] as Preset[]).map((p) => (
          <button key={p} type="button" className="nx-add-ghost" onClick={() => change(addSpread(draft, p))}>
            <Plus aria-hidden="true" />{PRESET_WORDS[p]}
          </button>
        ))}
      </div>

      {error ? <p className="nx-add-error" role="alert">{error}</p> : null}
      <div className="nx-add-row nx-add-actions">
        <Button type="submit" disabled={saving}>{saving ? "saving…" : saveWords(draft)}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
      <p id={footerId} className="nx-meta">{ALL_OR_NONE}</p>
    </form>
  );
}

const PRESET_WORDS: Record<Preset, string> = {
  put: "put spread", call: "call spread", condor: "condor as one holding",
};

function SpreadFields({ index, spread: s, draft, privacy, id, replacing, taking, taken, spx, spxReason, onChange, onRemove }: {
  index: number; spread: SpreadDraft; draft: AddDraft; privacy: boolean; id: string;
  /** the watch rules saving this spread will replace, in words */
  replacing: string[];
  /** the rules its holding will take over besides, or null where the holdings are not read (#408) */
  taking: Monitor[] | null;
  /** the holdings' names on record, closed ones too, where the page read them for this draft */
  taken: string[];
  spx: number | null; spxReason: string | null;
  onChange: (d: AddDraft) => void; onRemove: (() => void) | null;
}) {
  const n = index + 1;
  const held = draft.held;
  const name = s.name.trim() || derivedName(draft.expiry, s.legs);
  const set = (change: Partial<SpreadDraft>) => onChange(setSpread(draft, s.key, change));
  const preview = previewOf(draft, s);
  const credit = preview?.entry ?? 0;
  // the payoff the preview was served, which the stop's warning reads its ceiling from
  const [drawn, setDrawn] = useState<{ key: string; payoff: Payoff } | null>(null);
  const warning = stopWarning(draft, s, drawn);
  const valueOn = valueEnabled(held, s);
  const deltaOn = deltaEnabled(s);
  const shorts = s.legs.filter((l) => l.side === "short").length;
  const addLegButton = useRef<HTMLButtonElement>(null);
  const [focusAdd, setFocusAdd] = useState(false);
  useEffect(() => {
    if (!focusAdd) return;
    addLegButton.current?.focus();
    setFocusAdd(false);
  }, [focusAdd]);
  return (
    <fieldset className="nx-add-spread" data-spread={n}>
      <legend>{`spread ${n}`}</legend>
      <div className="nx-add-split">
        <div className="nx-add-fields">
          <label className="nx-add-field nx-add-name">
            <span>name</span>
            <input aria-label={`spread ${n} name`} value={s.name} placeholder={derivedName(draft.expiry, s.legs)}
                   onChange={(e) => set({ name: e.target.value })} />
          </label>
          <ol className="nx-add-legs">
            {s.legs.map((l, j) => (
              <li key={l.key} className="nx-add-leg" data-side={l.side}>
                {/* − and +, the book's own notation for a leg (−P6800 +P6750), the word to a pointer and a
                    reader (2026-11-16) */}
                <button type="button" className="nx-add-toggle nx-add-side" data-side={l.side} title={l.side}
                        aria-label={`spread ${n}, leg ${j + 1} side: ${l.side} — flip`}
                        onClick={() => onChange(flipSide(draft, s.key, j))}><SideSign side={l.side} /></button>
                {/* how many of the contract, "1" until changed: a butterfly's middle, a ratio's 2 (#351) */}
                <input aria-label={`spread ${n}, leg ${j + 1} quantity`} className="nx-add-qty" inputMode="numeric"
                       value={l.qty} autoComplete="off"
                       onChange={(e) => onChange(setLeg(draft, s.key, j, { qty: e.target.value }))} />
                <button type="button" className="nx-add-toggle" data-type={l.option_type}
                        aria-label={`spread ${n}, leg ${j + 1} type: ${l.option_type} — change`}
                        onClick={() => onChange(setLeg(draft, s.key, j, { option_type: l.option_type === "PUT" ? "CALL" : "PUT" }))}>
                  {l.option_type}
                </button>
                <input aria-label={`spread ${n}, leg ${j + 1} strike`} inputMode="decimal" value={l.strike}
                       placeholder="strike" onChange={(e) => onChange(setLeg(draft, s.key, j, { strike: e.target.value }))} />
                {s.legs.length > MIN_LEGS ? (
                  <button type="button" className="nx-add-toggle nx-add-unleg" aria-label={`remove spread ${n}, leg ${j + 1}`}
                          onClick={(e) => {
                            // the button that had the focus goes with its leg: + leg takes it
                            if (e.currentTarget === document.activeElement) setFocusAdd(true);
                            onChange(removeLeg(draft, s.key, j));
                          }}>
                    <X aria-hidden="true" />
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
          {s.legs.length < MAX_LEGS ? (
            <button ref={addLegButton} type="button" className="nx-add-ghost" aria-label={`spread ${n}: add a leg`}
                    onClick={() => onChange(addLeg(draft, s.key))}>
              <Plus aria-hidden="true" />leg
            </button>
          ) : null}
          {held ? (
            <div className="nx-add-row">
              <label className="nx-add-field">
                <span>entry, per contract</span>
                <input aria-label={`spread ${n} entry`} inputMode="decimal" value={s.entry} placeholder="credit +, debit −"
                       onChange={(e) => set({ entry: e.target.value })} />
              </label>
              <label className="nx-add-field nx-add-count">
                <span>contracts</span>
                {/* the count is hidden under privacy, as the dollars it multiplies are (ADR 0023) */}
                <input aria-label={`spread ${n} contracts`} inputMode="numeric" value={s.contracts}
                       className={privacy ? "nx-private" : undefined} data-private={privacy ? "" : undefined}
                       autoComplete="off" onChange={(e) => set({ contracts: e.target.value })} />
              </label>
            </div>
          ) : null}
          <div className="nx-add-monitors" role="group" aria-label={`spread ${n}'s rules`}>
            {/* a held credit's stop is the cost to close at or above its figure, and offers no
                choice; anything else is its value's size, at or above or at or below (#405) */}
            <MonitorLine on={valueOn} onToggle={() => set({ valueOn: !valueOn })} label={`spread ${n} value rule`}
                         words={isCreditStop(held, s) ? "cost to close ≥" : `|${fieldWords("mid_price")}|`}
                         direction={valueChoosable(held, s)
                           ? { value: valueDirectionShown(held, s), onChange: (d) => set(valueDirectionChange(held, d)), label: `spread ${n} value direction` }
                           : null}
                         hint={valueHint(held, s)}
                         value={valueShown(held, s)} onValue={(v) => set(valueChange(held, v))}
                         inputLabel={`spread ${n} value threshold`} />
            <MonitorLine on={deltaOn} onToggle={() => set({ deltaOn: !deltaOn })} label={`spread ${n} delta rule`}
                         words={`short leg${shorts === 1 ? "'s" : "s'"} |Δ|`}
                         direction={{ value: s.deltaDirection, onChange: (d) => set({ deltaDirection: d }), label: `spread ${n} delta direction` }}
                         // nothing under a watched one's: "Watch it" says its rules are entry signals
                         hint={shorts === 0 ? "no short leg to watch" : !held ? ""
                           // a held short leg's delta falling is the spread gone cheap to close, not a risk
                           : s.deltaDirection === "below" ? "close-cheap signal" : "risk"}
                         value={deltaShown(held, s)} onValue={(v) => set({ deltaAt: v })}
                         inputLabel={`spread ${n} delta threshold`} />
          </div>
          {warning ? <p className="nx-add-warn" role="status" aria-label={`spread ${n}'s stop`}>{warning}</p> : null}
          {held && taken.includes(name) ? (
            <p className="nx-add-warn" role="status" aria-label={`spread ${n}'s name`}>
              {`A holding named ${name} is already on record, closed ones included, so saving under this name is refused. `
                + "Rename it in the name box"
                + (replacing.some((w) => w.startsWith(`${name} `))
                  ? `: the watch rule ${name} is then kept, linked to the new holding, rather than replaced.` : ".")}
            </p>
          ) : null}
          <TakeOver held={held} replacing={replacing} taking={taking} />
          {onRemove ? (
            <button type="button" className="nx-add-ghost" aria-label={`remove spread ${n}`} onClick={onRemove}>
              <X aria-hidden="true" />remove
            </button>
          ) : null}
        </div>
        <DraftPreview subject={`${id}-${s.key}`} draft={preview} spx={spx} spxReason={spxReason} onDrawn={setDrawn}
                      blank="type the strikes"
                      note={`per contract, at ${Math.abs(credit).toFixed(2)} ${credit < 0 ? "debit" : "credit"}${held ? "" : ": the value it watches for"}`} />
      </div>
    </fieldset>
  );
}

function MonitorLine({ on, onToggle, label, words, direction, hint, value, onValue, inputLabel }: {
  on: boolean; onToggle: () => void; label: string; words: string;
  /** the ≥ / ≤ pair beside the threshold, or null where the direction is fixed and in `words` */
  direction: { value: Direction; onChange: (d: Direction) => void; label: string } | null;
  hint: string;
  value: string; onValue: (v: string) => void; inputLabel: string;
}) {
  return (
    <div className="nx-add-monitor" data-on={on ? "" : undefined}>
      <button type="button" role="switch" aria-checked={on} aria-label={label} className="nx-add-switch"
              onClick={onToggle}>{on ? "on" : "off"}</button>
      <span>{words}</span>
      {direction ? <DirectionPair aria-label={direction.label} value={direction.value} disabled={!on}
                                  onChange={direction.onChange} /> : null}
      <input aria-label={inputLabel} inputMode="decimal" value={value} disabled={!on}
             onChange={(e) => onValue(e.target.value)} />
      {hint ? <small className="nx-meta">{hint}</small> : null}
    </div>
  );
}
